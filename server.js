import cors from 'cors';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import pg from 'pg';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Colunas DATE chegam como texto 'YYYY-MM-DD', sem conversão para Date no fuso local.
pg.types.setTypeParser(pg.types.builtins.DATE, (value) => value);

export const app = express();
const port = process.env.PORT || 3000;

const slotIntervalMinutes = 30;
const businessTimeZone = 'America/Sao_Paulo';
// Chaves usadas em barbers.days e barbers.hours, na ordem de Date.getUTCDay().
const weekdayKeys = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

pool.on('error', (error) => {
  console.error('Erro inesperado na conexão com o banco de dados:', error);
});

export const databaseReady = process.env.DATABASE_URL
  ? pool.query('SELECT 1')
  : Promise.reject(new Error('Defina DATABASE_URL no arquivo backend/.env.'));
databaseReady.catch(() => {});

// Atrás de um proxy (Render, Railway, Nginx...), informe em TRUST_PROXY quantos proxies há na frente
// para o rate limit enxergar o IP real do cliente em vez do IP do proxy.
const trustProxy = Number(process.env.TRUST_PROXY);
if (Number.isInteger(trustProxy) && trustProxy > 0) app.set('trust proxy', trustProxy);

// Origens liberadas no CORS, separadas por vírgula. Sem FRONTEND_URL, nenhum site externo é aceito.
const allowedOrigins = (process.env.FRONTEND_URL || '')
  .split(',')
  .map((origin) => origin.trim().replace(/\/+$/, ''))
  .filter(Boolean);
if (!allowedOrigins.length) {
  console.warn('FRONTEND_URL não definida: o CORS vai bloquear requisições de qualquer site.');
}

app.use(cors({ origin: allowedOrigins }));
app.use(express.json({ limit: '16kb' }));

const appointmentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Muitas tentativas de agendamento. Aguarde alguns minutos e tente novamente.' }
});

function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;

  const parsedDate = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsedDate.getTime()) &&
    parsedDate.toISOString().slice(0, 10) === value;
}

function timeToMinutes(value) {
  const match = typeof value === 'string' ? /^([01]\d|2[0-3]):([0-5]\d)(?::\d{2})?$/.exec(value) : null;
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function minutesToTime(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function getBusinessDateTime(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: businessTimeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));

  return {
    date: `${values.year}-${values.month}-${values.day}`,
    minutes: Number(values.hour) * 60 + Number(values.minute)
  };
}

function toService(row) {
  return {
    id: String(row.id),
    nome: row.name,
    preco: Number(String(row.value).replace(',', '.')),
    duracaoMinutos: timeToMinutes(row.time_during)
  };
}

async function listServices() {
  const { rows } = await pool.query(
    `SELECT id, name, time_during, value
     FROM services
     ORDER BY id`
  );
  return rows.map(toService);
}

async function getService(id) {
  if (typeof id !== 'string' || !/^\d{1,18}$/.test(id)) return null;

  const { rows } = await pool.query(
    `SELECT id, name, time_during, value
     FROM services
     WHERE id = $1`,
    [id]
  );
  return rows[0] ? toService(rows[0]) : null;
}

// Sem serviço, lista todos os barbeiros (usado pelo front de gestão de folgas).
async function listBarbersForService(serviceName) {
  const { rows } = serviceName
    ? await pool.query(
      `SELECT DISTINCT b.name, b.days
       FROM barbers b
       JOIN barber_service bs ON bs.barber = b.name
       WHERE bs.service = $1
       ORDER BY b.name`,
      [serviceName]
    )
    : await pool.query('SELECT name, days FROM barbers ORDER BY name');
  return rows.map((row) => ({
    nome: row.name,
    dias: Array.isArray(row.days) ? row.days.filter((day) => weekdayKeys.includes(day)) : []
  }));
}

