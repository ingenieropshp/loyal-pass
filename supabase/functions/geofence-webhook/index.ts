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
//
// v5 (payload de alta prioridad + canal + datos de ruteo — configuración
// completa de push por geocerca):
//   - `android.priority: 'high'` explícito: aunque un mensaje CON bloque
//     `notification` ya usa prioridad alta por defecto en FCM, se deja
//     explícito para que Android despierte el dispositivo y muestre la
//     notificación emergente (heads-up) incluso en ahorro de batería, sin
//     depender de un comportamiento implícito de la API.
//   - `android.notification.channel_id`: se usa 'geofence-alerts' (con
//     GUION, no guion bajo) — es el MISMO canal que useGeofencing.js ya
//     crea del lado del cliente para las notificaciones locales de
//     geocerca (ver CANAL_ID_GEOFENCE). Los IDs de canal de Android son
//     case/char-sensitive y compartidos a nivel de sistema operativo entre
//     @capacitor/local-notifications y @capacitor/push-notifications: si
//     este valor no coincide EXACTO con el canal ya creado en el
//     dispositivo, Android descarta la notificación en silencio (no hay
//     error visible, simplemente no aparece). Ver usePushNotifications.js
//     para el `createChannel` del lado nativo.
//   - `android.notification.default_vibrate_timings: true`: patrón de
//     vibración por defecto del sistema.
//   - Se agrega `data` con `tipo`/`restaurante_id`/`puntos` (todos como
//     string — FCM exige que los valores de `data` sean strings) para que
//     el listener `pushNotificationActionPerformed` del cliente pueda
//     llevar al usuario directo a la sede correspondiente al tocar la
//     notificación, sin depender de un `click_action` nativo (ese campo
//     apuntaría a una Activity de Android que esta app no tiene registrada
//     — el ruteo real se resuelve en JS con este `data`).
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { SignJWT, importPKCS8 } from 'https://esm.sh/jose@5';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

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
  identifier: string;
  transition?: 'enter' | 'exit';
  enter?: boolean;
  payload?: { deviceId?: string };
}

// ── Canal de notificación nativo del cliente — DEBE coincidir carácter por
// carácter con CANAL_ID_GEOFENCE en useGeofencing.js / usePushNotifications.js.
const CANAL_ID_GEOFENCE = 'geofence-alerts';

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
  datos: Record<string, string>,
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
          android: {
            priority: 'high',
            notification: {
              sound: 'default',
              channel_id: CANAL_ID_GEOFENCE,
              default_vibrate_timings: true,
            },
          },
          data: datos,
        },
      }),
    },
  );
  const data = await resp.json().catch(() => null);
  return { ok: resp.ok, status: resp.status, data };
}

async function notificarBonoGeocerca(deviceId: string, restauranteId: string, clienteId: string, puntos: number): Promise<void> {
  try {
    const { data: filaCliente, error: errCliente } = await supabaseAdmin
      .from('clientes')
      .select('notif_proximidad_activa')
      .eq('id', clienteId)
      .maybeSingle();

    if (errCliente) {
      console.error('[geofence-webhook] Error consultando preferencia de notificación:', errCliente.message);
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
      {
        tipo: 'GEOCERCA_PROXIMIDAD',
        restaurante_id: restauranteId,
        puntos: String(puntos),
      },
    );

    if (!resultado.ok) {
      console.error('[geofence-webhook] FCM rechazó el envío:', resultado.status, resultado.data);
    }
  } catch (err) {
    console.error('[geofence-webhook] Error enviando push FCM:', err);
  }
}

Deno.serve(async (req) => {
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

  if (data?.bonificado && typeof data?.puntos === 'number' && data.puntos > 0) {
    await notificarBonoGeocerca(deviceId, restauranteId, dispositivo.cliente_id, data.puntos);
  }

  return jsonResponse(data, 200);
});
