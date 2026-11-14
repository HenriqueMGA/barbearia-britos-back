-- Protege o histórico de agendamentos: apagar um barbeiro ou serviço que tenha agendamentos
-- passa a ser bloqueado (antes, ON DELETE CASCADE apagava os agendamentos junto).
-- Renomear continua propagando para os agendamentos (ON UPDATE CASCADE).
-- Para remover um barbeiro/serviço, apague ou reatribua os agendamentos dele antes.

BEGIN;

ALTER TABLE public.appointments
  DROP CONSTRAINT appointments_barber_fkey,
  ADD CONSTRAINT appointments_barber_fkey
    FOREIGN KEY (barber) REFERENCES public.barbers (name) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE public.appointments
  DROP CONSTRAINT appointments_service_fkey,
  ADD CONSTRAINT appointments_service_fkey
    FOREIGN KEY (service) REFERENCES public.services (name) ON UPDATE CASCADE ON DELETE RESTRICT;

COMMIT;
