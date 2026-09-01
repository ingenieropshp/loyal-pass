// supabase/functions/geofence-webhook/index.ts
// ───────────────────────────────────────────────────────────────────────
// Recibe el POST nativo que manda @capgo/background-geolocation cuando una
// geocerca se dispara con el WebView suspendido (app en background o
// cerrada). Busca el token FCM del dispositivo y le envía una notificación
// push real vía Firebase Cloud Messaging (API HTTP v1) — a diferencia de
// LocalNotifications, esto SÍ funciona con la app completamente cerrada,
// porque la entrega la corre el sistema operativo, no el JS de la app.
//
// Body esperado (según GeofenceTransitionEvent del plugin):
//   {
//     identifier: string,          // restaurante_id
//     transition: 'enter' | 'exit',
//     enter: boolean,
//     latitude, longitude, radius,
//     payload: { deviceId: string } // el que mandamos en setupGeofencing()
//   }
//
// Variables de entorno necesarias (Supabase → Project Settings → Edge
// Functions → Secrets):
//   SUPABASE_URL                 (ya la inyecta Supabase automáticamente)
//   SUPABASE_SERVICE_ROLE_KEY    (ya la inyecta Supabase automáticamente)
//   FCM_PROJECT_ID               ID del proyecto de Firebase
//   FCM_SERVICE_ACCOUNT_JSON     contenido completo del JSON de la cuenta
//                                 de servicio de Firebase (Project Settings
//                                 → Service accounts → Generate new private key)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const FCM_PROJECT_ID = Deno.env.get('FCM_PROJECT_ID')!;
const FCM_SERVICE_ACCOUNT_JSON = Deno.env.get('FCM_SERVICE_ACCOUNT_JSON')!;

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ── Auth de Google (JWT firmado con la cuenta de servicio → access_token) ──
let cachedAccessToken: { token: string; expiraEn: number } | null = null;

function base64url(input: ArrayBuffer | string): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input);
  let binary = '';
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function obtenerAccessTokenFCM(): Promise<string> {
  if (cachedAccessToken && Date.now() < cachedAccessToken.expiraEn) {
    return cachedAccessToken.token;
  }

  const cuenta = JSON.parse(FCM_SERVICE_ACCOUNT_JSON);
  const ahora = Math.floor(Date.now() / 1000);

  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: cuenta.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: ahora,
    exp: ahora + 3600,
  };

  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;

  const clavePem = cuenta.private_key
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s/g, '');
  const claveBytes = Uint8Array.from(atob(clavePem), (c) => c.charCodeAt(0));

  const claveCripto = await crypto.subtle.importKey(
    'pkcs8',
    claveBytes,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const firma = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    claveCripto,
    new TextEncoder().encode(unsigned)
  );

  const jwt = `${unsigned}.${base64url(firma)}`;

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  if (!resp.ok) {
    throw new Error(`No se pudo obtener access_token de Google: ${await resp.text()}`);
  }

  const data = await resp.json();
  cachedAccessToken = { token: data.access_token, expiraEn: Date.now() + (data.expires_in - 60) * 1000 };
  return data.access_token;
}

async function enviarPushFCM(fcmToken: string, titulo: string, cuerpo: string, extra: Record<string, string>) {
  const accessToken = await obtenerAccessTokenFCM();

  const resp = await fetch(
    `https://fcm.googleapis.com/v1/projects/${FCM_PROJECT_ID}/messages:send`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          token: fcmToken,
          notification: { title: titulo, body: cuerpo },
          data: extra,
          android: {
            priority: 'high',
            notification: { channel_id: 'geofence-alerts', sound: 'default' },
          },
        },
      }),
    }
  );

  if (!resp.ok) {
    console.error('[geofence-webhook] Error enviando push FCM:', await resp.text());
  }
  return resp.ok;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const body = await req.json();
    const { identifier, transition, enter, payload } = body ?? {};

    const esEntrada = typeof enter === 'boolean' ? enter : String(transition).toLowerCase() === 'enter';
    if (!esEntrada) {
      // Solo notificamos en ENTER, igual que en el listener del cliente.
      return new Response(JSON.stringify({ ok: true, ignorado: 'exit' }), { status: 200 });
    }

    const deviceId = payload?.deviceId;
    if (!deviceId || typeof deviceId !== 'string') {
      console.warn('[geofence-webhook] payload.deviceId inválido:', JSON.stringify(payload));
      return new Response(JSON.stringify({ ok: false, error: 'payload.deviceId ausente o inválido' }), { status: 400 });
    }

    // 1) Buscar el token FCM de este dispositivo.
    const { data: tokenRow, error: errorToken } = await supabaseAdmin
      .from('device_push_tokens')
      .select('fcm_token')
      .eq('device_id', deviceId)
      .maybeSingle();

    if (errorToken || !tokenRow?.fcm_token) {
      console.warn('[geofence-webhook] Sin token FCM para device_id:', deviceId, errorToken?.message);
      return new Response(JSON.stringify({ ok: false, error: 'sin token FCM' }), { status: 200 });
    }

    // 2) Traer nombre / mensaje / puntos del restaurante (misma tabla `conexion`
    //    + `configuracion` que usa GeofencingProvider.jsx en el cliente).
    const { data: conexion } = await supabaseAdmin
      .from('conexion')
      .select('puntos_llegada, mensaje_promo')
      .eq('restaurante_id', identifier)
      .maybeSingle();

    const { data: config } = await supabaseAdmin
      .from('configuracion')
      .select('nombre')
      .eq('id', identifier)
      .maybeSingle();

    const nombre = config?.nombre ?? 'Restaurante';
    const puntos = conexion?.puntos_llegada ?? 2;
    const mensaje = conexion?.mensaje_promo || `Confirma tu llegada y gana +${puntos} puntos`;

    // 3) Enviar el push.
    const enviado = await enviarPushFCM(
      tokenRow.fcm_token,
      `¡Estás cerca de ${nombre}!`,
      mensaje,
      { restauranteId: String(identifier) }
    );

    return new Response(JSON.stringify({ ok: enviado }), { status: 200 });
  } catch (err) {
    console.error('[geofence-webhook] Error inesperado:', err);
    return new Response(JSON.stringify({ ok: false, error: String(err) }), { status: 500 });
  }
});