async function getBarberForService(barberName, serviceName) {
  const { rows } = await pool.query(
    `SELECT b.name, b.days, b.hours
     FROM barbers b
     JOIN barber_service bs ON bs.barber = b.name
     WHERE b.name = $1 AND bs.service = $2
     LIMIT 1`,
    [barberName, serviceName]
  );
  return rows[0] || null;
}

// excludeId ignora um agendamento na conta (usado ao editar, para ele não colidir consigo mesmo).
async function listBarberAppointmentsForDate(barberName, date, client = pool, excludeId = null) {
  const { rows } = await client.query(
    `SELECT a.hour, s.time_during
     FROM appointments a
     JOIN services s ON s.name = a.service
     WHERE a.barber = $1 AND a.date = $2 AND ($3::bigint IS NULL OR a.id <> $3)`,
    [barberName, date, excludeId]
  );
  return rows;
}

// Folgas que tocam a data, recortadas para minutos dentro daquele dia (0 a 1440).
async function listBarberTimeOffForDate(barberName, date, client = pool) {
  const { rows } = await client.query(
    `SELECT extract(epoch FROM greatest(starts_at, $2::date::timestamp) - $2::date::timestamp) / 60 AS start_minutes,
            extract(epoch FROM least(ends_at, ($2::date + 1)::timestamp) - $2::date::timestamp) / 60 AS end_minutes
     FROM barber_time_off
     WHERE barber = $1 AND starts_at < ($2::date + 1)::timestamp AND ends_at > $2::date::timestamp`,
    [barberName, date]
  );
  return rows.map((row) => ({ start: Number(row.start_minutes), end: Number(row.end_minutes) }));
}

// Formato esperado em barbers:
//   days:  ["seg", "ter", ...]
//   hours: { "seg": [{ "inicio": "09:00", "fim": "12:00" }, { "inicio": "13:00", "fim": "21:00" }], ... }
// O intervalo entre dois períodos do mesmo dia é a pausa do barbeiro.
function getWorkingPeriods(barber, date) {
  const dayKey = weekdayKeys[new Date(`${date}T12:00:00.000Z`).getUTCDay()];
  if (!Array.isArray(barber.days) || !barber.days.includes(dayKey)) return [];

  const periods = barber.hours?.[dayKey];
  if (!Array.isArray(periods)) return [];

  return periods
    .map((period) => ({ start: timeToMinutes(period?.inicio), end: timeToMinutes(period?.fim) }))
    .filter(({ start, end }) => start !== null && end !== null && start < end);
}

// Grade do dia: todos os inícios em que o serviço cabe no expediente do barbeiro,
// marcando como indisponíveis os que já passaram, colidem com outro agendamento ou caem numa folga.
function getTimeSlots(date, service, barber, appointments, timeOff = [], businessDateTime = getBusinessDateTime()) {
  if (date < businessDateTime.date) return [];

  const busyPeriods = appointments
    .map((appointment) => {
      const start = timeToMinutes(appointment.hour);
      const duration = timeToMinutes(appointment.time_during);
      return start === null ? null : { start, end: start + (duration || slotIntervalMinutes) };
    })
    .filter(Boolean)
    .concat(timeOff);
  const slots = new Map();

  for (const period of getWorkingPeriods(barber, date)) {
    for (let start = period.start; start + service.duracaoMinutos <= period.end; start += slotIntervalMinutes) {
      const end = start + service.duracaoMinutos;
      const isPast = date === businessDateTime.date && start <= businessDateTime.minutes;
      const isBusy = busyPeriods.some((busy) => start < busy.end && busy.start < end);
      const time = minutesToTime(start);

      slots.set(time, (slots.get(time) || !(isPast || isBusy)));
    }
  }

  return [...slots.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([hora, disponivel]) => ({ hora, disponivel }));
}

function getAvailableTimes(date, service, barber, appointments, timeOff = [], businessDateTime = getBusinessDateTime()) {
  return getTimeSlots(date, service, barber, appointments, timeOff, businessDateTime)
    .filter((slot) => slot.disponivel)
    .map((slot) => slot.hora);
}

