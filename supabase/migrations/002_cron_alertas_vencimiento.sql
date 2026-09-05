-- ============================================================================
-- Cron mensual: dispara la Edge Function alertas-vencimiento-puntos
-- ============================================================================
-- Requiere las extensiones pg_cron y pg_net habilitadas (Database → Extensions
-- en el dashboard de Supabase). Como ya tienen otros jobs con pg_cron en este
-- proyecto (motor de fidelización), lo más probable es que ya estén activas.

-- Reemplaza estos dos valores por los de tu proyecto:
--   <PROJECT_REF>        → referencia del proyecto (la ves en la URL de Supabase)
--   <SERVICE_ROLE_KEY>   → guárdala como secreto de Vault, no la dejes en texto
--                           plano en una migración versionada en git

select vault.create_secret(
  '<SERVICE_ROLE_KEY>',
  'service_role_key_edge_functions'
);

select cron.schedule(
  'alertas-vencimiento-puntos-mensual',
  '0 9 1 * *',  -- 9:00 a.m. el día 1 de cada mes
  $$
  select net.http_post(
    url     := 'https://<PROJECT_REF>.functions.supabase.co/alertas-vencimiento-puntos',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (
        select decrypted_secret from vault.decrypted_secrets
        where name = 'service_role_key_edge_functions'
      )
    ),
    body := '{}'::jsonb
  );
  $$
);

-- Para verificar que quedó programado:
--   select * from cron.job where jobname = 'alertas-vencimiento-puntos-mensual';
--
-- Para ver el historial de corridas:
--   select * from cron.job_run_details
--   where jobid = (select jobid from cron.job where jobname = 'alertas-vencimiento-puntos-mensual')
--   order by start_time desc;
--
-- Para desactivarlo temporalmente sin borrarlo:
--   select cron.unschedule('alertas-vencimiento-puntos-mensual');
