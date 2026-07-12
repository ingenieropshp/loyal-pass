/**
 * send-proximity-notification/index.ts
 * Supabase Edge Function — Deno Runtime
 *
 * Recibe los datos de un restaurante y envía Web Push a todas las
 * suscripciones activas (o a una suscripción específica).
 *
 * PAYLOAD que envía al Service Worker (campos exactos que espera sw.js):
 * {
 *   titulo:            string   → showNotification(titulo, ...)
 *   cuerpo:            string   → options.body
 *   icono:             string   → options.icon
 *   urlMenu:           string   → options.data.url  (se abre al tocar)
 *   restauranteId:     string   → options.tag + options.data.restauranteId
 *   puntosLlegada:     number   → texto del botón "Ver Menú ☕ (+N pts)"
 * }
 *
 * Variables de entorno requeridas (Supabase → Edge Functions → Secrets):
 *   VAPID_PUBLIC_KEY   → clave pública generada con web-push
 *   VAPID_PRIVATE_KEY  → clave privada
 *   VAPID_SUBJECT      → "mailto:tu@correo.com"
 *   APP_URL            → "https://bistro-app.pages.dev"
 *
 * Variables inyectadas automáticamente por Supabase (NO agregar en Secrets):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient }  from 'https://esm.sh/@supabase/supabase-js@2';
import webpush           from 'https://esm.sh/web-push@3.6.7';

// ── CORS — permite llamadas desde el frontend en Cloudflare Pages ─────────────
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });

// ── Haversine (metros) ────────────────────────────────────────────────────────
function distanciaMetros(lat1: number, lon1: number, lat2: number, lon2: number) {
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

// ── Handler ───────────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST')    return json({ error: 'Método no permitido' }, 405);

  // ── 1. Validar variables de entorno ─────────────────────────────────────────
  const SUPABASE_URL     = Deno.env.get('SUPABASE_URL');
  const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const VAPID_PUBLIC     = Deno.env.get('VAPID_PUBLIC_KEY');
  const VAPID_PRIVATE    = Deno.env.get('VAPID_PRIVATE_KEY');
  const VAPID_SUBJECT    = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:admin@bistroconnect.com';
  const APP_URL          = Deno.env.get('APP_URL')        ?? 'https://bistro-app.pages.dev';

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    console.error('[send-proximity-notification] Faltan variables de Supabase (auto-inyectadas)');
    return json({ error: 'Error de configuración del servidor' }, 500);
  }
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    console.error('[send-proximity-notification] Faltan VAPID_PUBLIC_KEY o VAPID_PRIVATE_KEY en Secrets');
    return json({ error: 'Faltan claves VAPID. Agrégalas en Edge Functions → Secrets' }, 500);
  }

  // ── 2. Parsear body de la request ───────────────────────────────────────────
  let body: {
    restauranteId:   string;
    latitudUsuario:  number;
    longitudUsuario: number;
    subscription?:   object | null;  // suscripción directa (opcional)
  };

  try {
    body = await req.json();
  } catch {
    return json({ error: 'Body inválido. Se esperaba JSON.' }, 400);
  }

  const { restauranteId, latitudUsuario, longitudUsuario, subscription } = body;

  if (!restauranteId || latitudUsuario == null || longitudUsuario == null) {
    return json({ error: 'Faltan campos: restauranteId, latitudUsuario, longitudUsuario' }, 400);
  }

  const uLat = parseFloat(String(latitudUsuario));
  const uLon = parseFloat(String(longitudUsuario));
  if (isNaN(uLat) || isNaN(uLon)) return json({ error: 'Coordenadas inválidas' }, 400);

  // ── 3. Consultar restaurante en Supabase ────────────────────────────────────
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const [{ data: conexion, error: e1 }, { data: config, error: e2 }] = await Promise.all([
    supabase
      .from('conexion')
      .select('latitud, longitud, radio_aviso, puntos_llegada, mensaje_promo')
      .eq('restaurante_id', restauranteId)
      .maybeSingle(),
    supabase
      .from('configuracion')
      .select('nombre, activo')
      .eq('id', restauranteId)
      .maybeSingle(),
  ]);

  if (e1 || !conexion) return json({ error: 'Restaurante no encontrado en tabla conexion' }, 404);
  if (e2 || !config)   return json({ error: 'Restaurante no encontrado en tabla configuracion' }, 404);
  if (!config.activo)  return json({ error: 'Restaurante inactivo' }, 403);

  // ── 4. Validar distancia server-side (anti-spoofing) ───────────────────────
  const rLat  = parseFloat(conexion.latitud);
  const rLon  = parseFloat(conexion.longitud);
  const radio = parseInt(conexion.radio_aviso) || 200;
  const distM = distanciaMetros(uLat, uLon, rLat, rLon);

  // Registrar métrica siempre (no bloquear si falla)
  supabase.from('metricas_proximidad').insert([{
    restaurante_id:     restauranteId,
    restaurante:        config.nombre,
    distancia:          Math.round(distM),
    dentro_del_rango_800: distM <= 800,
    es_exito_total:     distM <= radio,
    origen:             'geofence_push',
  }]).then(({ error }) => {
    if (error) console.warn('[métrica]', error.message);
  });

  if (distM > radio) {
    return json({ ok: false, mensaje: 'Usuario fuera de rango', distanciaMetros: Math.round(distM) });
  }

  // ── 5. Construir el payload ─────────────────────────────────────────────────
  // IMPORTANTE: los nombres de campo deben coincidir EXACTAMENTE con sw.js
  const puntosLlegada = conexion.puntos_llegada ?? 2;
  const urlMenu       = `${APP_URL}/?r=${restauranteId}`;

  const pushPayload = JSON.stringify({
    // ── Campos que lee sw.js (NO cambiar nombres) ──────────────────────────
    titulo:         `¡Estás cerca de ${config.nombre}! 📍`,
    cuerpo:         `${conexion.mensaje_promo || 'Confirma tu llegada'} y gana +${puntosLlegada} puntos.`,
    icono:          '/icons/icon-192.png',
    urlMenu,                        // → options.data.url  → abre al tocar notif
    restauranteId,                  // → options.tag + options.data.restauranteId
    puntosLlegada,                  // → botón "Ver Menú ☕ (+N pts)"
    // ── Campos extra (para analytics, ignorados por sw.js) ─────────────────
    restauranteNombre: config.nombre,
    distanciaMetros:   Math.round(distM),
  });

  // ── 6. Configurar VAPID ─────────────────────────────────────────────────────
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

  // ── 7. Recopilar suscripciones ──────────────────────────────────────────────
  // Prioridad: suscripción inline (enviada por el cliente) > tabla push_subscriptions
  const suscripciones: object[] = [];

  if (subscription) {
    suscripciones.push(subscription);
  } else {
    const { data: rows, error: eSubs } = await supabase
      .from('push_subscriptions')
      .select('subscription_json')
      .limit(50); // En producción filtra por usuario autenticado

    if (eSubs) console.warn('[subs]', eSubs.message);
    if (rows?.length) suscripciones.push(...rows.map((r: { subscription_json: object }) => r.subscription_json));
  }

  if (suscripciones.length === 0) {
    return json({ ok: true, mensaje: 'En rango pero sin suscripciones push registradas', distanciaMetros: Math.round(distM) });
  }

  // ── 8. Enviar push a todas las suscripciones ────────────────────────────────
  const resultados = await Promise.allSettled(
    suscripciones.map(sub =>
      webpush.sendNotification(sub as webpush.PushSubscription, pushPayload, {
        TTL:     86_400,  // 24h: si el dispositivo está offline, reintentará
        urgency: 'normal',
      })
    )
  );

  const enviados = resultados.filter(r => r.status === 'fulfilled').length;
  const fallidos = resultados.filter(r => r.status === 'rejected');

  fallidos.forEach(r =>
    console.error('[push-error]', (r as PromiseRejectedResult).reason?.message ?? r)
  );

  // Limpiar suscripciones inválidas (410 Gone = el navegador la revocó)
  if (fallidos.length > 0 && !subscription) {
    for (const f of fallidos) {
      const statusCode = (f as PromiseRejectedResult).reason?.statusCode;
      const endpoint   = (f as PromiseRejectedResult).reason?.endpoint;
      if (statusCode === 410 && endpoint) {
        await supabase.from('push_subscriptions').delete().eq('endpoint' as never, endpoint);
        console.log('[push] Suscripción expirada eliminada:', endpoint);
      }
    }
  }

  return json({
    ok:              true,
    distanciaMetros: Math.round(distM),
    enviados,
    fallidos:        fallidos.length,
  });
});
