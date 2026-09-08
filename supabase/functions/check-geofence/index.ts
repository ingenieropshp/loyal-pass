/**
 * check-geofence/index.ts — v4.0
 * Fixes v3.0:
 *  - metricas_proximidad: columnas correctas (distancia_metros, exito)
 *  - SUPABASE_SECRET_KEYS: compatible con nuevo y legacy formato
 *  - mensaje_geofence: leído de conexion para el payload del push
 *
 * Cambios v4.0 (notificaciones personalizadas):
 *  - Ahora acepta un `clienteId` opcional en el body. Cuando llega:
 *      1. Se guarda en el INSERT de `metricas_proximidad` (columna
 *         cliente_id ya existe en la tabla — antes esta función la dejaba
 *         siempre en null).
 *      2. En vez de mandar el push genérico "¡Estás cerca de X!" a TODAS
 *         las suscripciones de esa sede (comportamiento viejo), se busca
 *         SOLO la(s) suscripción(es) de push_subscriptions de ESE cliente
 *         (por cliente_id) y se hace un JOIN con `clientes` para leer su
 *         nombre y saludarlo: "Hola {nombre}, estás cerca de {sede}!".
 *  - Si NO llega clienteId (compatibilidad con llamadores viejos) o si el
 *    cliente resuelto no tiene ninguna suscripción guardada todavía, se
 *    mantiene el comportamiento anterior tal cual: si viene `subscription`
 *    en el body se usa esa directamente; si no, se hace broadcast genérico
 *    (sin nombre) a todas las suscripciones de la sede.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import webpush from 'https://esm.sh/web-push@3.6.7';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

// ── Compatible con legacy SUPABASE_SERVICE_ROLE_KEY y nuevo SUPABASE_SECRET_KEYS
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
  if (req.method !== 'POST') return json({ error: 'Método no permitido' }, 405);

  try {
    const supabaseUrl    = Deno.env.get('SUPABASE_URL');
    const serviceRoleKey = getServiceRoleKey();
    const vapidPublicKey  = Deno.env.get('VAPID_PUBLIC_KEY');
    const vapidPrivateKey = Deno.env.get('VAPID_PRIVATE_KEY');
    const vapidSubject   = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:admin@bistroconnect.com';
    const appUrl         = Deno.env.get('APP_URL') ?? 'https://bistro-app.pages.dev';

    if (!supabaseUrl || !serviceRoleKey) {
      console.error('[check-geofence] Falta SUPABASE_URL o service role key');
      return json({ error: 'Configuración de servidor incompleta' }, 500);
    }
    if (!vapidPublicKey || !vapidPrivateKey) {
      console.error('[check-geofence] Faltan claves VAPID');
      return json({ error: 'Faltan claves VAPID en Edge Function Secrets' }, 500);
    }

    const body = await req.json();
    const { restauranteId, latitudUsuario, longitudUsuario, subscription, clienteId } = body;

    if (!restauranteId || latitudUsuario == null || longitudUsuario == null) {
      return json({ error: 'Faltan parámetros: restauranteId, latitudUsuario, longitudUsuario' }, 400);
    }

    const uLat = parseFloat(latitudUsuario);
    const uLon = parseFloat(longitudUsuario);
    if (isNaN(uLat) || isNaN(uLon)) return json({ error: 'Coordenadas inválidas' }, 400);

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false },
    });

    // ── Cargar datos del restaurante (incluir mensaje_geofence) ──────────────
    const { data: conexion, error: errConexion } = await supabase
      .from('conexion')
      .select('latitud, longitud, radio_aviso, puntos_llegada, mensaje_promo, mensaje_geofence')
      .eq('restaurante_id', restauranteId)
      .maybeSingle();

    if (errConexion || !conexion) {
      return json({ error: 'Restaurante no encontrado en conexion' }, 404);
    }

    const { data: config } = await supabase
      .from('configuracion')
      .select('nombre, activo')
      .eq('id', restauranteId)
      .maybeSingle();

    if (!config?.activo) return json({ error: 'Restaurante inactivo' }, 403);

    const rLat  = parseFloat(conexion.latitud);
    const rLon  = parseFloat(conexion.longitud);
    const radio = parseInt(conexion.radio_aviso) || 200;
    const distM = haversineMetros(uLat, uLon, rLat, rLon);

    // ── FIX Bug 1 (v3.0): columnas correctas de metricas_proximidad ──────────
    // La tabla tiene: distancia_metros (no distancia), exito (no es_exito_total)
    // No tiene: restaurante, dentro_del_rango_800
    // v4.0: si llega clienteId, se guarda también — antes quedaba siempre en
    // null aunque la columna ya existía en la tabla.
    supabase.from('metricas_proximidad').insert([{
      restaurante_id:   restauranteId,
      distancia_metros: Math.round(distM),        // ← columna correcta
      exito:            distM <= radio,            // ← columna correcta
      origen:           'geofence_push',
      cliente_id:       clienteId ?? null,          // ← NUEVO
    }]).then(({ error }) => {
      if (error) console.warn('[check-geofence] Error métrica:', error.message);
    });

    if (distM > radio) {
      return json({ ok: false, mensaje: 'Fuera de rango', distanciaMetros: Math.round(distM) });
    }

    const puntosLlegada = conexion.puntos_llegada ?? 2;

    // ── Usar mensaje_geofence si existe, si no mensaje_promo ──────────────────
    const mensajeCuerpo = conexion.mensaje_geofence?.trim()
      || conexion.mensaje_promo?.trim()
      || 'Confirma tu llegada';

    // ── v4.0: si conocemos al cliente, buscamos su nombre para saludarlo ─────
    // (JOIN manual: push_subscriptions.cliente_id → clientes.id). Si no hay
    // clienteId, o el cliente no tiene fila en `clientes` con ese id, se cae
    // al mensaje genérico de siempre (sin nombre).
    let nombreCliente: string | null = null;
    if (clienteId) {
      const { data: cliente } = await supabase
        .from('clientes')
        .select('nombre')
        .eq('id', clienteId)
        .maybeSingle();
      nombreCliente = cliente?.nombre ?? null;
    }

    const tituloPush = nombreCliente
      ? `¡Hola ${nombreCliente}! Estás cerca de ${config.nombre} 📍`
      : `¡Estás cerca de ${config.nombre}! 📍`;

    const pushPayload = JSON.stringify({
      titulo:           tituloPush,
      cuerpo:           `${mensajeCuerpo} y gana +${puntosLlegada} puntos.`,
      icono:            '/icons/icon-192.png',
      urlMenu:          `${appUrl}/?r=${restauranteId}`,
      restauranteId,
      puntosLlegada,
      restauranteNombre: config.nombre,
    });

    webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);

    const subsToNotify: object[] = [];

    if (subscription) {
      // Llamador que ya trae su propia suscripción en mano (ej. una prueba
      // manual, o un flujo que la resolvió del lado del cliente): se respeta
      // tal cual, sin tocar nada más.
      subsToNotify.push(subscription);
    } else if (clienteId) {
      // ── v4.0: targeting por cliente, no broadcast a toda la sede ──────────
      // Solo se notifica a ESTE cliente (JOIN implícito vía cliente_id, que
      // ya guardamos en push_subscriptions al registrar la suscripción — ver
      // save-push-subscription/index.ts). Si el cliente no tiene ninguna
      // suscripción guardada, subsToNotify queda vacío y no se envía nada —
      // correcto: no hay a quién avisarle.
      const { data: subsCliente, error: errSubsCliente } = await supabase
        .from('push_subscriptions')
        .select('subscription_json')
        .eq('cliente_id', clienteId);

      if (errSubsCliente) console.warn('[check-geofence] Error suscripción del cliente:', errSubsCliente.message);
      if (subsCliente?.length) subsToNotify.push(...subsCliente.map((s: any) => s.subscription_json));
    } else {
      // Comportamiento legacy (sin clienteId): broadcast genérico a todas
      // las suscripciones de la sede, sin personalizar por nombre.
      const { data: subs, error: errorSubs } = await supabase
        .from('push_subscriptions')
        .select('subscription_json')
        .eq('restaurante_id', restauranteId);

      if (errorSubs) console.warn('[check-geofence] Error suscripciones:', errorSubs.message);
      if (subs?.length) subsToNotify.push(...subs.map((s: any) => s.subscription_json));
    }

    if (subsToNotify.length === 0) {
      return json({ ok: true, mensaje: 'En rango, sin suscripciones push', distanciaMetros: Math.round(distM) });
    }

    const resultados = await Promise.allSettled(
      subsToNotify.map((sub: any) =>
        webpush.sendNotification(sub, pushPayload, { TTL: 86_400, urgency: 'normal' })
      )
    );

    const enviados = resultados.filter(r => r.status === 'fulfilled').length;
    const fallidos = resultados.filter(r => r.status === 'rejected') as PromiseRejectedResult[];

    for (const f of fallidos) {
      console.error('[push-error]', f.reason?.message);
      if (f.reason?.statusCode === 410 && f.reason?.endpoint) {
        await supabase.from('push_subscriptions').delete()
          .eq('endpoint' as never, f.reason.endpoint);
      }
    }

    return json({ ok: true, distanciaMetros: Math.round(distM), enviados, fallidos: fallidos.length, personalizado: !!nombreCliente });

  } catch (err: any) {
    console.error('[check-geofence] Error inesperado:', err?.message ?? err);
    return json({ error: `Error interno: ${err?.message ?? 'desconocido'}` }, 500);
  }
});
