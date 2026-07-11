-- ─────────────────────────────────────────────────────────────────────────────
-- MIGRACIÓN v2: Segmentar push_subscriptions por restaurante
-- Ejecutar en Supabase → SQL Editor
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Agregar la columna restaurante_id (nullable al inicio, para no romper filas existentes)
ALTER TABLE push_subscriptions
  ADD COLUMN IF NOT EXISTS restaurante_id uuid;

-- 2. Foreign Key hacia configuracion(id), que es la tabla que identifica cada
--    restaurante en tu esquema actual (usada en check-geofence: .eq('id', restauranteId)).
--    ON DELETE CASCADE: si se borra un restaurante, se limpian sus suscripciones huérfanas.
ALTER TABLE push_subscriptions
  ADD CONSTRAINT fk_push_subscriptions_restaurante
  FOREIGN KEY (restaurante_id)
  REFERENCES configuracion (id)
  ON DELETE CASCADE;

-- 3. Eliminar filas antiguas sin restaurante_id (suscripciones "huérfanas" del bug anterior).
--    Si prefieres conservarlas para investigar, comenta esta línea.
DELETE FROM push_subscriptions WHERE restaurante_id IS NULL;

-- 4. Ahora que están limpias, hacer la columna obligatoria
ALTER TABLE push_subscriptions
  ALTER COLUMN restaurante_id SET NOT NULL;

-- 5. Reemplazar la restricción UNIQUE(endpoint) por UNIQUE(endpoint, restaurante_id).
--    Motivo: un mismo dispositivo/navegador puede ser cliente de VARIOS restaurantes
--    (tu app soporta multi-sede vía localStorage 'bistro_multisede'), así que el mismo
--    endpoint necesita una fila por cada restaurante al que está suscrito.
ALTER TABLE push_subscriptions DROP CONSTRAINT IF EXISTS push_subscriptions_endpoint_key;
DROP INDEX IF EXISTS idx_push_subs_endpoint; -- se recrea abajo, ahora compuesto

ALTER TABLE push_subscriptions
  ADD CONSTRAINT push_subscriptions_endpoint_restaurante_key
  UNIQUE (endpoint, restaurante_id);

-- 6. Índice para el filtro que hará check-geofence: WHERE restaurante_id = X
CREATE INDEX IF NOT EXISTS idx_push_subs_restaurante_id
  ON push_subscriptions (restaurante_id);

-- ── RLS ──────────────────────────────────────────────────────────────────────
-- No cambia: la tabla ya tiene RLS habilitado sin políticas para anon, por lo que
-- solo la service_role (usada dentro de las Edge Functions) puede leer/escribir.
-- No se requiere ninguna política adicional para este cambio.

-- ── Verificación ─────────────────────────────────────────────────────────────
-- SELECT conname, pg_get_constraintdef(oid)
-- FROM pg_constraint
-- WHERE conrelid = 'push_subscriptions'::regclass;