function validateAppointment(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return 'Envie os dados do agendamento em formato JSON.';
  }

  const fields = [
    ['nome', 120],
    ['telefone', 40],
    ['servico', 20],
    ['barbeiro', 120],
    ['data', 10],
    ['hora', 5]
  ];

  for (const [field, maxLength] of fields) {
    if (typeof body[field] !== 'string' || !body[field].trim()) {
      return `O campo "${field}" é obrigatório e deve ser um texto.`;
    }

    if (body[field].trim().length > maxLength) {
      return `O campo "${field}" excede o tamanho máximo permitido.`;
    }
  }

  if (!isValidDate(body.data.trim())) {
    return 'O campo "data" deve usar o formato YYYY-MM-DD e conter uma data válida.';
  }

  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(body.hora.trim())) {
    return 'O campo "hora" deve usar o formato HH:MM.';
  }

  return null;
}

// Cria o agendamento numa transação com lock por barbeiro e data, para que dois
// pedidos simultâneos não reservem o mesmo horário (vale também com várias instâncias).
async function insertAppointmentIfAvailable(appointment, service, barber) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${barber.name}|${appointment.data}`]);

    const appointments = await listBarberAppointmentsForDate(barber.name, appointment.data, client);
    const timeOff = await listBarberTimeOffForDate(barber.name, appointment.data, client);
    if (!getAvailableTimes(appointment.data, service, barber, appointments, timeOff).includes(appointment.hora)) {
      await client.query('ROLLBACK');
      return null;
    }

    const { rows } = await client.query(
      `INSERT INTO appointments (name, phone, barber, service, date, hour)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [appointment.nome, appointment.telefone, barber.name, service.nome, appointment.data, appointment.hora]
    );
    await client.query('COMMIT');
    return String(rows[0].id);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

const appointmentColumns = `id, name, phone, barber, service, date, to_char(hour, 'HH24:MI') AS hour`;

function toAppointment(row) {
  return {
    id: String(row.id),
    nome: row.name,
    telefone: row.phone,
    barbeiro: row.barber,
    servico: row.service,
    data: row.date,
    hora: row.hour
  };
}

async function getServiceByName(name) {
  const { rows } = await pool.query(
    `SELECT id, name, time_during, value
     FROM services
     WHERE name = $1`,
    [name]
  );
  return rows[0] ? toService(rows[0]) : null;
}

// Na edição todos os campos são opcionais, mas os enviados seguem as mesmas regras da criação.
function validateAppointmentChanges(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return 'Envie os dados do agendamento em formato JSON.';
  }

  const fields = [
    ['nome', 120],
    ['telefone', 40],
    ['servico', 20],
    ['barbeiro', 120],
    ['data', 10],
    ['hora', 5]
  ];
  const sentFields = fields.filter(([field]) => body[field] !== undefined);

  if (!sentFields.length) {
    return 'Envie ao menos um campo para alterar: nome, telefone, servico, barbeiro, data ou hora.';
  }

  for (const [field, maxLength] of sentFields) {
    if (typeof body[field] !== 'string' || !body[field].trim()) {
      return `O campo "${field}" deve ser um texto não vazio.`;
    }

    if (body[field].trim().length > maxLength) {
      return `O campo "${field}" excede o tamanho máximo permitido.`;
    }
  }

  if (body.data !== undefined && !isValidDate(body.data.trim())) {
    return 'O campo "data" deve usar o formato YYYY-MM-DD e conter uma data válida.';
  }

  if (body.hora !== undefined && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(body.hora.trim())) {
    return 'O campo "hora" deve usar o formato HH:MM.';
  }

  return null;
}

