/**
 * supabase/functions/update-admin-user/index.ts — v2.0 (SEGURIDAD)
 * ──────────────────────────────────────────────────────────────────
 * Actualiza email y/o password de un usuario en Supabase Auth.
 * Usa la Admin API (service_role) para poder editar el usuario.
 *
 * FIX CRÍTICO: la v1 no validaba quién llamaba a esta función. Cualquiera
 * con la anon key (pública, está en el bundle del frontend) podía enviar
 * un userId ajeno y cambiarle el password. Ahora:
 *   1. Se exige un JWT válido en el header Authorization.
 *   2. Solo se permite editar el PROPIO usuario (user.id === userId).
 *
 * Si además necesitas que un "super admin" pueda editar a otros admins,
 * ver el bloque "SUPER ADMIN (opcional)" más abajo — necesitas decirme
 * cómo identificas a un super admin en tu tabla `usuarios_admin` (ej. una
 * columna `rol` o `es_super_admin`) para activar esa rama con seguridad.
 *
 * Body esperado: { userId: string, email?: string, password?: string }
 * Header esperado: Authorization: Bearer <access_token del usuario logueado>
 *
 * Deploy: supabase functions deploy update-admin-user
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

// Compatible con legacy SUPABASE_SERVICE_ROLE_KEY y nuevo SUPABASE_SECRET_KEYS
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

// Compatible con legacy SUPABASE_ANON_KEY y nuevo SUPABASE_PUBLISHABLE_KEYS
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
      console.error('[update-admin-user] Falta configuración de servidor');
      return json({ error: 'Configuración de servidor incompleta' }, 500);
    }

    // ── 1. Verificar identidad del que llama (con su propio JWT, no service_role) ──
    const authHeader = req.headers.get('Authorization') ?? '';
    const jwt = authHeader.replace(/^Bearer\s+/i, '');
    if (!jwt) {
      return json({ error: 'No autenticado' }, 401);
    }

    const supabaseAsCaller = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
      auth: { persistSession: false },
    });

    const { data: { user: caller }, error: authError } = await supabaseAsCaller.auth.getUser();
    if (authError || !caller) {
      return json({ error: 'Token inválido o expirado' }, 401);
    }

    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // ── 2. Confirmar que quien llama es un admin registrado (no cualquier auth.users) ──
    const { data: callerAdminRow, error: callerAdminErr } = await supabaseAdmin
      .from('usuarios_admin')
      .select('id, restaurante_id')
      .eq('id', caller.id)
      .maybeSingle();

    if (callerAdminErr || !callerAdminRow) {
      return json({ error: 'No autorizado: no eres un administrador registrado' }, 403);
    }

    const { userId, email, password } = await req.json();

    if (!userId) {
      return json({ error: 'userId requerido' }, 400);
    }
    if (!email && !password) {
      return json({ error: 'Debes enviar email o password' }, 400);
    }

    // ── 3. Solo puede editarse a sí mismo ─────────────────────────────────────
    // SUPER ADMIN (opcional): si en el futuro agregas una columna, por ejemplo
    // `usuarios_admin.rol = 'super_admin'`, podrías reemplazar este bloque por:
    //
    //   const esSuperAdmin = callerAdminRow.rol === 'super_admin';
    //   if (caller.id !== userId && !esSuperAdmin) { ... 403 ... }
    //
    // Mientras no exista esa columna, restringimos a auto-edición para evitar
    // que un admin edite a otro.
    if (caller.id !== userId) {
      return json({ error: 'No autorizado para editar este usuario' }, 403);
    }

    // ── 4. Validaciones básicas de entrada ─────────────────────────────────────
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json({ error: 'Email inválido' }, 400);
    }
    if (password && password.length < 8) {
      return json({ error: 'La contraseña debe tener al menos 8 caracteres' }, 400);
    }

    const updates: { email?: string; password?: string } = {};
    if (email) updates.email = email;
    if (password) updates.password = password;

    const { data, error } = await supabaseAdmin.auth.admin.updateUserById(userId, updates);
    if (error) throw error;

    return json({ success: true, user: { id: data.user.id, email: data.user.email } });

  } catch (err: any) {
    console.error('[update-admin-user] Error:', err?.message ?? err);
    return json({ error: err?.message ?? 'Error interno' }, 500);
  }
});
