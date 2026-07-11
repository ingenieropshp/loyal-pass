/**
 * check-geofence/index.ts — Supabase Edge Function v2.1
 * Fix: validación de env vars al inicio, errores descriptivos
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import webpush from 'https://esm.sh/web-push@3.6.7';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function haversineMetros(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6_371_000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
    Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Método no permitido' }), {
      status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    // ── Validar variables de entorno ANTES de procesar ──────────────────────
    const supabaseUrl     = Deno.env.get('SUPABASE_URL');
    const serviceRoleKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const vapidPublicKey  = Deno.env.get('VAPID_PUBLIC_KEY');
    const vapidPrivateKey = Deno.env.get('VAPID_PRIVATE_KEY');
    const vapidSubject    = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:admin@bistroconnect.com';
    const appUrl          = Deno.env.get('APP_URL') ?? 'https://bistro-app.pages.dev';

    if (!supabaseUrl || !serviceRoleKey) {
      console.error('[check-geofence] Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY');
      return new Response(JSON.stringify({ error: 'Configuración de servidor incompleta' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (!vapidPublicKey || !vapidPrivateKey) {
      console.error('[check-geofence] Faltan VAPID_PUBLIC_KEY o VAPID_PRIVATE_KEY en Secrets');
      return new Response(JSON.stringify({ error: 'Faltan claves VAPID en Edge Function Secrets' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ── Parsear body ─────────────────────────────────────────────────────────
    const body = await req.json();
    const { restauranteId, latitudUsuario, longitudUsuario, subscription } = body;

    if (!restauranteId || latitudUsuario == null || longitudUsuario == null) {
      return new Response(JSON.stringify({ error: 'Faltan parámetros: restauranteId, latitudUsuario, longitudUsuario' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const uLat = parseFloat(latitudUsuario);
    const uLon = parseFloat(longitudUsuario);
    if (isNaN(uLat) || isNaN(uLon)) {
      return new Response(JSON.stringify({ error: 'Coordenadas inválidas' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ── Cliente Supabase con service role ─────────────────────────────────────
    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false },
    });

    // ── Cargar datos del restaurante ─────────────────────────────────────────
    const { data: conexion, error: errConexion } = await supabase
      .from('conexion')
      .select('latitud, longitud, radio_aviso, puntos_llegada, mensaje_promo')
      .eq('restaurante_id', restauranteId)
      .maybeSingle();

    if (errConexion || !conexion) {
      return new Response(JSON.stringify({ error: 'Restaurante no encontrado en conexion' }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { data: config } = await supabase
      .from('configuracion')
      .select('nombre, activo')
      .eq('id', restauranteId)
      .maybeSingle();

    if (!config?.activo) {
      return new Response(JSON.stringify({ error: 'Restaurante inactivo' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ── Validación server-side de distancia ──────────────────────────────────
    const rLat  = parseFloat(conexion.latitud);
    const rLon  = parseFloat(conexion.longitud);
    const radio = parseInt(conexion.radio_aviso) || 200;
    const distM = haversineMetros(uLat, uLon, rLat, rLon);

    if (distM > radio) {
      return new Response(JSON.stringify({
        ok: false, mensaje: 'Fuera de rango', distanciaMetros: Math.round(distM),
      }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // ── Registrar métrica ────────────────────────────────────────────────────
    try {
      const { error: errorMetrica } = await supabase.from('metricas_proximidad').insert([{
        restaurante_id:    restauranteId,
        restaurante:       config.nombre,
        distancia:         Math.round(distM),
        dentro_del_rango_800: distM <= 800,
        es_exito_total:    true,
        origen:            'geofence_push',
      }]);
      if (errorMetrica) console.warn('Error métrica:', errorMetrica.message);
    } catch (err: any) {
      console.warn('Error métrica:', err?.message ?? err);
    }

    // ── Construir payload del push ────────────────────────────────────────────
    const puntosLlegada = conexion.puntos_llegada ?? 2;
    const pushPayload = JSON.stringify({
      restauranteId,
      restauranteNombre: config.nombre,
      titulo:   `¡Estás cerca de ${config.nombre}! 📍`,
      cuerpo:   `${conexion.mensaje_promo || 'Confirma tu llegada'} y gana +${puntosLlegada} puntos.`,
      urlMenu:  `${appUrl}/?r=${restauranteId}`,
      icono:    '/icons/icon-192.png',
      puntosLlegada,
    });

    // ── Enviar push ───────────────────────────────────────────────────────────
    webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);

    const subsToNotify = subscription ? [subscription] : [];

    // Si no viene suscripción inline, buscar únicamente las suscripciones
    // registradas para ESTE restaurante (segmentación correcta).
    if (subsToNotify.length === 0) {
      const { data: subs, error: errorSubs } = await supabase
        .from('push_subscriptions')
        .select('subscription_json')
        .eq('restaurante_id', restauranteId);

      if (errorSubs) {
        console.error('[check-geofence] Error consultando suscripciones:', errorSubs.message);
      } else if (subs?.length) {
        subsToNotify.push(...subs.map((s: any) => s.subscription_json));
      }
    }

    if (subsToNotify.length === 0) {
      return new Response(JSON.stringify({
        ok: true, mensaje: 'En rango pero sin suscripciones push registradas',
        distanciaMetros: Math.round(distM),
      }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const resultados = await Promise.allSettled(
      subsToNotify.map((sub: any) =>
        webpush.sendNotification(sub, pushPayload, { TTL: 86_400, urgency: 'normal' })
      )
    );

    const enviados = resultados.filter(r => r.status === 'fulfilled').length;
    const fallidos = resultados.filter(r => r.status === 'rejected').length;

    if (fallidos > 0) {
      resultados
        .filter(r => r.status === 'rejected')
        .forEach(r => console.error('[push] Error enviando:', (r as any).reason?.message));
    }

    return new Response(JSON.stringify({
      ok: true, distanciaMetros: Math.round(distM), enviados, fallidos,
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (err: any) {
    console.error('[check-geofence] Error inesperado:', err?.message ?? err);
    return new Response(JSON.stringify({ error: `Error interno: ${err?.message ?? 'desconocido'}` }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
