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
//
// v2 (push FCM real al bonificar): cuando fn_evento_geocerca devuelve
// bonificado=true, este webhook ahora SÍ dispara el push nativo FCM al
// dispositivo que originó el evento. Antes solo había un comentario TODO acá
// y nunca se enviaba nada — justo el caso (app cerrada/background) para el
// que existe este webhook aparte del listener JS en foreground, que sí
// muestra su propia notificación local.
//
// El token FCM real vive en `device_push_tokens.fcm_token`, indexado por
// `device_id` — NO en `dispositivos_clientes.device_id` (ese es solo el
// identificador físico del dispositivo, usado arriba para resolver
// cliente_id). Mismo bug de fondo que se encontró y corrigió en
// fn_clientes_puntos_por_vencer (usado por alertas-vencimiento-puntos): ahí
// se mandaba el device_id crudo a FCM como si fuera un token, y FCM lo
// rechazaba siempre.
//
// v3 (sonido predeterminado del sistema — pedido explícito del usuario):
// se agrega `android.notification.sound: 'default'` al payload de FCM para
// que el push suene con el tono predeterminado del dispositivo Android al
// llegar, en vez de solo vibrar/aparecer en silencio.
//
// NOTA TÉCNICA: la API HTTP v1 de FCM NO acepta un campo `sound` dentro del
// bloque genérico `message.notification` (ese objeto solo admite
// title/body/image — un campo desconocido ahí hace que FCM rechace TODO el
// mensaje con 400 "Cannot find field"). El sonido se configura por
// plataforma: en Android va en `message.android.notification.sound`, que es
// justo lo que se agrega abajo. Como esta app solo se distribuye en Android
// por ahora (iOS pospuesto, ver README del proyecto), no se agrega el
// bloque `apns` — si en el futuro se habilita iOS, el mismo sonido se
// configura en `message.apns.payload.aps.sound`.
//
// v4 (rediseño de CuentaScreen.jsx — toggle "Proximidad GPS"): antes de
// enviar el push se consulta `clientes.notif_proximidad_activa` y, si el
// cliente lo desactivó desde su perfil, se omite el envío (los puntos se
// siguen acreditando igual — ver el comentario de notificarBonoGeocerca).
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { SignJWT, importPKCS8 } from 'https://esm.sh/jose@5';

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

