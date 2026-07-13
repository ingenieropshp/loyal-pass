/**
 * send-proximity-notification/index.ts — v2.0
 * Fixes:
 *  - metricas_proximidad: columnas correctas (distancia_metros, exito)
 *  - SUPABASE_SECRET_KEYS: compatible nuevo y legacy formato
 *  - mensaje_geofence: usado en el cuerpo del push
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import webpush          from 'https://esm.sh/web-push@3.6.7';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status, headers: { ...CORS, 'Content-Type': 'application/json' },
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

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Método no permitido' }, 405);

  const SUPABASE_URL    = Deno.env.get('SUPABASE_URL');
  const SERVICE_ROLE_KEY = getServiceRoleKey();
  const VAPID_PUBLIC    = Deno.env.get('VAPID_PUBLIC_KEY');
  const VAPID_PRIVATE   = Deno.env.get('VAPID_PRIVATE_KEY');
  const VAPID_SUBJECT   = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:admin@bistroconnect.com';
  const APP_URL         = Deno.env.get('APP_URL') ?? 'https://bistro-app.pages.dev';

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return json({ error: 'Error de configuración del servidor' }, 500);
  }
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    return json({ error: 'Faltan claves VAPID en Edge Function Secrets' }, 500);
  }

  let body: { restauranteId: string; latitudUsuario: number; longitudUsuario: number; subscription?: object | null };
  try { body = await req.json(); }
  catch { return json({ error: 'Body inválido' }, 400); }

  const { restauranteId, latitudUsuario, longitudUsuario, subscription } = body;
  if (!restauranteId || latitudUsuario == null || longitudUsuario == null) {
    return json({ error: 'Faltan campos requeridos' }, 400);
  }

  const uLat = parseFloat(String(latitudUsuario));
  const uLon = parseFloat(String(longitudUsuario));
  if (isNaN(uLat) || isNaN(uLon)) return json({ error: 'Coordenadas inválidas' }, 400);

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  const [{ data: conexion, error: e1 }, { data: config, error: e2 }] = await Promise.all([
    supabase.from('conexion')
      .select('latitud, longitud, radio_aviso, puntos_llegada, mensaje_promo, mensaje_geofence')
      .eq('restaurante_id', restauranteId).maybeSingle(),
    supabase.from('configuracion')
      .select('nombre, activo').eq('id', restauranteId).maybeSingle(),
  ]);

  if (e1 || !conexion) return json({ error: 'Restaurante no encontrado en conexion' }, 404);
  if (e2 || !config)   return json({ error: 'Restaurante no encontrado en configuracion' }, 404);
  if (!config.activo)  return json({ error: 'Restaurante inactivo' }, 403);

  const rLat  = parseFloat(conexion.latitud);
  const rLon  = parseFloat(conexion.longitud);
  const radio = parseInt(conexion.radio_aviso) || 200;
  const distM = distanciaMetros(uLat, uLon, rLat, rLon);

  // ── FIX Bug 1: columnas correctas ────────────────────────────────────────────
  supabase.from('metricas_proximidad').insert([{
    restaurante_id:   restauranteId,
    distancia_metros: Math.round(distM),   // ← correcto
    exito:            distM <= radio,       // ← correcto
    origen:           'geofence_push',
  }]).then(({ error }) => {
    if (error) console.warn('[send-proximity] Error métrica:', error.message);
  });

  if (distM > radio) {
    return json({ ok: false, mensaje: 'Fuera de rango', distanciaMetros: Math.round(distM) });
  }

  const puntosLlegada = conexion.puntos_llegada ?? 2;

  // ── Usar mensaje_geofence configurado por el admin ────────────────────────
  const mensajeCuerpo = conexion.mensaje_geofence?.trim()
    || conexion.mensaje_promo?.trim()
    || 'Confirma tu llegada';

  const pushPayload = JSON.stringify({
    titulo:           `¡Estás cerca de ${config.nombre}! 📍`,
    cuerpo:           `${mensajeCuerpo} y gana +${puntosLlegada} puntos.`,
    icono:            '/icons/icon-192.png',
    urlMenu:          `${APP_URL}/?r=${restauranteId}`,
    restauranteId,
    puntosLlegada,
    restauranteNombre: config.nombre,
  });

  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

  const suscripciones: object[] = [];
  if (subscription) {
    suscripciones.push(subscription);
  } else {
    const { data: rows } = await supabase
      .from('push_subscriptions')
      .select('subscription_json')
      .eq('restaurante_id', restauranteId)
      .limit(50);
    if (rows?.length) suscripciones.push(...rows.map((r: any) => r.subscription_json));
  }

  if (suscripciones.length === 0) {
    return json({ ok: true, mensaje: 'En rango, sin suscripciones push', distanciaMetros: Math.round(distM) });
  }

  const resultados = await Promise.allSettled(
    suscripciones.map(sub =>
      webpush.sendNotification(sub as webpush.PushSubscription, pushPayload, { TTL: 86_400 })
    )
  );

  const enviados = resultados.filter(r => r.status === 'fulfilled').length;
  const fallidos = resultados.filter(r => r.status === 'rejected') as PromiseRejectedResult[];

  for (const f of fallidos) {
    if (f.reason?.statusCode === 410 && f.reason?.endpoint) {
      await supabase.from('push_subscriptions').delete()
        .eq('endpoint' as never, f.reason.endpoint);
    }
  }

  return json({ ok: true, distanciaMetros: Math.round(distM), enviados, fallidos: fallidos.length });
});
