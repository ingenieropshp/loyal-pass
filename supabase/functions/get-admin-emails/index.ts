/**
 * supabase/functions/get-admin-emails/index.ts — v2.0 (SEGURIDAD)
 * ──────────────────────────────────────────────────────────────────
 * Recibe un array de user IDs y retorna un mapa { userId: email }
 * usando la Admin API de Supabase (solo accesible desde Edge Functions).
 *
 * FIX CRÍTICO: la v1 no validaba quién llamaba. Cualquiera con la anon key
 * podía mandar cualquier userId y obtener el email de otra persona (fuga
 * de datos, útil para un atacante que luego intenta tomar esa cuenta).
 * Ahora:
 *   1. Se exige un JWT válido en el header Authorization.
 *   2. Solo se devuelven emails de usuarios que pertenecen al MISMO
 *      restaurante que el que llama (usuarios_admin.restaurante_id).
 *
 * Body esperado: { ids: string[] }
 * Header esperado: Authorization: Bearer <access_token del usuario logueado>
 *
 * Deploy: supabase functions deploy get-admin-emails
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

function getServiceRoleKey(): string {
  const secretKeys = Deno.env.get('SUPABASE_SECRET_KEYS');
  if (secretKeys) {
    try {
      const parsed = JSON.parse(secretKeys);
      const key = parsed?.service_role ?? Object.values(parsed)[0];
      if (key) return String(key);
    } catch { /* fallback */ }
  }
  return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
}

function getAnonKey(): string {
  const pubKeys = Deno.env.get('SUPABASE_PUBLISHABLE_KEYS');
  if (pubKeys) {
    try {
      const parsed = JSON.parse(pubKeys);
      const key = parsed?.anon ?? Object.values(parsed)[0];
      if (key) return String(key);
    } catch { /* fallback */ }
  }
  return Deno.env.get('SUPABASE_ANON_KEY') ?? '';
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Método no permitido' }, 405);

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceRoleKey = getServiceRoleKey();
    const anonKey = getAnonKey();

    if (!supabaseUrl || !serviceRoleKey || !anonKey) {
      console.error('[get-admin-emails] Falta configuración de servidor');
      return json({ error: 'Configuración de servidor incompleta' }, 500);
    }

    // ── 1. Verificar identidad del que llama ──────────────────────────────────
    const authHeader = req.headers.get('Authorization') ?? '';
    const jwt = authHeader.replace(/^Bearer\s+/i, '');
    if (!jwt) return json({ error: 'No autenticado' }, 401);

    const supabaseAsCaller = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
      auth: { persistSession: false },
    });
    const { data: { user: caller }, error: authError } = await supabaseAsCaller.auth.getUser();
    if (authError || !caller) return json({ error: 'Token inválido o expirado' }, 401);

    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // ── 2. Confirmar que quien llama es un admin y obtener su restaurante ────
    const { data: callerAdminRow, error: callerAdminErr } = await supabaseAdmin
      .from('usuarios_admin')
      .select('id, restaurante_id')
      .eq('id', caller.id)
      .maybeSingle();

    if (callerAdminErr || !callerAdminRow) {
      return json({ error: 'No autorizado: no eres un administrador registrado' }, 403);
    }

    const { ids } = await req.json();
    if (!ids || !Array.isArray(ids)) {
      return json({ error: 'ids array requerido' }, 400);
    }

    // ── 3. Limitar la consulta a admins del MISMO restaurante que el que llama ──
    // Esto evita que un admin del Restaurante A pueda enumerar emails de
    // admins del Restaurante B pasando IDs adivinados.
    const { data: allowedRows, error: allowedErr } = await supabaseAdmin
      .from('usuarios_admin')
      .select('id')
      .eq('restaurante_id', callerAdminRow.restaurante_id)
      .in('id', ids);

    if (allowedErr) throw allowedErr;

    const allowedIds = new Set((allowedRows ?? []).map((r: any) => r.id));

    // ── 4. Obtener email solo para los IDs permitidos ─────────────────────────
    const emails: Record<string, string> = {};
    await Promise.all(
      ids
        .filter((id: string) => allowedIds.has(id))
        .map(async (id: string) => {
          const { data, error } = await supabaseAdmin.auth.admin.getUserById(id);
          if (!error && data?.user?.email) {
            emails[id] = data.user.email;
          }
        })
    );

    return json({ emails });

  } catch (err: any) {
    console.error('[get-admin-emails] Error:', err?.message ?? err);
    return json({ error: err?.message ?? 'Error interno' }, 500);
  }
});