// Atualiza o agendamento. Se serviço, barbeiro, data ou hora mudarem, confere a disponibilidade
// no novo horário com os locks do dia antigo e do novo (em ordem fixa, para evitar deadlock).
async function updateAppointment(id, current, changes, service, barber) {
  const reschedules = barber.name !== current.barber || service.nome !== current.service ||
    changes.data !== current.date || changes.hora !== current.hour;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (reschedules) {
      const lockKeys = [...new Set([`${current.barber}|${current.date}`, `${barber.name}|${changes.data}`])].sort();
      for (const key of lockKeys) {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
      }

      const appointments = await listBarberAppointmentsForDate(barber.name, changes.data, client, id);
      const timeOff = await listBarberTimeOffForDate(barber.name, changes.data, client);
      if (!getAvailableTimes(changes.data, service, barber, appointments, timeOff).includes(changes.hora)) {
        await client.query('ROLLBACK');
        return { unavailable: true };
      }
    }

    const { rows } = await client.query(
      `UPDATE appointments
       SET name = $2, phone = $3, barber = $4, service = $5, date = $6, hour = $7
       WHERE id = $1
       RETURNING ${appointmentColumns}`,
      [id, changes.nome, changes.telefone, barber.name, service.nome, changes.data, changes.hora]
    );
    await client.query('COMMIT');
    return rows[0] ? { appointment: toAppointment(rows[0]) } : { notFound: true };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

const maxTimeOffDays = 366;

function addDays(date, days) {
  const parsedDate = new Date(`${date}T00:00:00.000Z`);
  parsedDate.setUTCDate(parsedDate.getUTCDate() + days);
  return parsedDate.toISOString().slice(0, 10);
}

// Aceita 'YYYY-MM-DD', 'YYYY-MM-DDTHH:MM' ou 'YYYY-MM-DD HH:MM' e devolve 'YYYY-MM-DD HH:MM'.
// Só com a data, o início vira 00:00 do dia e o fim vira 00:00 do dia seguinte (folga até o fim do dia).
function parseTimeOffBoundary(value, isEnd) {
  const match = typeof value === 'string' ? /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?$/.exec(value.trim()) : null;
  if (!match || !isValidDate(match[1])) return null;
  if (match[2]) return timeToMinutes(match[2]) === null ? null : `${match[1]} ${match[2]}`;
  return `${isEnd ? addDays(match[1], 1) : match[1]} 00:00`;
}

function validateTimeOff(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Envie os dados da folga em formato JSON.' };
  }

  if (typeof body.barbeiro !== 'string' || !body.barbeiro.trim() || body.barbeiro.trim().length > 120) {
    return { error: 'O campo "barbeiro" é obrigatório e deve ser um texto de até 120 caracteres.' };
  }

  if (body.motivo !== undefined && body.motivo !== null &&
    (typeof body.motivo !== 'string' || body.motivo.trim().length > 200)) {
    return { error: 'O campo "motivo" deve ser um texto de até 200 caracteres.' };
  }

  const start = parseTimeOffBoundary(body.inicio, false);
  const end = parseTimeOffBoundary(body.fim, true);
  if (!start || !end) {
    return { error: 'Os campos "inicio" e "fim" devem usar o formato YYYY-MM-DD ou YYYY-MM-DDTHH:MM.' };
  }

  if (end <= start) {
    return { error: 'O fim da folga deve ser depois do início.' };
  }

  if (end.slice(0, 10) > addDays(start.slice(0, 10), maxTimeOffDays)) {
    return { error: `Uma folga pode durar no máximo ${maxTimeOffDays} dias.` };
  }

  return {
    timeOff: {
      barbeiro: body.barbeiro.trim(),
      inicio: start,
      fim: end,
      motivo: typeof body.motivo === 'string' && body.motivo.trim() ? body.motivo.trim() : null
    }
  };
}

function toTimeOff(row) {
  return {
    id: String(row.id),
    barbeiro: row.barber,
    inicio: row.starts_at,
    fim: row.ends_at,
    motivo: row.reason
  };
}

