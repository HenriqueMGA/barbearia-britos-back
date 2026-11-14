# Britos Barbearia — API de agendamentos

Backend do agendamento online do site da **Britos Barbearia**. Lista serviços e barbeiros, calcula os horários livres de cada barbeiro, registra agendamentos e gerencia folgas.

Feito em **Node.js + Express**, com o driver `pg` conectado ao **Postgres do Supabase**. O site (pasta `Britos_Barbearia_imagem/`) nunca acessa o banco direto: toda leitura e escrita passa por esta API.

---

## Sumário

1. [Requisitos](#1-requisitos)
2. [Configuração (.env)](#2-configuração-env)
3. [Como rodar](#3-como-rodar)
4. [Estrutura de arquivos](#4-estrutura-de-arquivos)
5. [Banco de dados](#5-banco-de-dados)
6. [Regras de horário](#6-regras-de-horário)
7. [Endpoints](#7-endpoints)
8. [Segurança](#8-segurança)
9. [Como publicar](#9-como-publicar)
10. [Pendências](#10-pendências)

---

## 1. Requisitos

- **Node.js 22.9 ou mais novo** (o `pnpm start` usa `--env-file-if-exists`, que não existe em versões anteriores).
- **pnpm** (`npm install -g pnpm`). O projeto fixa o pnpm 12.15.0 em `packageManager`.

| Dependência | Para quê |
|---|---|
| `express` 5 | Servidor HTTP e rotas |
| `pg` | Conexão com o Postgres do Supabase |
| `cors` | Libera o site a chamar a API a partir de outro endereço |
| `express-rate-limit` | Limita tentativas de agendamento por IP |

---

## 2. Configuração (.env)

Copie o `.env.example` para `.env` e preencha. O `.env` tem a senha do banco: **não envie para o git** (já está no `.gitignore`) nem compartilhe.

| Variável | Obrigatória | Descrição |
|---|---|---|
| `DATABASE_URL` | sim | Connection string do Supabase (painel → **Connect** → **Session pooler**) |
| `PORT` | não | Porta da API. Padrão: `3000` |
| `FRONTEND_URL` | sim, na prática | Endereço(s) do site liberados no CORS, separados por vírgula. **Sem ela, o navegador bloqueia todas as chamadas do site** e o servidor avisa ao iniciar |
| `TRUST_PROXY` | só em produção | Quantos proxies ficam na frente do servidor (ex.: `1` no Render/Railway). Sem isso, atrás de proxy, todos os clientes dividem o mesmo limite de agendamentos |

Exemplo para desenvolvimento local:

```
PORT=3000
DATABASE_URL=postgresql://postgres.<project-ref>:<senha>@<host-do-pooler>.supabase.com:5432/postgres
FRONTEND_URL=http://localhost:8000,http://127.0.0.1:8000
TRUST_PROXY=
```

---

## 3. Como rodar

```bash
cd backend
pnpm install
pnpm start
```

A API sobe em `http://localhost:3000`. Para testar, abra `http://localhost:3000/api/servicos` no navegador: deve aparecer a lista de serviços em JSON.

Se o servidor não subir com `Não foi possível iniciar o servidor`, ele não conseguiu conectar ao banco. Confira a `DATABASE_URL` (copie de novo do painel do Supabase) e se o projeto do Supabase não está pausado.

Para rodar o site junto, veja o `README.md` e o `comandos-inicializacao.txt` na pasta raiz do projeto.

---

## 4. Estrutura de arquivos

```
backend/
├── server.js        Toda a API: conexão com o banco, regras de horário e rotas
├── migrations/      Alterações feitas no banco, em ordem (veja a seção 5.3)
├── .env.example     Modelo das variáveis de ambiente
├── .env             Variáveis reais (fora do git)
├── package.json
└── pnpm-lock.yaml
```

O `server.js` exporta `app`, `pool`, `startServer()` e `closeDatabase()`, o que permite importá-lo em testes sem abrir a porta. Ao receber `Ctrl + C` (SIGINT/SIGTERM), fecha o servidor e a conexão com o banco.

---

## 5. Banco de dados

### 5.1 Tabelas

| Tabela | Uso |
|---|---|
| `services` | Serviços: `name` (único), `value` (preço, ex.: `30.00`) e `time_during` (duração, ex.: `00:30`) |
| `barbers` | Barbeiros (`name` único) e expediente (`days` e `hours`, veja a seção 6) |
| `barber_service` | Quais serviços cada barbeiro realiza (`barber` + `service`, pelos nomes). É a fonte usada pela API; a coluna `barbers.services` não é lida |
| `appointments` | Agendamentos (`name`, `phone`, `barber`, `service`, `date`, `hour`) |
| `barber_time_off` | Folgas (`barber`, `starts_at`, `ends_at`, `reason`), no horário de São Paulo. `ends_at` é exclusivo: uma folga de dia inteiro em 05/11 vai de `2026-11-05 00:00` a `2026-11-06 00:00` |

Um serviço só aparece com barbeiros se houver linhas em `barber_service` para ele.

As tabelas têm RLS ativado e nenhuma policy: a chave `anon` do Supabase não lê nem grava nada. O backend conecta como `postgres` e não é afetado pelo RLS.

### 5.2 Ligações entre tabelas (chaves estrangeiras)

Agendamentos, vínculos e folgas apontam para o **nome** do barbeiro e do serviço.

| Coluna | Aponta para | Ao renomear | Ao apagar o barbeiro/serviço |
|---|---|---|---|
| `appointments.barber` | `barbers.name` | atualiza junto | **bloqueado** se houver agendamentos |
| `appointments.service` | `services.name` | atualiza junto | **bloqueado** se houver agendamentos |
| `barber_service.barber` / `.service` | `barbers.name` / `services.name` | atualiza junto | o vínculo é apagado junto |
| `barber_time_off.barber` | `barbers.name` | atualiza junto | as folgas são apagadas junto |

Na prática:

- **Renomear** um barbeiro ou serviço no Supabase é seguro: tudo acompanha o novo nome.
- **Apagar** um barbeiro ou serviço que tenha agendamentos dá erro, para não perder o histórico. Apague ou passe os agendamentos dele para outro barbeiro antes.

### 5.3 Migrações

A pasta `migrations/` guarda as alterações feitas no banco, numeradas na ordem em que foram aplicadas. Para uma nova alteração, crie o próximo arquivo (`002_...sql`), rode no **Supabase → SQL Editor** e envie o arquivo para o git.

| Arquivo | O que faz | Aplicada |
|---|---|---|
| `001_appointments_on_delete_restrict.sql` | Impede apagar barbeiro/serviço com agendamentos | sim (11/2026) |

As migrações não recriam o banco do zero: a criação das tabelas foi feita direto no Supabase e não está no repositório.

---

## 6. Regras de horário

**Expediente.** Em `barbers`, `days` lista os dias de trabalho e `hours` traz os períodos de cada dia. O intervalo entre dois períodos é a pausa:

```json
days:  ["seg", "ter", "qua", "qui", "sex", "sab"]
hours: {
  "seg": [{"inicio": "09:00", "fim": "12:00"}, {"inicio": "13:00", "fim": "21:00"}],
  "ter": [{"inicio": "09:00", "fim": "21:00"}],
  "sab": [{"inicio": "08:00", "fim": "14:00"}]
}
```

Chaves dos dias: `dom`, `seg`, `ter`, `qua`, `qui`, `sex`, `sab`. Um dia fora de `days` ou sem períodos em `hours` não tem horários.

**Como a grade é montada:**

- Horários de **30 em 30 minutos** a partir do início de cada período.
- Um serviço só é oferecido se **couber inteiro** dentro de um período (não atravessa a pausa).
- Ficam indisponíveis os horários que colidem com outro agendamento (considerando a duração de cada serviço), que caem numa folga ou que já passaram, no dia de hoje.
- Tudo é calculado no fuso de **São Paulo**, independentemente do fuso do servidor.

**Concorrência.** Criar ou alterar agendamentos e folgas acontece numa transação com lock por barbeiro e data (`pg_advisory_xact_lock`). Dois pedidos simultâneos para o mesmo horário nunca são aceitos juntos: o segundo recebe `409`. Isso vale mesmo com várias instâncias do servidor.

---

## 7. Endpoints

Todas as respostas são JSON. Erros vêm como `{ "error": "mensagem" }`, em português, prontos para mostrar ao cliente.

| Status | Quando |
|---|---|
| `400` | Dados inválidos ou JSON malformado |
| `404` | Registro ou rota não encontrados |
| `409` | Horário indisponível ou folga em conflito com agendamentos |
| `413` | Corpo da requisição maior que 16 KB |
| `429` | Muitas tentativas de agendamento (veja a seção 8) |
| `500` | Erro interno (detalhes só no log do servidor) |

### 7.1 Agendamento (usadas pelo site)

- **`GET /api/servicos`**: lista os serviços (`id`, `nome`, `preco`, `duracaoMinutos`).
- **`GET /api/barbeiros?servico=<id>`**: barbeiros que realizam o serviço (`nome` e `dias`). Sem `servico`, lista todos.
- **`GET /api/horarios-disponiveis?data=YYYY-MM-DD&servico=<id>&barbeiro=<nome>`**: retorna `horarios` (lista dos livres) e `grade` (todos os horários do dia com `disponivel: true/false`).
- **`POST /api/agendar`**: cria o agendamento.

  ```json
  { "nome": "João", "telefone": "11999999999", "servico": "1",
    "barbeiro": "Brito", "data": "2026-11-20", "hora": "14:30" }
  ```

  Retorna `201` com o agendamento criado ou `409` se o horário já foi ocupado. Limitado a **10 tentativas a cada 15 minutos por IP**.

### 7.2 Gestão de agendamentos

- **`GET /api/agendamentos`**: lista todos, ordenados por data e hora. **Retorna nomes e telefones.**
- **`PATCH /api/agendamentos/:id`**: altera um agendamento. Envie só os campos que mudam (`nome`, `telefone`, `servico` (id), `barbeiro`, `data`, `hora`). Se serviço, barbeiro, data ou hora mudarem, a disponibilidade é conferida de novo, ignorando o próprio agendamento. Retorna `200`, `400`, `404` ou `409`.
- **`DELETE /api/agendamentos/:id`**: remove o agendamento (`204`) e libera o horário. `404` se não existir.

### 7.3 Folgas

As folgas bloqueiam os horários do barbeiro na grade e no `POST /api/agendar`, e podem ser cadastradas com qualquer antecedência.

- **`GET /api/folgas?barbeiro=<nome>&de=YYYY-MM-DD&ate=YYYY-MM-DD`**: folgas que tocam o período. Filtros opcionais.
- **`POST /api/folgas`**: recebe `barbeiro`, `inicio`, `fim` e `motivo` (opcional). `inicio` e `fim` aceitam `YYYY-MM-DDTHH:MM` (formato do `<input type="datetime-local">`) ou só `YYYY-MM-DD`. Só com a data, o início vale 00:00 e o fim vai até o final daquele dia.

  | Folga | `inicio` | `fim` |
  |---|---|---|
  | Algumas horas | `2026-11-05T14:00` | `2026-11-05T16:00` |
  | Dia inteiro | `2026-11-05` | `2026-11-05` |
  | Vários dias | `2026-12-20` | `2027-01-04` |

  Retorna `201` com `{ id, barbeiro, inicio, fim, motivo }`. Se houver clientes agendados no período, retorna `409` com a lista `agendamentos` (id, nome, telefone, serviço, data e hora) e **não** cria a folga. Duração máxima: 366 dias.
- **`PATCH /api/folgas/:id`**: altera a folga. Envie só os campos que mudam (`"motivo": null` apaga o motivo). Passa pela mesma checagem de conflitos do `POST`.
- **`DELETE /api/folgas/:id`**: remove a folga (`204`) ou `404`.

---

## 8. Segurança

**Já implementado:**

- **CORS restrito**: só os endereços em `FRONTEND_URL` podem chamar a API pelo navegador.
- **Rate limit** em `POST /api/agendar`: 10 tentativas a cada 15 minutos por IP. Passando disso, retorna `429`. Em produção atrás de proxy, configure `TRUST_PROXY` (seção 2).
- **Validação** de todos os campos (tipo, tamanho e formato) e corpo limitado a 16 KB.
- **Consultas parametrizadas** em todas as queries (sem risco de SQL injection).
- **Erros internos** não expõem detalhes ao cliente; ficam só no log.

**Ainda falta — antes de publicar:**

- **As rotas de gestão não têm login.** Qualquer pessoa com a URL da API consegue listar nomes e telefones de clientes (`GET /api/agendamentos`), alterar ou apagar agendamentos e criar ou apagar folgas. CORS não é controle de acesso: ele só vale para navegadores. Essas rotas precisam de autenticação antes de o backend ir ao ar (exposição de dados pessoais também é questão de LGPD).
- **O certificado SSL do banco não é verificado** (`rejectUnauthorized: false`). A conexão é criptografada, mas não confere se o servidor é mesmo o Supabase. Para verificar, baixe o certificado CA no painel do Supabase e configure no `pool`.

---

## 9. Como publicar

1. Hospede a pasta `backend/` num serviço que rode Node.js 22.9+ (Render, Railway, Fly.io etc.), com o comando de início `pnpm start`.
2. Configure as variáveis no painel da hospedagem (não envie o `.env`):
   - `DATABASE_URL`
   - `FRONTEND_URL` com o domínio do site (ex.: `https://britosbarbearia.com.br,https://www.britosbarbearia.com.br`)
   - `TRUST_PROXY=1` (a maioria das hospedagens tem um proxy na frente)
   - `PORT` normalmente é definida pela própria hospedagem.
3. No site, em `assets/js/agendamento.js`, troque a URL de produção da API pelo endereço HTTPS real.
4. Resolva as pendências de segurança da seção 8 antes.

---

## 10. Pendências

- [ ] Autenticação nas rotas de gestão (`/api/agendamentos` e `/api/folgas`).
- [ ] Definir `FRONTEND_URL` com o domínio real do site.
- [ ] Verificar o certificado SSL do Supabase.
- [ ] Versionar a estrutura das tabelas (`schema.sql`) para conseguir recriar o banco do zero.
- [ ] Testes automatizados (o script `pnpm test` ainda não faz nada).

---

*Documentação de novembro de 2026. Ao mudar rotas, variáveis ou o banco, mantenha este arquivo atualizado.*
