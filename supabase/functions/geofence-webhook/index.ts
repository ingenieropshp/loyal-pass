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

import { createClient } from 'jsr:@supabase/supabase-js@2';

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
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  let body: PayloadGeofence;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, motivo: 'json_invalido' }), { status: 400 });
  }

  const restauranteId = body.identifier;
  const deviceId = body.payload?.deviceId;
  const esEntrada = typeof body.enter === 'boolean'
    ? body.enter
    : String(body.transition).toLowerCase() === 'enter';

  if (!restauranteId || !deviceId) {
    return new Response(JSON.stringify({ ok: false, motivo: 'payload_incompleto' }), { status: 400 });
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
    return new Response(JSON.stringify({ ok: false, motivo: 'cliente_no_resuelto' }), { status: 404 });
  }

  const { data, error } = await supabaseAdmin.rpc('fn_evento_geocerca', {
    p_cliente_id: dispositivo.cliente_id,
    p_restaurante_id: restauranteId,
    p_tipo: esEntrada ? 'entrada' : 'salida',
  });

  if (error) {
    console.error('[geofence-webhook] error en fn_evento_geocerca:', error);
    return new Response(JSON.stringify({ ok: false, motivo: 'error_interno' }), { status: 500 });
  }

  // TODO: si `data.bonificado` es true, disparar acá el push FCM real
  // (el listener JS en foreground ya muestra su propia notificación local;
  // este webhook es el que cubre el caso de la app cerrada/en background).

  return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
});