const timeOffColumns = `id, barber,
  to_char(starts_at, 'YYYY-MM-DD"T"HH24:MI') AS starts_at,
  to_char(ends_at, 'YYYY-MM-DD"T"HH24:MI') AS ends_at,
  reason`;

async function listTimeOff({ barber, from, to }) {
  const { rows } = await pool.query(
    `SELECT ${timeOffColumns}
     FROM barber_time_off
     WHERE ($1::text IS NULL OR barber = $1)
       AND ($2::date IS NULL OR ends_at > $2::date::timestamp)
       AND ($3::date IS NULL OR starts_at < ($3::date + 1)::timestamp)
     ORDER BY starts_at ASC, id ASC`,
    [barber || null, from || null, to || null]
  );
  return rows.map(toTimeOff);
}

function getTimeOffLockKeys(barber, start, end) {
  const keys = [];
  for (let date = start.slice(0, 10); date <= end.slice(0, 10); date = addDays(date, 1)) {
    keys.push(`${barber}|${date}`);
  }
  return keys;
}

// Cria a folga (ou atualiza, quando recebe a folga atual em `existing`) se não houver agendamento
// no período. Usa os mesmos locks por barbeiro e data do agendamento, para que nenhum cliente
// consiga reservar no meio da verificação; na edição, trava também os dias do período antigo.
async function saveTimeOffIfFree(timeOff, existing = null) {
  const lockKeys = getTimeOffLockKeys(timeOff.barbeiro, timeOff.inicio, timeOff.fim);
  if (existing) lockKeys.push(...getTimeOffLockKeys(existing.barbeiro, existing.inicio, existing.fim));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const key of [...new Set(lockKeys)].sort()) {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
    }

    const { rows: conflicts } = await client.query(
      `SELECT a.id, a.name, a.phone, a.service, a.date, to_char(a.hour, 'HH24:MI') AS hour
       FROM appointments a
       JOIN services s ON s.name = a.service
       WHERE a.barber = $1
         AND (a.date + a.hour) < $3::timestamp
         AND (a.date + a.hour + s.time_during::interval) > $2::timestamp
       ORDER BY a.date, a.hour`,
      [timeOff.barbeiro, timeOff.inicio, timeOff.fim]
    );
    if (conflicts.length) {
      await client.query('ROLLBACK');
      return {
        conflicts: conflicts.map((row) => ({
          id: String(row.id),
          nome: row.name,
          telefone: row.phone,
          servico: row.service,
          data: row.date,
          hora: row.hour
        }))
      };
    }

    const values = [timeOff.barbeiro, timeOff.inicio, timeOff.fim, timeOff.motivo];
    const { rows } = existing
      ? await client.query(
        `UPDATE barber_time_off
         SET barber = $1, starts_at = $2, ends_at = $3, reason = $4
         WHERE id = $5
         RETURNING ${timeOffColumns}`,
        [...values, existing.id]
      )
      : await client.query(
        `INSERT INTO barber_time_off (barber, starts_at, ends_at, reason)
         VALUES ($1, $2, $3, $4)
         RETURNING ${timeOffColumns}`,
        values
      );
    await client.query('COMMIT');
    return rows[0] ? { timeOff: toTimeOff(rows[0]) } : { notFound: true };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function listAppointments() {
  const { rows } = await pool.query(
    `SELECT id, name, phone, barber, service, date, to_char(hour, 'HH24:MI') AS hour
     FROM appointments
     ORDER BY date ASC, hour ASC, id ASC`
  );
  return rows.map((row) => ({
    id: String(row.id),
    nome: row.name,
    telefone: row.phone,
    barbeiro: row.barber,
    servico: row.service,
    data: row.date,
    hora: row.hour
  }));
}

app.get('/api/servicos', async (request, response, next) => {
  try {
    await databaseReady;
    response.json(await listServices());
  } catch (error) {
    next(error);
  }
});