// ── FCM (HTTP v1) — mismo mecanismo que alertas-vencimiento-puntos/index.ts:
// JWT firmado con la cuenta de servicio de Firebase, canjeado por un
// access_token OAuth2. Se duplica acá (en vez de importar desde la otra
// función) porque cada Edge Function de Supabase se despliega y empaqueta
// de forma aislada — no comparten módulos entre sí a menos que se use un
// import_map con un archivo compartido, que este proyecto no tiene
// configurado todavía.
function decodificarServiceAccount(raw: string): Record<string, string> {
  const valor = raw.trim();
  if (valor.startsWith('{')) return JSON.parse(valor);

  const binario = atob(valor);
  const bytes = Uint8Array.from(binario, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function obtenerTokenAccesoFCM(secretoCrudo: string): Promise<string> {
  const cuenta = decodificarServiceAccount(secretoCrudo);
  const clavePrivada = await importPKCS8(cuenta.private_key, 'RS256');

  const jwt = await new SignJWT({
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
  })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuedAt()
    .setIssuer(cuenta.client_email)
    .setSubject(cuenta.client_email)
    .setAudience('https://oauth2.googleapis.com/token')
    .setExpirationTime('1h')
    .sign(clavePrivada);

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  if (!resp.ok) throw new Error(`No se pudo obtener token FCM: ${await resp.text()}`);
  const data = await resp.json();
  return data.access_token as string;
}

async function enviarPushFCM(
  accessToken: string,
  projectId: string,
  tokenDispositivo: string,
  titulo: string,
  cuerpo: string,
) {
  const resp = await fetch(
    `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          token: tokenDispositivo,
          notification: { title: titulo, body: cuerpo },
          // Sonido predeterminado del sistema al recibir el push (Android).
          // Ver nota técnica arriba del archivo sobre por qué va acá y no
          // dentro de `notification`.
          android: {
            notification: { sound: 'default' },
          },
        },
      }),
    },
  );
  const data = await resp.json().catch(() => null);
  return { ok: resp.ok, status: resp.status, data };
}

// Busca el token FCM del dispositivo y, si existe, envía el push del bono de
// geocerca. Nunca lanza: cualquier error queda solo en logs, porque los
// puntos ya se acreditaron en fn_evento_geocerca antes de llegar acá — un
// fallo de push jamás debe reflejarse como un error del webhook.
//
// v4 (preferencia de notificación del cliente — CuentaScreen.jsx, toggle
// "Proximidad GPS"): antes de mandar el push se revisa
// `clientes.notif_proximidad_activa`. Si el cliente lo apagó, los puntos
// se acreditan exactamente igual (eso ya pasó en fn_evento_geocerca, antes
// de llegar a esta función) — el toggle solo controla si se le avisa por
// push, nunca si gana los puntos.
async function notificarBonoGeocerca(deviceId: string, restauranteId: string, clienteId: string, puntos: number): Promise<void> {
  try {
    const { data: filaCliente, error: errCliente } = await supabaseAdmin
      .from('clientes')
      .select('notif_proximidad_activa')
      .eq('id', clienteId)
      .maybeSingle();

    if (errCliente) {
      console.error('[geofence-webhook] Error consultando preferencia de notificación:', errCliente.message);
      // Ante la duda, seguimos e intentamos avisar — más vale un push de
      // más que dejar a alguien sin su alerta por un error de lectura.
    } else if (filaCliente?.notif_proximidad_activa === false) {
      return;
    }

    const { data: tokenRow, error: errToken } = await supabaseAdmin
      .from('device_push_tokens')
      .select('fcm_token')
      .eq('device_id', deviceId)
      .maybeSingle();

    if (errToken) {
      console.error('[geofence-webhook] Error consultando device_push_tokens:', errToken.message);
      return;
    }
    if (!tokenRow?.fcm_token) {
      // Dispositivo sin token FCM registrado (ej. nunca abrió la app o
      // rechazó el permiso de notificaciones) — no es un error, simplemente
      // no hay a quién avisarle desde el backend.
      return;
    }

    const serviceAccountRaw = Deno.env.get('FCM_SERVICE_ACCOUNT_JSON');
    const projectId = Deno.env.get('FCM_PROJECT_ID');
    if (!serviceAccountRaw || !projectId) {
      console.error('[geofence-webhook] Faltan FCM_SERVICE_ACCOUNT_JSON o FCM_PROJECT_ID en Edge Function Secrets');
      return;
    }

    const { data: restaurante } = await supabaseAdmin
      .from('configuracion')
      .select('nombre')
      .eq('id', restauranteId)
      .maybeSingle();
    const nombreRestaurante = restaurante?.nombre ?? 'el restaurante';

    const accessToken = await obtenerTokenAccesoFCM(serviceAccountRaw);
    const resultado = await enviarPushFCM(
      accessToken,
      projectId,
      tokenRow.fcm_token,
      `¡Ganaste ${puntos} puntos! 🎉`,
      `Se acreditaron ${puntos} puntos por tu visita a ${nombreRestaurante}.`,
    );

    if (!resultado.ok) {
      console.error('[geofence-webhook] FCM rechazó el envío:', resultado.status, resultado.data);
    }
  } catch (err) {
    console.error('[geofence-webhook] Error enviando push FCM:', err);
  }
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

  // Se espera (await) el envío del push antes de responder: es un webhook
  // de background disparado por el SO, no una UI que el usuario esté
  // mirando, así que no hay razón para arriesgar una respuesta "bonificado:
  // true" sin haber intentado avisarle de verdad. Cualquier error queda
  // contenido dentro de notificarBonoGeocerca (nunca lanza).
  if (data?.bonificado && typeof data?.puntos === 'number' && data.puntos > 0) {
    await notificarBonoGeocerca(deviceId, restauranteId, dispositivo.cliente_id, data.puntos);
  }

  return jsonResponse(data, 200);
});
