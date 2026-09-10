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
// siguen acreditando igual — ver el comentario de notificarVisitaGeocerca).
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
//
// v6 (validación de horario comercial — Colombia, America/Bogota — pedido
// explícito del usuario): el push de "ganaste puntos" por geocerca se
// disparaba a cualquier hora, incluida la madrugada, si el cliente pasaba
// cerca del local (por ejemplo yendo de camino a otro lado). Ahora SOLO se
// envía el push si el evento cae dentro de una ventana comercial
// (almuerzo 11:30–15:00 o cena 18:30–22:30, hora de Bogotá). Fuera de esas
// ventanas el evento se sigue registrando igual — fn_evento_geocerca (más
// abajo, en el handler principal) corre SIEMPRE y sigue acreditando los
// puntos sin condición — solo se omite la notificación push para no
// molestar al cliente de noche. No existe todavía una columna de horario
// por restaurante en `configuracion_restaurantes` (se revisó el esquema
// real antes de escribir esto), así que la ventana queda fija para todos
// los restaurantes; si más adelante se necesita un horario configurable
// por local, esto es lo primero que habría que parametrizar ahí.
//
// v7 (push en TODA entrada a la geocerca, no solo cuando hay bono — pedido
// explícito del usuario, probando el flujo en vivo): antes, esta función
// solo llamaba a notificarVisitaGeocerca (antes "notificarBonoGeocerca")
// cuando `bonificado=true` — es decir, únicamente la PRIMERA entrada del
// día, porque fn_evento_geocerca limita el bono a una vez por día
// calendario (esa regla de negocio NO cambia acá, sigue siendo así en la
// base de datos: es la protección anti-fraude GPS del proyecto). El
// problema es que esto también apagaba el push por completo en cualquier
// entrada posterior del mismo día, aunque el cliente sí haya vuelto a
// pasar cerca. Ahora se notifica en CADA entrada a la geocerca dentro de
// horario comercial (si el cliente tiene la preferencia activa), haya o
// no puntos de por medio — el mensaje cambia según corresponda:
//   - Si `puntos > 0` (primera vez del día): el mensaje de siempre,
//     mencionando los puntos ganados.
//   - Si `puntos === 0` (ya se usó el bono hoy, o el cliente redimió hoy —
//     ver fn_redimio_hoy dentro de fn_evento_geocerca): un mensaje
//     distinto que NO menciona puntos ganados, para no decir algo falso.
// Se sigue sin notificar en eventos de SALIDA (esEntrada=false) ni cuando
// fn_evento_geocerca devuelve motivo='cliente_inactivo' (cliente
// desvinculado del restaurante) — eso no cambió.
//
// ADVERTENCIA para quien lea esto más adelante: con este cambio, un
// cliente que pase varias veces por el mismo lugar en un mismo día (por
// ejemplo si vive cerca) va a recibir varias notificaciones ese día, no
// solo una — antes del v7 eso no pasaba porque el push dependía del bono.
// Si en algún momento eso resulta molesto para los clientes reales, la
// solución sería agregar un límite de "un push de este tipo por día"
// separado del límite de puntos (que es independiente y no se toca acá).
//
// v8 (texto del mensaje sin bono — pedido explícito del usuario, después
// de ver en un teléfono real el mensaje que puso el v7): reemplaza el
// mensaje de "ya alcanzaste tu bono de hoy" por un único texto de
// bienvenida (igual en almuerzo y en cena), con dos restricciones
// explícitas: no mencionar "cédula" ni "código QR"/"QR", y no prometer
// puntos de cercanía duplicados — el cajero sigue siendo quien registra
// el consumo con la cédula del cliente, este push es solo un saludo. Ver
// el bloque `if (puntos > 0)` / resto de la función mensajePorFranja más
// abajo para el detalle exacto del texto.
//
// v9 (ajuste de texto — pedido explícito del usuario, tras probar el v8 en
// un teléfono real): al título del mensaje sin bono se le agrega "estás
// cerca de", quedando "📍 ¡Hola de nuevo, estás cerca de {restaurante}!".
// El cuerpo no cambia. Se aprovechó este mismo despliegue para revertir la
// ventana de horario comercial de cena a su valor real (22:30) — la
// ampliación temporal hasta las 23:59 solo era para poder probar el
// mensaje del v8 esa misma noche.
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

// ── v6: ventana comercial (hora de Bogotá) ────────────────────────────────
// Se trabaja en "minutos del día" (0–1439) en vez de comparar solo la hora
// entera, porque las ventanas empiezan/terminan en la media hora (11:30,
// 18:30, 22:30) — comparar solo `hora >= 11` incluiría por error 11:00–11:29.
type FranjaHoraria = 'almuerzo' | 'cena' | null;

const INICIO_ALMUERZO_MIN = 11 * 60 + 30; // 11:30
const FIN_ALMUERZO_MIN    = 15 * 60;      // 15:00
const INICIO_CENA_MIN     = 18 * 60 + 30; // 18:30
// Revertido a las 22:30 (valor real de negocio) — la ampliación temporal
// hasta las 23:59 era solo para la prueba de esta noche del mensaje v8/v9;
// el usuario ya confirmó que la notificación de prueba llegó bien.
const FIN_CENA_MIN        = 22 * 60 + 30; // 22:30

