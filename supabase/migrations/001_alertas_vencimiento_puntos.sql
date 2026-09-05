-- ============================================================================
-- Migración: alertas de vencimiento de puntos (30 días antes de expirar)
-- Esquema REAL confirmado en el dashboard (SQL Editor, information_schema):
--   transacciones_puntos: id uuid, cliente_id uuid, restaurante_id uuid,
--     tipo text, canal text, monto_cop numeric, puntos integer,
--     puntos_restantes integer, fecha_vencimiento timestamptz,
--     vencido boolean, referencia jsonb, creado_en timestamptz, monto numeric
--   clientes: ..., puntos integer (saldo TOTAL del cliente), ...
--   dispositivos_clientes: device_id text, restaurante_id uuid, cliente_id uuid,
--     actualizado_en timestamptz  ← el token vive AQUÍ, no en `clientes`
-- ============================================================================

-- 1. transacciones_puntos YA EXISTE con otro esquema — no se crea, solo se le
--    agrega la columna de idempotencia que falta. ALTER ... IF NOT EXISTS es
--    seguro de re-ejecutar y no toca las columnas existentes.
alter table transacciones_puntos
  add column if not exists notificado_vencimiento boolean default false;

create index if not exists idx_transacciones_puntos_vencimiento
  on transacciones_puntos(fecha_vencimiento, puntos_restantes)
  where puntos_restantes > 0;

-- 2. historial_notificaciones es tabla nueva (no existía antes de este módulo)
create table if not exists historial_notificaciones (
  id             bigserial primary key,
  cliente_id     uuid references clientes(id) on delete cascade,
  tipo           varchar(50) not null, -- 'alerta_vencimiento_apto' | 'alerta_vencimiento_incentivo' | 'sin_token'
  titulo         varchar(150),
  contenido      text,
  estado_envio   varchar(20) default 'exitoso', -- 'exitoso' | 'fallido' | 'sin_token'
  fecha_envio    timestamptz default timezone('utc'::text, now())
);

-- 3. RPC: usa los nombres REALES de columna. El token se resuelve con un
--    LATERAL JOIN a dispositivos_clientes, tomando el dispositivo más
--    reciente de cada cliente (puede haber más de uno registrado).
create or replace function fn_clientes_puntos_por_vencer()
returns table (
  cliente_id         uuid,
  nombre             text,
  saldo_actual       integer,
  total_por_vencer   integer,
  token_dispositivo  text
) as $$
begin
  return query
  select
    c.id as cliente_id,
    c.nombre,
    c.puntos as saldo_actual,
    sum(tp.puntos_restantes)::integer as total_por_vencer,
    dc.device_id as token_dispositivo
  from clientes c
  inner join transacciones_puntos tp on tp.cliente_id = c.id
  left join lateral (
    select d.device_id
    from dispositivos_clientes d
    where d.cliente_id = c.id
    order by d.actualizado_en desc
    limit 1
  ) dc on true
  where tp.puntos_restantes > 0
    and coalesce(tp.vencido, false) = false
    and tp.notificado_vencimiento = false
    and tp.fecha_vencimiento >= now()
    and tp.fecha_vencimiento <= (now() + interval '30 days')
  group by c.id, c.nombre, c.puntos, dc.device_id;
end;
$$ language plpgsql security definer set search_path = public;
