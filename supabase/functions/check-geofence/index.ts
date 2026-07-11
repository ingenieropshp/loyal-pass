/**
 * check-geofence/index.ts — Supabase Edge Function (Deno)
 *
 * Endpoint: POST /functions/v1/check-geofence
 *
 * Responsabilidades:
 *  1. Recibe restauranteId + coordenadas del cliente
 *  2. Carga los datos del restaurante desde Supabase (doble validación server-side)
 *  3. Calcula Haversine para confirmar que el cliente realmente está en rango
 *  4. Busca la suscripción push del cliente en la tabla push_subscriptions
 *  5. Envía el push notification con web-push (VAPID)
 *  6. Registra el evento en metricas_proximidad
 *
 * Variables de entorno requeridas (Supabase Dashboard → Settings → Edge Functions):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY   (para escribir en tablas con RLS)
 *   VAPID_PUBLIC_KEY
 *   VAPID_PRIVATE_KEY
 *   VAPID_SUBJECT               (ej: "mailto:admin@bistroconnect.com")
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import webpush          from 'https://esm.sh/web-push@3.6.7';

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ── Haversine (metros) ────────────────────────────────────────────────────────
function haversineMetros(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R    = 6_371_000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
    Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Handler principal ─────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  // Preflight CORS
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Método no permitido' }), {
      status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await req.json();
    const {
      restauranteId,
      latitudUsuario,
      longitudUsuario,
      subscription, // PushSubscription serializada desde el cliente (opcional)
    } = body;

    // ── Validación de entrada ────────────────────────────────────────────────
    if (!restauranteId || latitudUsuario == null || longitudUsuario == null) {
      return new Response(JSON.stringify({ error: 'Faltan parámetros requeridos' }), {
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

    // ── Cliente Supabase con service role (bypasa RLS para leer/escribir) ────
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { persistSession: false } }
    );

    // ── 1. Cargar datos del restaurante ──────────────────────────────────────
    const { data: conexion, error: errConexion } = await supabase
      .from('conexion')
      .select('latitud, longitud, radio_aviso, puntos_llegada, meta_puntos, mensaje_promo')
      .eq('restaurante_id', restauranteId)
      .maybeSingle();

    if (errConexion || !conexion) {
      return new Response(JSON.stringify({ error: 'Restaurante no encontrado' }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { data: config, error: errConfig } = await supabase
      .from('configuracion')
      .select('nombre, activo, mensaje_promo')
      .eq('id', restauranteId)
      .maybeSingle();

    if (errConfig || !config?.activo) {
      return new Response(JSON.stringify({ error: 'Restaurante inactivo' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ── 2. Validación server-side de distancia (anti-spoofing) ───────────────
    const rLat  = parseFloat(conexion.latitud);
    const rLon  = parseFloat(conexion.longitud);
    const radio = parseInt(conexion.radio_aviso) || 200;

    const distM = haversineMetros(uLat, uLon, rLat, rLon);
    const enRango = distM <= radio;

    // Registrar métrica independientemente del resultado
    await supabase.from('metricas_proximidad').insert([{
      restaurante_id:    restauranteId,
      restaurante:       config.nombre,
      distancia:         Math.round(distM),
      dentro_del_rango_800: distM <= 800,
      es_exito_total:    enRango,
      origen:            'geofence_push',
    }]).throwOnError().catch(err =>
      // No es crítico si falla la métrica
      console.warn('[check-geofence] Error insertando métrica:', err.message)
    );

    if (!enRango) {
      return new Response(JSON.stringify({
        ok: false, mensaje: 'Usuario fuera de rango', distanciaMetros: Math.round(distM),
      }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // ── 3. Construir payload del push ────────────────────────────────────────
    const puntosLlegada = conexion.puntos_llegada ?? 2;
    const urlApp        = `${Deno.env.get('APP_URL') ?? 'https://bistro-app.pages.dev'}/?r=${restauranteId}`;

    const pushPayload = JSON.stringify({
      restauranteId,
      restauranteNombre: config.nombre,
      titulo:            `¡Estás cerca de ${config.nombre}! 📍`,
      cuerpo:            `${conexion.mensaje_promo || 'Confirma tu llegada'} y gana +${puntosLlegada} puntos.`,
      urlMenu:           urlApp,
      icono:             '/icons/icon-192.png',
      badge:             '/icons/badge-72.png',
      puntosLlegada,
    });

    // ── 4. Configurar VAPID y enviar push ─────────────────────────────────────
    const vapidPublicKey  = Deno.env.get('VAPID_PUBLIC_KEY')!;
    const vapidPrivateKey = Deno.env.get('VAPID_PRIVATE_KEY')!;
    const vapidSubject    = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:admin@bistroconnect.com';

    webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);

    // Suscripción enviada directamente por el cliente (modo inline)
    const subsToNotify: object[] = [];
    if (subscription) {
      subsToNotify.push(subscription);
    } else {
      // Buscar todas las suscripciones guardadas para este dispositivo
      // (la tabla push_subscriptions la crea la Edge Function save-push-subscription)
      const { data: subs } = await supabase
        .from('push_subscriptions')
        .select('subscription_json')
        .limit(1); // en producción filtrarías por usuario autenticado
      if (subs?.length) {
        subsToNotify.push(...subs.map((s: { subscription_json: object }) => s.subscription_json));
      }
    }

    const resultados = await Promise.allSettled(
      subsToNotify.map(sub =>
        webpush.sendNotification(sub as webpush.PushSubscription, pushPayload, {
          TTL:     86_400, // 24h de TTL en los servidores push
          urgency: 'normal',
        })
      )
    );

    const enviados = resultados.filter(r => r.status === 'fulfilled').length;
    const fallidos = resultados.filter(r => r.status === 'rejected').length;

    return new Response(JSON.stringify({
      ok: true,
      distanciaMetros: Math.round(distM),
      pushEnviados:    enviados,
      pushFallidos:    fallidos,
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (err) {
    console.error('[check-geofence] Error inesperado:', err);
    return new Response(JSON.stringify({ error: 'Error interno del servidor' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
