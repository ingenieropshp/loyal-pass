-- ─────────────────────────────────────────────────────────────────────────────
-- MIGRACIÓN: Sistema de Web Push Notifications
-- Ejecutar en Supabase → SQL Editor
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Tabla de suscripciones push (una fila por dispositivo/navegador)
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id                uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  endpoint          text        UNIQUE NOT NULL,
  subscription_json jsonb       NOT NULL,
  created_at        timestamptz DEFAULT now(),
  updated_at        timestamptz DEFAULT now()
);

-- Índice para búsquedas por endpoint (upsert en save-push-subscription)
CREATE INDEX IF NOT EXISTS idx_push_subs_endpoint
  ON push_subscriptions (endpoint);

-- 2. Columna origen en metricas_proximidad (para distinguir eventos geofence de check-ins manuales)
ALTER TABLE metricas_proximidad
  ADD COLUMN IF NOT EXISTS origen text DEFAULT 'manual';
-- Valores posibles: 'manual' | 'geofence_push'

-- RLS: las suscripciones las escribe la Edge Function con service_role,
-- así que los usuarios anónimos no necesitan acceso.
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;
-- Sin políticas = solo service_role puede leer/escribir (correcto para Edge Functions)

-- ── Verificación ─────────────────────────────────────────────────────────────
-- SELECT table_name FROM information_schema.tables
-- WHERE table_name IN ('push_subscriptions')
--   AND table_schema = 'public';
