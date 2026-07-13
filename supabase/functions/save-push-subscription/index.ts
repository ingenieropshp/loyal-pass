/**
 * save-push-subscription/index.ts — v2.0
 * Fixes:
 *  - onConflict usa solo 'endpoint' (la tabla no tiene unique en endpoint+restaurante_id)
 *  - SUPABASE_SECRET_KEYS: compatible nuevo y legacy formato
 *  - restaurante_id: se guarda pero no forma parte del constraint de unicidad
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

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

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Método no permitido' }), {
      status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    const { subscription, restauranteId } = await req.json();

    if (!subscription?.endpoint) {
      return new Response(JSON.stringify({ error: 'Suscripción inválida' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      getServiceRoleKey(),
      { auth: { persistSession: false } }
    );

    // ── FIX Bug 3: onConflict solo en 'endpoint' (único índice único real) ────
    // restaurante_id se guarda como dato pero no forma parte del constraint
    const { error } = await supabase
      .from('push_subscriptions')
      .upsert(
        {
          endpoint:          subscription.endpoint,
          subscription_json: subscription,
          restaurante_id:    restauranteId ?? null,  // guardarlo como dato
          updated_at:        new Date().toISOString(),
        },
        { onConflict: 'endpoint' }  // ← solo endpoint, que es el unique real
      );

    if (error) {
      console.error('[save-push-subscription] Error upsert:', error.message);
      throw error;
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    console.error('[save-push-subscription] Error:', err);
    return new Response(JSON.stringify({ error: 'Error interno' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