app.get('/api/barbeiros', async (request, response, next) => {
  try {
    await databaseReady;
    if (request.query.servico === undefined) {
      response.json(await listBarbersForService(null));
      return;
    }

    const service = await getService(request.query.servico);
    if (!service) {
      response.status(400).json({ error: 'Selecione um serviço válido.' });
      return;
    }

    response.json(await listBarbersForService(service.nome));
  } catch (error) {
    next(error);
  }
});

app.get('/api/horarios-disponiveis', async (request, response, next) => {
  const { data, servico, barbeiro } = request.query;

  if (typeof data !== 'string' || !isValidDate(data)) {
    response.status(400).json({ error: 'Informe uma data válida no formato YYYY-MM-DD.' });
    return;
  }

  try {
    await databaseReady;
    const service = await getService(servico);
    if (!service) {
      response.status(400).json({ error: 'Selecione um serviço válido.' });
      return;
    }

    const barber = typeof barbeiro === 'string' ? await getBarberForService(barbeiro, service.nome) : null;
    if (!barber) {
      response.status(400).json({ error: 'Selecione um barbeiro que realize esse serviço.' });
      return;
    }

    const appointments = await listBarberAppointmentsForDate(barber.name, data);
    const timeOff = await listBarberTimeOffForDate(barber.name, data);
    const grade = getTimeSlots(data, service, barber, appointments, timeOff);
    response.json({
      horarios: grade.filter((slot) => slot.disponivel).map((slot) => slot.hora),
      grade
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/agendar', appointmentLimiter, async (request, response, next) => {
  const validationError = validateAppointment(request.body);

  if (validationError) {
    response.status(400).json({ error: validationError });
    return;
  }

  try {
    await databaseReady;
    const service = await getService(request.body.servico.trim());
    if (!service) {
      response.status(400).json({ error: 'Selecione um serviço válido.' });
      return;
    }

    const barber = await getBarberForService(request.body.barbeiro.trim(), service.nome);
    if (!barber) {
      response.status(400).json({ error: 'Selecione um barbeiro que realize esse serviço.' });
      return;
    }

    const appointment = {
      nome: request.body.nome.trim(),
      telefone: request.body.telefone.trim(),
      data: request.body.data.trim(),
      hora: request.body.hora.trim()
    };
    const id = await insertAppointmentIfAvailable(appointment, service, barber);

    if (id === null) {
      response.status(409).json({ error: 'Esse horário não está mais disponível. Escolha outro horário.' });
      return;
    }

    response.status(201).json({ id, ...appointment, servico: service.nome, barbeiro: barber.name });
  } catch (error) {
    next(error);
  }
});

app.get('/api/agendamentos', async (request, response, next) => {
  try {
    await databaseReady;
    response.json(await listAppointments());
  } catch (error) {
    next(error);
  }
});

// Ainda SEM autenticação: proteger antes de publicar o backend.
app.patch('/api/agendamentos/:id', async (request, response, next) => {
  const { id } = request.params;
  if (!/^\d{1,18}$/.test(id)) {
    response.status(400).json({ error: 'Informe um id de agendamento válido.' });
    return;
  }

  const validationError = validateAppointmentChanges(request.body);
  if (validationError) {
    response.status(400).json({ error: validationError });
    return;
  }

  try {
    await databaseReady;
    const { rows } = await pool.query(`SELECT ${appointmentColumns} FROM appointments WHERE id = $1`, [id]);
    const current = rows[0];
    if (!current) {
      response.status(404).json({ error: 'Agendamento não encontrado.' });
      return;
    }

    const service = request.body.servico !== undefined
      ? await getService(request.body.servico.trim())
      : await getServiceByName(current.service);
    if (!service) {
      response.status(400).json({ error: 'Selecione um serviço válido.' });
      return;
    }

    const barber = await getBarberForService(
      request.body.barbeiro !== undefined ? request.body.barbeiro.trim() : current.barber,
      service.nome
    );
    if (!barber) {
      response.status(400).json({ error: 'Selecione um barbeiro que realize esse serviço.' });
      return;
    }

    const changes = {
      nome: request.body.nome !== undefined ? request.body.nome.trim() : current.name,
      telefone: request.body.telefone !== undefined ? request.body.telefone.trim() : current.phone,
      data: request.body.data !== undefined ? request.body.data.trim() : current.date,
      hora: request.body.hora !== undefined ? request.body.hora.trim() : current.hour
    };
    const result = await updateAppointment(id, current, changes, service, barber);

    if (result.notFound) {
      response.status(404).json({ error: 'Agendamento não encontrado.' });
      return;
    }

    if (result.unavailable) {
      response.status(409).json({ error: 'Esse horário não está disponível. Escolha outro horário.' });
      return;
    }

    response.json(result.appointment);
  } catch (error) {
    next(error);
  }
});

app.delete('/api/agendamentos/:id', async (request, response, next) => {
  if (!/^\d{1,18}$/.test(request.params.id)) {
    response.status(400).json({ error: 'Informe um id de agendamento válido.' });
    return;
  }

  try {
    await databaseReady;
    const { rowCount } = await pool.query('DELETE FROM appointments WHERE id = $1', [request.params.id]);
    if (!rowCount) {
      response.status(404).json({ error: 'Agendamento não encontrado.' });
      return;
    }

    response.status(204).end();
  } catch (error) {
    next(error);
  }
});

// Rotas de folga. Ainda SEM autenticação: proteger antes de publicar o backend.
app.get('/api/folgas', async (request, response, next) => {
  const { barbeiro, de, ate } = request.query;

  if (barbeiro !== undefined && typeof barbeiro !== 'string') {
    response.status(400).json({ error: 'Informe um único barbeiro.' });
    return;
  }

  for (const [field, value] of [['de', de], ['ate', ate]]) {
    if (value !== undefined && (typeof value !== 'string' || !isValidDate(value))) {
      response.status(400).json({ error: `O parâmetro "${field}" deve usar o formato YYYY-MM-DD.` });
      return;
    }
  }

  try {
    await databaseReady;
    response.json(await listTimeOff({ barber: barbeiro, from: de, to: ate }));
  } catch (error) {
    next(error);
  }
});

app.post('/api/folgas', async (request, response, next) => {
  const { error: validationError, timeOff } = validateTimeOff(request.body);

  if (validationError) {
    response.status(400).json({ error: validationError });
    return;
  }

  try {
    await databaseReady;
    const { rows } = await pool.query('SELECT 1 FROM barbers WHERE name = $1', [timeOff.barbeiro]);
    if (!rows.length) {
      response.status(400).json({ error: 'Barbeiro não encontrado.' });
      return;
    }

    const result = await saveTimeOffIfFree(timeOff);
    if (result.conflicts) {
      response.status(409).json({
        error: 'Já existem agendamentos nesse período. Remarque esses clientes antes de cadastrar a folga.',
        agendamentos: result.conflicts
      });
      return;
    }

    response.status(201).json(result.timeOff);
  } catch (error) {
    next(error);
  }
});

// Edição parcial: os campos não enviados mantêm o valor atual, e o resultado passa pelas
// mesmas validações e pela mesma checagem de conflito da criação. "motivo": null apaga o motivo.
app.patch('/api/folgas/:id', async (request, response, next) => {
  const { id } = request.params;
  if (!/^\d{1,18}$/.test(id)) {
    response.status(400).json({ error: 'Informe um id de folga válido.' });
    return;
  }

  const body = request.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    response.status(400).json({ error: 'Envie os dados da folga em formato JSON.' });
    return;
  }

  if (!['barbeiro', 'inicio', 'fim', 'motivo'].some((field) => body[field] !== undefined)) {
    response.status(400).json({ error: 'Envie ao menos um campo para alterar: barbeiro, inicio, fim ou motivo.' });
    return;
  }

  try {
    await databaseReady;
    const { rows: currentRows } = await pool.query(`SELECT ${timeOffColumns} FROM barber_time_off WHERE id = $1`, [id]);
    const current = currentRows[0] ? toTimeOff(currentRows[0]) : null;
    if (!current) {
      response.status(404).json({ error: 'Folga não encontrada.' });
      return;
    }

    const { error: validationError, timeOff } = validateTimeOff({
      barbeiro: body.barbeiro !== undefined ? body.barbeiro : current.barbeiro,
      inicio: body.inicio !== undefined ? body.inicio : current.inicio,
      fim: body.fim !== undefined ? body.fim : current.fim,
      motivo: body.motivo !== undefined ? body.motivo : current.motivo
    });
    if (validationError) {
      response.status(400).json({ error: validationError });
      return;
    }

    if (timeOff.barbeiro !== current.barbeiro) {
      const { rows } = await pool.query('SELECT 1 FROM barbers WHERE name = $1', [timeOff.barbeiro]);
      if (!rows.length) {
        response.status(400).json({ error: 'Barbeiro não encontrado.' });
        return;
      }
    }

    const result = await saveTimeOffIfFree(timeOff, current);
    if (result.notFound) {
      response.status(404).json({ error: 'Folga não encontrada.' });
      return;
    }

    if (result.conflicts) {
      response.status(409).json({
        error: 'Já existem agendamentos nesse período. Remarque esses clientes antes de alterar a folga.',
        agendamentos: result.conflicts
      });
      return;
    }

    response.json(result.timeOff);
  } catch (error) {
    next(error);
  }
});

app.delete('/api/folgas/:id', async (request, response, next) => {
  if (!/^\d{1,18}$/.test(request.params.id)) {
    response.status(400).json({ error: 'Informe um id de folga válido.' });
    return;
  }

  try {
    await databaseReady;
    const { rowCount } = await pool.query('DELETE FROM barber_time_off WHERE id = $1', [request.params.id]);
    if (!rowCount) {
      response.status(404).json({ error: 'Folga não encontrada.' });
      return;
    }

    response.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.use((request, response) => {
  response.status(404).json({ error: 'Rota não encontrada.' });
});

app.use((error, request, response, next) => {
  if (response.headersSent) {
    next(error);
    return;
  }

  if (error.type === 'entity.parse.failed') {
    response.status(400).json({ error: 'O corpo da requisição deve conter JSON válido.' });
    return;
  }

  if (error.type === 'entity.too.large') {
    response.status(413).json({ error: 'O corpo da requisição excede o limite de 16 KB.' });
    return;
  }

  console.error('Erro ao processar a requisição:', error);
  response.status(500).json({ error: 'Erro interno ao processar a requisição.' });
});

export function startServer() {
  return databaseReady.then(() => new Promise((resolvePromise, rejectPromise) => {
    const server = app.listen(port, () => resolvePromise(server));
    server.once('error', rejectPromise);
  }));
}

export function closeDatabase() {
  return pool.end();
}

const isMainModule = process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMainModule) {
  startServer()
    .then((server) => {
      console.log(`Servidor de agendamentos ativo na porta ${port}.`);

      const shutdown = () => {
        server.close((serverError) => {
          if (serverError) {
            console.error('Erro ao encerrar o servidor:', serverError);
            process.exitCode = 1;
          }

          closeDatabase().catch((databaseError) => {
            console.error('Erro ao fechar o banco de dados:', databaseError);
            process.exitCode = 1;
          });
        });
      };

      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
    })
    .catch((error) => {
      console.error('Não foi possível iniciar o servidor:', error);
      closeDatabase().catch((databaseError) => {
        console.error('Erro ao fechar o banco de dados:', databaseError);
      });
      process.exitCode = 1;
    });
}
