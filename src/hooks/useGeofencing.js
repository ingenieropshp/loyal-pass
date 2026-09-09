/**
 * useGeofencing.js — LoyalPass
 * ─────────────────────────────────────────────────────────────────────────
 * Geofencing NATIVO (iOS/Android) con @capgo/background-geolocation:
 *
 *  - setupGeofencing() + addGeofence() por comercio: el sistema operativo
 *    (Core Location en iOS / Geofencing API en Android) vigila el radio a
 *    nivel de SO, dispara 'geofenceTransition' y despierta el proceso
 *    incluso con la app cerrada — sin mantener el JS ni el GPS activos
 *    todo el tiempo. `url`+`payload:{deviceId}` en setupGeofencing es lo
 *    que le permite al plugin hacer un POST nativo (sin JS) cuando la app
 *    está completamente cerrada.
 *
 *  - Con la app abierta/en background-pero-viva, el mismo evento también
 *    llega acá como listener JS ('geofenceTransition' → manejarTransicion).
 *    En ESE caso el POST al Edge Function lo hace este archivo directamente
 *    vía fetch, con el mismo shape {identifier, enter/transition,
 *    payload:{deviceId}} que lee geofence-webhook/index.ts. ANTES se
 *    mandaba {user_id, restaurante_id, latitude, longitude} — ninguno de
 *    esos campos coincide con lo que el webhook realmente lee, así que
 *    siempre respondía 400 "payload_incompleto" antes de llegar al RPC
 *    (bug corregido acá: ver enviarEventoGeocercaWebhook más abajo). El
 *    Edge Function sigue siendo el único responsable de decidir y
 *    acreditar puntos; este hook no calcula ni inserta puntos por su cuenta.
 *
 *  - addWatcher() de bajo consumo (distanceFilter alto) usado para mantener
 *    actualizada la lista `proximos` que consume la UI, Y (desde el filtro
 *    de vehículos de abajo) para conocer la última velocidad reportada por
 *    el GPS. La detección de entrada/salida en sí la sigue resolviendo el
 *    sistema operativo vía las geocercas nativas de arriba — el watcher no
 *    decide eso, solo aporta el dato de velocidad para clasificar la
 *    entrada.
 *
 *  - FILTRO PEATÓN vs VEHÍCULO (a pedido explícito del negocio, para que una
 *    moto/carro pasando de largo por la calle no cuente como visita):
 *      · Si al momento del 'enter' la última velocidad conocida es de
 *        peatón (o el GPS todavía no reportó velocidad), se confirma la
 *        visita DE INMEDIATO — notificación local + aviso al webhook, igual
 *        que siempre. Acá no se agregó ninguna espera nueva: éste YA era el
 *        comportamiento existente.
 *      · Si la velocidad indica vehículo, NO se dispara nada todavía: se
 *        arma un temporizador de espera (TIEMPO_ESPERA_VEHICULO_MS). Si el
 *        'exit' llega antes de que se cumpla (el vehículo solo pasó de
 *        largo), se cancela sin avisar a nadie. Si sigue "dentro" cuando se
 *        cumple el plazo, se confirma la visita recién ahí — se asume que
 *        se bajó y se quedó.
 *      · Mientras se espera la confirmación de un posible vehículo, se
 *        activa brevemente un segundo watcher de ALTA frecuencia
 *        (distanceFilter chico) para tener mejores lecturas de posición en
 *        esa ventana crítica — se apaga solo al resolverse o al vencer el
 *        plazo máximo, así el consumo extra de batería es acotado y no
 *        permanente. No se usó ningún parámetro de "prioridad de exactitud"
 *        del plugin nativo porque no encontré uno documentado en la versión
 *        instalada (@capgo/background-geolocation ^8.4.3) — antes de
 *        inventar una opción no verificada que pudiera fallar en tiempo de
 *        ejecución, se prefirió este mecanismo con las opciones de
 *        addWatcher que sí están confirmadas (distanceFilter/stale).
 *      · LÍMITE IMPORTANTE: este filtro solo corre con el WebView vivo
 *        (foreground o background-pero-proceso-vivo). Con la app
 *        COMPLETAMENTE cerrada, el plugin hace su propio POST nativo al
 *        webhook sin pasar por JS en absoluto (ver `url` en
 *        setupGeofencing) — ahí no hay forma de aplicar este filtro sin
 *        código nativo (Kotlin), así que ese caso sigue disparando de
 *        inmediato como siempre, sin distinguir peatón de vehículo.
 *
 * Mantiene la interfaz de retorno exigida por GeofencingProvider.jsx:
 *   { dentroDeRango, estado, proximos, notifInApp, limpiarNotifInApp }
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { Capacitor } from '@capacitor/core';
import { BackgroundGeolocation } from '@capgo/background-geolocation';
import { LocalNotifications } from '@capacitor/local-notifications';
import { getDeviceId } from '../utils/deviceId';
// Ya no se importa `supabase` acá: su único uso (supabase.auth.getUser(),
// para resolver un user_id que el webhook nunca leía) se quitó junto con
// userIdRef — ver el fix de enviarEventoGeocercaWebhook más abajo.

// Exportado (antes era privado de este archivo) para que
// usePushNotifications.js pueda crear/asegurar EXACTAMENTE el mismo canal
// nativo de Android antes de que exista cualquier geocerca configurada —
// los IDs de canal de notificación son un recurso del sistema operativo,
// compartido entre @capacitor/local-notifications y
// @capacitor/push-notifications: si un push FCM llega con un `channel_id`
// que no coincide carácter por carácter con uno ya creado, Android lo
// descarta en silencio (no lanza error, simplemente no se muestra nada).
export const CANAL_ID_GEOFENCE = 'geofence-alerts';

// Edge Function de Supabase. Recibe tanto el POST nativo del plugin (app
// cerrada, ver setupGeofencing más abajo) como el POST directo que este
// archivo dispara desde manejarTransicion cuando el WebView está vivo.
const GEOFENCE_WEBHOOK_URL = import.meta.env.VITE_GEOFENCE_WEBHOOK_URL;

// Requerida para que el Edge Function acepte la petición: sin Authorization
// (o apikey), Supabase la rechaza con 401 antes de que el handler llegue a
// leer el payload.
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Piso de seguridad contra el margen de error normal del GPS (10-50m en
// ciudad, peor entre edificios altos). Se bajó de 100m a 50m a pedido del
// negocio para permitir geocercas más ajustadas — sigue dejando margen
// frente al error típico del GPS, pero ya no exagera el radio mínimo como
// antes.
const RADIO_MINIMO_METROS = 50;

// ── Filtro peatón vs vehículo ────────────────────────────────────────────
// Umbral de velocidad: por debajo se trata como peatón (o parado/GPS sin
// dato), por encima se trata como vehículo. 2.2 m/s ≈ 8 km/h — un poco por
// encima de una caminata rápida, para no filtrar por error a alguien que
// llega apurado a pie. Es un valor ajustable, no una constante física.
const UMBRAL_VELOCIDAD_VEHICULO_MS = 2.2;

// Tiempo que debe seguir "dentro" un posible vehículo antes de confirmar la
// visita — punto medio del rango pedido (60-90s). Si el 'exit' llega antes,
// se asume que solo pasó de largo y no se avisa a nadie.
const TIEMPO_ESPERA_VEHICULO_MS = 75_000;

// distanceFilter del watcher de alta frecuencia que se activa SOLO mientras
// se espera confirmar un posible vehículo (ver arriba) — mucho más seguido
// que el watcher de bajo consumo normal (50m), para tener mejores lecturas
// de velocidad/posición justo en la ventana en la que importa.
const DISTANCE_FILTER_ALTA_FRECUENCIA = 5;

// Clave de localStorage usada ÚNICAMENTE para no reenviar el mismo evento de
// entrada mientras el usuario sigue dentro de la geocerca en la misma
// visita. Se limpia en el 'exit', así que una salida + reentrada posterior
// sí cuenta como visita nueva y vuelve a notificar al Edge Function.
const CLAVE_VISITAS_EN_CURSO = 'loyalpass_visitas_en_curso';

// LocalNotifications.schedule requiere id numérico (int32) por notificación.
// Con un hash estable, un mismo comercio siempre reemplaza su notificación
// anterior en vez de acumular duplicados.
function idNumericoDesde(texto) {
  const str = String(texto);
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) || 1;
}

function distanciaMetros(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const rLat1 = (lat1 * Math.PI) / 180;
  const rLat2 = (lat2 * Math.PI) / 180;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rLat1) * Math.cos(rLat2) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function yaNotificadaEnEstaVisita(restauranteId) {
  try {
    const visitas = JSON.parse(localStorage.getItem(CLAVE_VISITAS_EN_CURSO) || '{}');
    return Boolean(visitas[restauranteId]);
  } catch {
    return false;
  }
}

function marcarVisitaEnCurso(restauranteId, enCurso) {
  try {
    const visitas = JSON.parse(localStorage.getItem(CLAVE_VISITAS_EN_CURSO) || '{}');
    if (enCurso) {
      visitas[restauranteId] = true;
    } else {
      delete visitas[restauranteId];
    }
    localStorage.setItem(CLAVE_VISITAS_EN_CURSO, JSON.stringify(visitas));
  } catch (err) {
    console.warn('[useGeofencing] No se pudo actualizar el registro de visita en curso:', err.message);
  }
}

// POST directo (WebView vivo) al Edge Function. Reemplaza la lógica anterior
// de cálculo/inserción de puntos desde el dispositivo: acá solo se reporta
// quién y dónde, y es el Edge Function el que decide y acredita del lado
// del servidor. "Fire and forget": si falla, no debe bloquear la UI — la
// notificación local (mostrarNotifNativa) ya cumplió su función.
//
// EXPORTADA (antes era privada de este archivo) para que SuccessCard
// (manejarRegistro.jsx) pueda reusar EXACTAMENTE este mismo POST justo
// después de un registro en el local, en vez de reimplementar su propio
// fetch con un shape de payload distinto (que es precisamente el bug que
// tenía esta función antes de este fix).
//
// IMPORTANTE: el body tiene que calzar con la interfaz `PayloadGeofence`
// que lee supabase/functions/geofence-webhook/index.ts:
//   { identifier, transition?: 'enter'|'exit', enter?: boolean, payload?: { deviceId } }
// Antes se mandaba { user_id, restaurante_id, latitude, longitude } — CERO
// campos de esos existen en `PayloadGeofence`, así que el webhook siempre
// devolvía 400 "payload_incompleto" sin llegar nunca a llamar a
// fn_evento_geocerca. El webhook no usa latitude/longitude para nada (la
// distancia ya la validó quien dispara el evento — el SO en el caso nativo,
// o el llamador en el caso del check manual de SuccessCard), así que no
// hace falta mandarlas.
export async function enviarEventoGeocercaWebhook(deviceId, restauranteId, esEntrada) {
  if (!GEOFENCE_WEBHOOK_URL) {
    console.warn('[useGeofencing] Falta VITE_GEOFENCE_WEBHOOK_URL — no se envía el evento de geocerca');
    return;
  }
  if (!deviceId) {
    console.warn('[useGeofencing] No hay deviceId resuelto — se omite el POST de geocerca');
    return;
  }
  try {
    await fetch(GEOFENCE_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        apikey: SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({
        // `identifier` = restaurante_id: así es como geofence-webhook/index.ts
        // nombra el campo (mismo nombre que usa el plugin nativo).
        identifier: restauranteId,
        // Se manda AMBAS formas (enter y transition) porque el Edge
        // Function acepta cualquiera de las dos (usa `enter` si viene,
        // si no cae a `transition`) — igual que hace el plugin nativo.
        enter: esEntrada,
        transition: esEntrada ? 'enter' : 'exit',
        // El webhook resuelve cliente_id buscando (device_id, restaurante_id)
        // en `dispositivos_clientes` — por eso viaja dentro de `payload`.
        payload: { deviceId },
      }),
    });
  } catch (err) {
    console.warn('[useGeofencing] Error de red enviando evento de geocerca al webhook:', err.message);
  }
}

async function asegurarCanalNotificacionNativo() {
  if (Capacitor.getPlatform() !== 'android') return;
  try {
    await LocalNotifications.createChannel({
      id: CANAL_ID_GEOFENCE,
      name: 'Alertas de cercanía',
      description: 'Avisos cuando estás cerca de un restaurante afiliado',
      importance: 5, // IMPORTANCE_HIGH → heads-up + sonido
      visibility: 1,
    });
  } catch (err) {
    console.warn('[useGeofencing] Error creando canal de notificación:', err.message);
  }
}

// Mapea el shape que entrega GeofencingProvider (restaurante_id, latitud,
// longitud, radio_aviso...) al shape que exige @capgo/background-geolocation
// (id, latitude, longitude, radius).
//
// `radio_aviso` es configurable por restaurante (columna en la tabla
// `conexion`). Si no viene definido o no es un número válido, se usa 100m
// por defecto (antes era 200m). RADIO_MINIMO_METROS sigue actuando como piso
// de seguridad para evitar radios demasiado chicos que generen falsos
// negativos/positivos por el margen de error normal del GPS.
const RADIO_AVISO_METROS_DEFECTO = 100;

function mapearAComercios(restaurantes) {
  return restaurantes
    .filter(
      (r) =>
        r.restaurante_id &&
        !isNaN(parseFloat(r.latitud)) &&
        !isNaN(parseFloat(r.longitud))
    )
    .map((r) => ({
      id: String(r.restaurante_id),
      nombre: r.nombre ?? 'Restaurante',
      latitude: parseFloat(r.latitud),
      longitude: parseFloat(r.longitud),
      radius: Math.max(
        parseInt(r.radio_aviso, 10) || RADIO_AVISO_METROS_DEFECTO,
        RADIO_MINIMO_METROS
      ),
      mensaje_promo: r.mensaje_promo,
      puntos_llegada: r.puntos_llegada ?? 2,
    }));
}

export function useGeofencing(restaurantes, deviceIdPrimed) {
  // Estados posibles: 'idle' | 'solicitando_permiso' | 'sin_permiso' | 'rastreando'
  const [estado, setEstado] = useState('idle');
  const [dentroDeRango, setDentroDeRango] = useState([]);
  const [proximos, setProximos] = useState([]);
  const [notifInApp, setNotifInApp] = useState([]);

  const restaurantesRef = useRef(restaurantes);
  const comerciosActivosRef = useRef([]);
  const watcherIdRef = useRef(null);
  const transitionListenerRef = useRef(null);
  // Guarda el deviceId ya resuelto para que manejarTransicion (que corre en
  // otro callback, sin acceso directo a variables locales de iniciarRastreo)
  // pueda usarlo al armar el body del webhook. Antes esto guardaba el
  // user_id de supabase.auth.getUser() — ya no hace falta: el webhook
  // resuelve el cliente por (deviceId, restaurante_id), no por user_id.
  const deviceIdRef = useRef(null);

  // ── Filtro peatón vs vehículo ──────────────────────────────────────────
  // Última velocidad conocida (m/s), actualizada por CUALQUIERA de los dos
  // watchers (el normal de bajo consumo, o el de alta frecuencia mientras
  // se confirma un posible vehículo). null = el GPS todavía no reportó
  // velocidad (fix reciente, o dispositivo sin soporte) — se trata como
  // peatón por seguridad, para no bloquear el caso común de una visita
  // legítima con la primera lectura de GPS todavía sin velocidad.
  const ultimaVelocidadRef = useRef(null);
  // identifier → { timeoutId, comercio } de las visitas de posible vehículo
  // en espera de confirmación. Se cancela desde el 'exit' si el vehículo
  // solo pasó de largo.
  const esperasVehiculoRef = useRef({});
  // Espejo síncrono de `dentroDeRango` (el estado de React no es fiable
  // dentro de un closure de setTimeout creado varios renders atrás).
  const dentroDeRangoRef = useRef([]);
  // Watcher de alta frecuencia, prendido/apagado bajo demanda — separado del
  // watcher normal de bajo consumo para no subir el consumo de batería todo
  // el tiempo, solo durante la ventana en la que hay un vehículo por
  // confirmar.
  const watcherAltaFrecuenciaIdRef = useRef(null);
  const watcherAltaFrecuenciaContadorRef = useRef(0); // cuántas esperas activas lo necesitan ahora mismo

  useEffect(() => {
    restaurantesRef.current = restaurantes;
  }, [restaurantes]);

  const mostrarNotifNativa = useCallback(async (comercio) => {
    try {
      await LocalNotifications.schedule({
        notifications: [
          {
            id: idNumericoDesde(comercio.id),
            title: `¡Estás cerca de ${comercio.nombre}!`,
            body: comercio.mensaje_promo || `📍 Estás cerca de ${comercio.nombre}. ¡Pide en la barra con tu cédula para acumular tus puntos! 🍔`,
            channelId: CANAL_ID_GEOFENCE,
            smallIcon: 'ic_stat_icon',
            extra: { restauranteId: comercio.id },
          },
        ],
      });
    } catch (err) {
      console.warn('[useGeofencing] Error mostrando notificación nativa:', err.message);
    }
  }, []);

  // Prende/apaga el watcher de alta frecuencia con conteo de referencias:
  // si hay más de una espera de "posible vehículo" activa a la vez (dos
  // comercios distintos), el watcher se queda prendido hasta que la ÚLTIMA
  // se resuelva, en vez de que una cancele el watcher que la otra todavía
  // necesita.
  const activarWatcherAltaFrecuencia = useCallback(async () => {
    watcherAltaFrecuenciaContadorRef.current += 1;
    if (watcherAltaFrecuenciaIdRef.current) return; // ya estaba prendido
    try {
      watcherAltaFrecuenciaIdRef.current = await BackgroundGeolocation.addWatcher(
        {
          backgroundTitle: 'LoyalPass está activo',
          backgroundMessage: 'Confirmando tu llegada…',
          requestPermissions: false, // ya se pidió en setupGeofencing
          stale: false,
          distanceFilter: DISTANCE_FILTER_ALTA_FRECUENCIA,
        },
        (location, error) => {
          if (error) {
            console.warn('[useGeofencing] Error en watcher de alta frecuencia:', error.message);
            return;
          }
          if (location && typeof location.speed === 'number') {
            ultimaVelocidadRef.current = location.speed;
          }
        }
      );
    } catch (err) {
      console.warn('[useGeofencing] Error activando watcher de alta frecuencia:', err.message);
    }
  }, []);

  const desactivarWatcherAltaFrecuencia = useCallback(async () => {
    watcherAltaFrecuenciaContadorRef.current = Math.max(0, watcherAltaFrecuenciaContadorRef.current - 1);
    if (watcherAltaFrecuenciaContadorRef.current > 0) return; // otra espera lo sigue necesitando
    const id = watcherAltaFrecuenciaIdRef.current;
    if (!id) return;
    watcherAltaFrecuenciaIdRef.current = null;
    try {
      await BackgroundGeolocation.removeWatcher({ id });
    } catch (err) {
      console.warn('[useGeofencing] Error apagando watcher de alta frecuencia:', err.message);
    }
  }, []);

  // Confirma una visita real (peatón inmediato, o vehículo tras la espera):
  // notificación local + aviso al webhook. Extraído de manejarTransicion
  // para que ambos caminos (inmediato y demorado) hagan exactamente lo
  // mismo al confirmar, sin duplicar lógica.
  const confirmarVisita = useCallback(
    (identifier, comercio) => {
      mostrarNotifNativa(comercio);
      setNotifInApp((prev) => [
        ...prev,
        {
          id: `${identifier}-${Date.now()}`,
          restauranteId: identifier,
          nombre: comercio.nombre,
          mensaje: comercio.mensaje_promo || `📍 Estás cerca de ${comercio.nombre}. ¡Pide en la barra con tu cédula para acumular tus puntos! 🍔`,
          timestamp: Date.now(),
        },
      ]);

      // Solo se reporta una vez por visita: si ya está marcada como "en
      // curso" para este comercio, no se vuelve a llamar al webhook hasta
      // que ocurra el 'exit' correspondiente.
      if (!yaNotificadaEnEstaVisita(identifier)) {
        marcarVisitaEnCurso(identifier, true);
        enviarEventoGeocercaWebhook(deviceIdRef.current, identifier, true);
      }
    },
    [mostrarNotifNativa]
  );

  // Callback del evento nativo 'geofenceTransition'. Forma real confirmada
  // contra la documentación oficial de @capgo/background-geolocation v8:
  // { identifier, transition: 'enter'|'exit', enter: boolean, latitude, longitude, radius, payload }
  // OJO: `transition` viene en MINÚSCULAS ('enter' / 'exit'), no 'ENTER'/'EXIT'.
  // Usamos el booleano `enter` como fuente de verdad porque no depende de
  // mayúsculas/minúsculas ni de nombres de string que el plugin pueda ajustar.
  const manejarTransicion = useCallback(
    (evento) => {
      // latitude/longitude ya no se usan acá: el webhook no las necesita
      // (ver enviarEventoGeocercaWebhook) — se quitaron del destructure para
      // no dejar variables muertas.
      const { identifier, transition, enter } = evento || {};
      if (!identifier) return;
      const comercio = comerciosActivosRef.current.find((c) => c.id === String(identifier));
      if (!comercio) return;

      const esEntrada = typeof enter === 'boolean' ? enter : String(transition).toLowerCase() === 'enter';
      const esSalida  = typeof enter === 'boolean' ? !enter : String(transition).toLowerCase() === 'exit';

      if (esEntrada) {
        setDentroDeRango((prev) => {
          const siguiente = prev.includes(identifier) ? prev : [...prev, identifier];
          dentroDeRangoRef.current = siguiente; // espejo síncrono, ver declaración arriba
          return siguiente;
        });

        const velocidadActual = ultimaVelocidadRef.current;
        const pareceVehiculo =
          typeof velocidadActual === 'number' && velocidadActual >= UMBRAL_VELOCIDAD_VEHICULO_MS;

        if (!pareceVehiculo) {
          // Peatón (o velocidad todavía desconocida, ej. primer fix del GPS):
          // se confirma de inmediato — comportamiento sin cambios.
          confirmarVisita(identifier, comercio);
          return;
        }

        // Posible vehículo: todavía no se confirma nada. Si ya había una
        // espera en curso para este mismo comercio (reentradas rápidas en
        // el borde de la geocerca), se reinicia en vez de acumular dos.
        if (esperasVehiculoRef.current[identifier]) {
          clearTimeout(esperasVehiculoRef.current[identifier].timeoutId);
          desactivarWatcherAltaFrecuencia();
        }
        activarWatcherAltaFrecuencia();
        const timeoutId = setTimeout(() => {
          delete esperasVehiculoRef.current[identifier];
          desactivarWatcherAltaFrecuencia();
          // Solo se confirma si NO hubo un 'exit' mientras tanto. Se lee el
          // espejo en ref (dentroDeRangoRef), no el estado de React: este
          // callback quedó "congelado" desde el render en el que se creó el
          // setTimeout, así que `dentroDeRango` acá adentro podría estar
          // desactualizado.
          if (dentroDeRangoRef.current.includes(identifier)) {
            confirmarVisita(identifier, comercio);
          }
        }, TIEMPO_ESPERA_VEHICULO_MS);
        esperasVehiculoRef.current[identifier] = { timeoutId };
      }

      if (esSalida) {
        setDentroDeRango((prev) => {
          const siguiente = prev.filter((id) => id !== identifier);
          dentroDeRangoRef.current = siguiente;
          return siguiente;
        });
        marcarVisitaEnCurso(identifier, false);

        // Si había una espera de "posible vehículo" pendiente para este
        // comercio, se cancela acá: fue un cruce de paso, no una visita —
        // no se avisa a nadie ni se acreditan puntos.
        const espera = esperasVehiculoRef.current[identifier];
        if (espera) {
          clearTimeout(espera.timeoutId);
          delete esperasVehiculoRef.current[identifier];
          desactivarWatcherAltaFrecuencia();
        }
      }
    },
    [confirmarVisita, activarWatcherAltaFrecuencia, desactivarWatcherAltaFrecuencia]
  );

  // Alimenta `proximos` (todos los restaurantes ordenados por distancia)
  // para la UI — totalmente independiente de la detección ENTER/EXIT.
  const actualizarProximos = useCallback((uLat, uLon) => {
    const lista = restaurantesRef.current
      .map((r) => ({
        ...r,
        distanciaMetros: Math.round(
          distanciaMetros(uLat, uLon, parseFloat(r.latitud), parseFloat(r.longitud))
        ),
      }))
      .sort((a, b) => a.distanciaMetros - b.distanciaMetros);
    setProximos(lista);
  }, []);

  const iniciarRastreo = useCallback(async () => {
    const comercios = mapearAComercios(restaurantesRef.current);
    if (comercios.length === 0) return;
    comerciosActivosRef.current = comercios;
    setEstado('solicitando_permiso');

    try {
      const permisoNotif = await LocalNotifications.requestPermissions();
      if (permisoNotif.display !== 'granted') {
        console.warn('[useGeofencing] Permiso de notificaciones no concedido — las geocercas dispararán pero no se mostrará nada');
      }
      await asegurarCanalNotificacionNativo();

      if (!GEOFENCE_WEBHOOK_URL) {
        console.warn(
          '[useGeofencing] Falta VITE_GEOFENCE_WEBHOOK_URL — con la app cerrada ' +
          'el evento no va a llegar (el listener JS solo dispara con el WebView vivo).'
        );
      }

      // deviceId: usamos el que el provider ya "primeó" en paralelo
      // (ver GeofencingProvider.jsx) para no volver a esperar a
      // Device.getId() acá. Si por algún motivo llega null/undefined
      // (carrera rara, o el provider aún no montó), caemos al await real
      // — getDeviceId() es ASYNC, así que NUNCA se debe pasar sin await:
      // hacerlo serializa una Promise pendiente, y JSON.stringify(promise)
      // da literalmente "{}" — ese fue el bug original (payload.deviceId
      // llegaba como {} en el webhook con la app cerrada).
      const deviceId = deviceIdPrimed ?? (await getDeviceId());
      if (!deviceId) {
        console.warn('[useGeofencing] No se pudo resolver deviceId — abortando setup de geocercas');
        setEstado('sin_permiso');
        return;
      }
      // Se guarda en el ref para que manejarTransicion (callback aparte,
      // registrado como listener más abajo) pueda leerlo al reportar cada
      // transición al webhook.
      deviceIdRef.current = deviceId;

      // setupGeofencing dispara internamente el flujo de dos pasos
      // (foreground primero, luego el upgrade a background) tanto en
      // Android como en iOS, usando los textos ya definidos en
      // AndroidManifest.xml / Info.plist.
      //
      // `url` es lo que permite recibir la transición con la app cerrada:
      // el plugin hace un POST nativo (sin depender del WebView) al webhook.
      // El listener `geofenceTransition` de abajo sigue sirviendo para
      // cuando la app está abierta/en foreground (ver manejarTransicion).
      await BackgroundGeolocation.setupGeofencing({
        url: GEOFENCE_WEBHOOK_URL,
        backgroundLocation: true,
        notifyOnEntry: true,
        notifyOnExit: true,
        payload: { deviceId },
      });

      // Limpieza defensiva: las geocercas nativas quedan registradas a nivel
      // de SO independientemente del ciclo de vida de React. Si la app se
      // cierra de un swipe (o el usuario cambia sus preferencias de
      // notificación entre sesiones) el cleanup de detenerRastreo() nunca
      // llega a correr, y el SO se queda con geocercas de un set de
      // restaurantes viejo. Arrancamos siempre desde cero para que lo único
      // activo sea exactamente lo que el usuario tiene habilitado ahora.
      try {
        await BackgroundGeolocation.removeAllGeofences();
      } catch (err) {
        console.warn('[useGeofencing] Error limpiando geocercas huérfanas:', err.message);
      }

      transitionListenerRef.current = await BackgroundGeolocation.addListener(
        'geofenceTransition',
        manejarTransicion
      );

      // Límites nativos: iOS permite ~20 geocercas simultáneas por app,
      // Android bastantes más. Si se supera, considerar registrar solo
      // las N más cercanas a la última ubicación conocida.
      if (comercios.length > 20) {
        console.warn(
          `[useGeofencing] ${comercios.length} geocercas solicitadas — iOS solo soporta ~20 ` +
          'simultáneas; puede fallar silenciosamente a partir de la #20.'
        );
      }

      for (const comercio of comercios) {
        try {
          await BackgroundGeolocation.addGeofence({
            identifier: comercio.id,
            latitude: comercio.latitude,
            longitude: comercio.longitude,
            radius: comercio.radius,
            notifyOnEntry: true,
            notifyOnExit: true,
            extras: { nombre: comercio.nombre },
          });
        } catch (err) {
          console.warn(`[useGeofencing] Error registrando geocerca "${comercio.nombre}":`, err.message);
        }
      }

      // Watcher de bajo consumo: distanceFilter alto = pocas actualizaciones
      // = bajo impacto de batería. Solo actualiza `proximos`; la detección
      // de entrada/salida NO depende de esto, corre 100% a nivel de SO.
      const watcherId = await BackgroundGeolocation.addWatcher(
        {
          backgroundTitle: 'LoyalPass está activo',
          backgroundMessage: 'Te avisaremos cuando estés cerca de tus restaurantes favoritos.',
          requestPermissions: false, // ya se pidió arriba en setupGeofencing
          stale: false,
          distanceFilter: 50,
        },
        (location, error) => {
          if (error) {
            console.warn('[useGeofencing] Error en watcher de bajo consumo:', error.message);
            return;
          }
          if (!location) return;
          actualizarProximos(location.latitude, location.longitude);
          // Alimenta el filtro peatón vs vehículo (ver manejarTransicion) —
          // este watcher corre todo el tiempo, así que sirve como fuente de
          // velocidad "de fondo" incluso fuera de la ventana en la que el
          // watcher de alta frecuencia está prendido.
          if (typeof location.speed === 'number') {
            ultimaVelocidadRef.current = location.speed;
          }
        }
      );

      watcherIdRef.current = watcherId;
      setEstado('rastreando');
      console.log('[useGeofencing] Geocercas nativas + watcher de bajo consumo activos ✅');
    } catch (err) {
      console.warn('[useGeofencing] Error inicializando rastreo:', err.message);
      setEstado('sin_permiso');
    }
  }, [manejarTransicion, actualizarProximos]);

  const detenerRastreo = useCallback(async () => {
    // Cancela cualquier espera de "posible vehículo" pendiente — si no se
    // limpian estos setTimeout acá, podrían disparar una confirmación varios
    // segundos después de que el hook ya se desmontó (ej. el usuario cerró
    // sesión o cambió de restaurantes activos).
    for (const identifier of Object.keys(esperasVehiculoRef.current)) {
      clearTimeout(esperasVehiculoRef.current[identifier].timeoutId);
    }
    esperasVehiculoRef.current = {};
    watcherAltaFrecuenciaContadorRef.current = 0;
    if (watcherAltaFrecuenciaIdRef.current) {
      try {
        await BackgroundGeolocation.removeWatcher({ id: watcherAltaFrecuenciaIdRef.current });
      } catch (err) {
        console.warn('[useGeofencing] Error apagando watcher de alta frecuencia:', err.message);
      }
      watcherAltaFrecuenciaIdRef.current = null;
    }

    try {
      if (watcherIdRef.current) {
        await BackgroundGeolocation.removeWatcher({ id: watcherIdRef.current });
        watcherIdRef.current = null;
      }
      if (transitionListenerRef.current) {
        await transitionListenerRef.current.remove();
        transitionListenerRef.current = null;
      }
      for (const comercio of comerciosActivosRef.current) {
        try {
          await BackgroundGeolocation.removeGeofence({ identifier: comercio.id });
        } catch (err) {
          console.warn(`[useGeofencing] Error removiendo geocerca "${comercio.id}":`, err.message);
        }
      }
      comerciosActivosRef.current = [];
    } catch (err) {
      console.warn('[useGeofencing] Error deteniendo rastreo:', err.message);
    }
    dentroDeRangoRef.current = [];
    ultimaVelocidadRef.current = null;
    setEstado('idle');
    setDentroDeRango([]);
    setProximos([]);
  }, []);

  const limpiarNotifInApp = useCallback(() => setNotifInApp([]), []);

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) {
      console.warn('[useGeofencing] Geofencing nativo requiere build nativo (Android/iOS) — no funciona en navegador web');
      return;
    }
    if (restaurantes.length === 0) return;
    iniciarRastreo();
    return () => {
      detenerRastreo();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restaurantes.length]);

  return { dentroDeRango, estado, proximos, notifInApp, limpiarNotifInApp };
}
