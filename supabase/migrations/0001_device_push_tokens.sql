-- device_push_tokens
-- ─────────────────────────────────────────────────────────────────────────
-- Guarda el token FCM de cada instalación nativa (Android/iOS vía Capacitor
-- Push Notifications). Es DISTINTA de `push_subscriptions` (esa es para Web
-- Push/VAPID desde el navegador — solo funciona con la pestaña/app abierta).
-- Esta tabla es la que permite empujar una notificación real con la app
-- cerrada, porque FCM la entrega el sistema operativo, no el navegador.
--
-- device_id: mismo valor que devuelve utils/deviceId.js (getDeviceId()),
-- así el webhook de geocercas puede encontrar el token sin depender de login.

create table if not exists public.device_push_tokens (
  id           uuid primary key default gen_random_uuid(),
  device_id    text not null unique,
  fcm_token    text not null,
  platform     text not null default 'android',
  updated_at   timestamptz not null default now()
);

create index if not exists device_push_tokens_device_id_idx
  on public.device_push_tokens (device_id);

alter table public.device_push_tokens enable row level security;

-- El cliente (anon key) solo necesita poder hacer upsert de SU propio
-- device_id — no necesita leer tokens ajenos. El webhook usa la
-- service_role key desde la Edge Function, que ignora RLS.
create policy "cualquiera puede registrar/actualizar su propio device token"
  on public.device_push_tokens
  for insert
  to anon, authenticated
  with check (true);

create policy "cualquiera puede actualizar su propio device token"
  on public.device_push_tokens
  for update
  to anon, authenticated
  using (true);