function obtenerFranjaHorariaColombia(): FranjaHoraria {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Bogota',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date());

  const hora = Number(partes.find((p) => p.type === 'hour')?.value ?? '0');
  const minuto = Number(partes.find((p) => p.type === 'minute')?.value ?? '0');
  const minutosDelDia = hora * 60 + minuto;

  if (minutosDelDia >= INICIO_ALMUERZO_MIN && minutosDelDia < FIN_ALMUERZO_MIN) return 'almuerzo';
  if (minutosDelDia >= INICIO_CENA_MIN && minutosDelDia < FIN_CENA_MIN) return 'cena';
  return null;
}

// ── v6/v7: mensaje contextual del push según la franja horaria y si esta
// entrada trajo puntos nuevos o no (ver comentario v7 más arriba) ─────────
function mensajePorFranja(
  franja: Exclude<FranjaHoraria, null>,
  nombreRestaurante: string,
  puntos: number,
): { titulo: string; cuerpo: string } {
  if (puntos > 0) {
    if (franja === 'almuerzo') {
      return {
        titulo: `📍 ¡Hora de almorzar en ${nombreRestaurante}!`,
        cuerpo: `Tienes ${puntos} puntos acumulados para disfrutar hoy.`,
      };
    }
    return {
      titulo: `🌙 Termina tu día en ${nombreRestaurante}`,
      cuerpo: `¡Acumula puntos con tu visita hoy! Recién ganaste ${puntos} pts.`,
    };
  }

  // v9 (pedido explícito del usuario, tras probar el mensaje del v8 en un
  // teléfono real): se agrega "estás cerca de" al título, para que quede
  // claro que el aviso es porque el cliente está físicamente cerca del
  // local — ya se usó el bono de geocerca hoy (o el cliente redimió hoy),
  // un único texto para almuerzo y cena por igual (no varía por franja, a
  // diferencia del caso con puntos). A propósito NO menciona "cédula",
  // "código QR"/"QR" ni promete puntos de cercanía duplicados — el
  // cajero sigue siendo quien registra el consumo con la cédula, esto es
  // solo un saludo de bienvenida.
  return {
    titulo: `📍 ¡Hola de nuevo, estás cerca de ${nombreRestaurante}!`,
    cuerpo: 'Disfruta tu visita y acumula puntos por tus consumos de hoy.',
  };
}

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

// v7: renombrada de "notificarBonoGeocerca" — ya no notifica solo cuando
// hay bono, sino en toda entrada válida a la geocerca (ver comentario v7
// arriba del archivo). `puntos` puede ser 0.
async function notificarVisitaGeocerca(deviceId: string, restauranteId: string, clienteId: string, puntos: number): Promise<void> {
  try {
    // v6: fuera de horario comercial no se envía push — los puntos (si los
    // hay) ya quedaron acreditados por fn_evento_geocerca en el handler
    // principal, esto solo decide si se molesta o no al cliente con una
    // notificación.
    const franja = obtenerFranjaHorariaColombia();
    if (!franja) {
      console.log('[geofence-webhook] Fuera de horario comercial (almuerzo/cena) — se omite el push de FCM.');
      return;
    }

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

    const { titulo, cuerpo } = mensajePorFranja(franja, nombreRestaurante, puntos);

    const accessToken = await obtenerTokenAccesoFCM(serviceAccountRaw);
    const resultado = await enviarPushFCM(
      accessToken,
      projectId,
      tokenRow.fcm_token,
      titulo,
      cuerpo,
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

  // Nota (v6): esta llamada NO cambia — el evento de geocerca se registra y
  // los puntos se acreditan SIEMPRE, sin importar la hora. El filtro de
  // horario comercial solo aplica más abajo, a la notificación push. La
  // regla de "el bono solo se otorga una vez por día calendario" vive acá
  // adentro (fn_evento_geocerca) y NO cambia con el v7 — lo único que
  // cambió es que ahora SÍ se notifica aunque esta llamada ya no dé puntos.
  const { data, error } = await supabaseAdmin.rpc('fn_evento_geocerca', {
    p_cliente_id: dispositivo.cliente_id,
    p_restaurante_id: restauranteId,
    p_tipo: esEntrada ? 'entrada' : 'salida',
  });

  if (error) {
    console.error('[geofence-webhook] error en fn_evento_geocerca:', error);
    return jsonResponse({ ok: false, motivo: 'error_interno' }, 500);
  }

  // v7: antes era `if (data?.bonificado && puntos > 0)` — solo notificaba
  // cuando había bono. Ahora se notifica en toda ENTRADA válida (no en
  // salida, y no si el cliente está inactivo en este restaurante), haya o
  // no puntos; el mensaje se adapta adentro de notificarVisitaGeocerca.
  if (esEntrada && data?.motivo !== 'cliente_inactivo') {
    const puntosGanados = typeof data?.puntos === 'number' ? data.puntos : 0;
    await notificarVisitaGeocerca(deviceId, restauranteId, dispositivo.cliente_id, puntosGanados);
  }

  return jsonResponse(data, 200);
});
