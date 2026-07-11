/**
 * save-push-subscription/index.ts — Supabase Edge Function (Deno)
 *
 * Endpoint: POST /functions/v1/save-push-subscription
 *
 * Guarda o actualiza la PushSubscription del dispositivo en la tabla
 * push_subscriptions para que check-geofence pueda enviarle pushes
 * incluso cuando el usuario no tiene la app abierta.
 *
 * La tabla debe existir en Supabase (ver migration_push.sql):
 *   CREATE TABLE push_subscriptions (
 *     id               uuid DEFAULT gen_random_uuid() PRIMARY KEY,
 *     endpoint         text UNIQUE NOT NULL,
 *     subscription_json jsonb NOT NULL,
 *     created_at       timestamptz DEFAULT now(),
 *     updated_at       timestamptz DEFAULT now()
 *   );
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

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

    if (!restauranteId) {
      return new Response(JSON.stringify({ error: 'Falta restauranteId' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { persistSession: false } }
    );

    const { error } = await supabase
      .from('push_subscriptions')
      .upsert(
        {
          endpoint:          subscription.endpoint,
          subscription_json: subscription,
          restaurante_id:    restauranteId,
          updated_at:        new Date().toISOString(),
        },
        { onConflict: 'endpoint,restaurante_id' }
      );

    if (error) throw error;

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
