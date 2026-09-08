// supabase/functions/geofence-webhook/index.ts
//
// Recibe el POST nativo que @capgo/background-geolocation dispara cuando el
// WebView está suspendido (app en background/cerrada) — es el
// `GEOFENCE_WEBHOOK_URL` que ya referencia src1/src/hooks/useGeofencing.js.
// Traduce el payload del plugin a una llamada al RPC `fn_evento_geocerca`
// (PL/pgSQL) que es quien decide si corresponde pagar el bono de 200 pts.
//
// La generación de puntos vive en la base de datos (transaccional, con
// bloqueo de filas para el FIFO de redención) — esta función es solo el
// punto de entrada HTTP; no reimplementa ninguna regla de negocio acá.
//
// FIX CORS (encontrado auditando por qué "Piere Steven" no recibió los 200
// pts de proximidad al registrarse): este archivo NUNCA mandó cabeceras
// Access-Control-Allow-* ni manejó OPTIONS. El POST nativo del plugin (app
// cerrada) no pasa por un navegador, así que nunca le importó CORS — pero
// CUALQUIER llamada hecha desde un navegador o un WebView de Capacitor
// (enviarEventoGeocercaWebhook en useGeofencing.js, y el chequeo de
// proximidad de SuccessCard en manejarRegistro.jsx) SÍ dispara un preflight
// OPTIONS antes del POST real. Sin cabeceras CORS, ese preflight fallaba (o
// el propio "Method not allowed" de abajo lo rechazaba con 405) y el
// navegador bloqueaba el POST verdadero ANTES de que saliera a la red — por
// eso ni siquiera aparecía en los logs de Supabase: la petición nunca llegó
// a salir del navegador.
import { createClient } from 'jsr:@supabase/supabase-js@2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Helper para no repetir `{ ...CORS_HEADERS, 'Content-Type': 'application/json' }`
// en cada return — TODA respuesta (éxito o error) necesita las cabeceras CORS,
// no solo el preflight: el navegador también revisa Access-Control-Allow-Origin
// en la respuesta real, no solo en el OPTIONS.
function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

const supabaseAdmin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

interface PayloadGeofence {
  identifier: string;               // restaurante_id (ver mapearAComercios en useGeofencing.js)
  transition?: 'enter' | 'exit';
  enter?: boolean;
  payload?: { deviceId?: string };
}

Deno.serve(async (req) => {
  // Preflight: el navegador manda esto ANTES del POST real para preguntar
  // "¿me dejas hacer esta petición cross-origin?". Debe responder rápido,
  // sin cuerpo, con las cabeceras CORS — 204 No Content es lo estándar.
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
  }

  let body: PayloadGeofence;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ ok: false, motivo: 'json_invalido' }, 400);
  }

  const restauranteId = body.identifier;
  const deviceId = body.payload?.deviceId;
  const esEntrada = typeof body.enter === 'boolean'
    ? body.enter
    : String(body.transition).toLowerCase() === 'enter';

  if (!restauranteId || !deviceId) {
    return jsonResponse({ ok: false, motivo: 'payload_incompleto' }, 400);
  }

  // El deviceId identifica el dispositivo, no directamente al cliente. Es
  // multi-tenant por sede (el mismo dispositivo puede tener una fila de
  // `clientes` distinta por restaurante), así que se resuelve por el par
  // (device_id, restaurante_id) — ver migracion_fidelizacion.sql y el
  // upsert en useGeofencing.js (app cliente, en foreground).
  const { data: dispositivo, error: errDispositivo } = await supabaseAdmin
    .from('dispositivos_clientes')
    .select('cliente_id')
    .eq('device_id', deviceId)
    .eq('restaurante_id', restauranteId)
    .maybeSingle();

  if (errDispositivo || !dispositivo?.cliente_id) {
    return jsonResponse({ ok: false, motivo: 'cliente_no_resuelto' }, 404);
  }

  const { data, error } = await supabaseAdmin.rpc('fn_evento_geocerca', {
    p_cliente_id: dispositivo.cliente_id,
    p_restaurante_id: restauranteId,
    p_tipo: esEntrada ? 'entrada' : 'salida',
  });

  if (error) {
    console.error('[geofence-webhook] error en fn_evento_geocerca:', error);
    return jsonResponse({ ok: false, motivo: 'error_interno' }, 500);
  }

  // TODO: si `data.bonificado` es true, disparar acá el push FCM real
  // (el listener JS en foreground ya muestra su propia notificación local;
  // este webhook es el que cubre el caso de la app cerrada/en background).

  return jsonResponse(data, 200);
});
