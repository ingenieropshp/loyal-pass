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
 *    vía fetch, con `user_id` + las coordenadas del evento — el Edge
 *    Function es el único responsable de decidir y acreditar puntos; este
 *    hook ya no calcula ni inserta puntos por su cuenta.
 *
 *  - addWatcher() de bajo consumo (distanceFilter alto) usado SOLO para
 *    mantener actualizada la lista `proximos` que consume la UI. Está
 *    desacoplado por completo de la detección de entrada/salida: esa la
 *    resuelve el sistema operativo vía las geocercas nativas de arriba,
 *    el watcher no interviene en absoluto en esa lógica.
 *
 * Mantiene la interfaz de retorno exigida por GeofencingProvider.jsx:
 *   { dentroDeRango, estado, proximos, notifInApp, limpiarNotifInApp }
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { Capacitor } from '@capacitor/core';
import { BackgroundGeolocation } from '@capgo/background-geolocation';
import { LocalNotifications } from '@capacitor/local-notifications';
import { getDeviceId } from '../utils/deviceId';
import { supabase } from '../services/supabaseClient';

const CANAL_ID_GEOFENCE = 'geofence-alerts';

// Edge Function de Supabase. Recibe tanto el POST nativo del plugin (app
// cerrada, ver setupGeofencing más abajo) como el POST directo que este
// archivo dispara desde manejarTransicion cuando el WebView está vivo.
const GEOFENCE_WEBHOOK_URL = import.meta.env.VITE_GEOFENCE_WEBHOOK_URL;

// Requerida para que el Edge Function acepte la petición: sin Authorization
// (o apikey), Supabase la rechaza con 401 antes de que el handler llegue a
// leer el payload.
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Piso recomendado por Apple/plugins de geofencing nativo: por debajo de
// ~100m el margen de error normal del GPS (10-50m en ciudad, peor entre
// edificios altos) genera falsos negativos/positivos.
const RADIO_MINIMO_METROS = 100;

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
async function enviarEventoGeocercaWebhook(userId, restauranteId, latitude, longitude) {
  if (!GEOFENCE_WEBHOOK_URL) {
    console.warn('[useGeofencing] Falta VITE_GEOFENCE_WEBHOOK_URL — no se envía el evento de geocerca');
    return;
  }
  if (!userId) {
    console.warn('[useGeofencing] No hay user_id resuelto (¿sesión no iniciada?) — se omite el POST de geocerca');
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
        user_id: userId,
        restaurante_id: restauranteId,
        latitude,
        longitude,
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
  const userIdRef = useRef(null);

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
            body: comercio.mensaje_promo || `Confirma tu llegada y gana +${comercio.puntos_llegada} puntos`,
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

  // Callback del evento nativo 'geofenceTransition'. Forma real confirmada
  // contra la documentación oficial de @capgo/background-geolocation v8:
  // { identifier, transition: 'enter'|'exit', enter: boolean, latitude, longitude, radius, payload }
  // OJO: `transition` viene en MINÚSCULAS ('enter' / 'exit'), no 'ENTER'/'EXIT'.
  // Usamos el booleano `enter` como fuente de verdad porque no depende de
  // mayúsculas/minúsculas ni de nombres de string que el plugin pueda ajustar.
  const manejarTransicion = useCallback(
    (evento) => {
      const { identifier, transition, enter, latitude, longitude } = evento || {};
      if (!identifier) return;
      const comercio = comerciosActivosRef.current.find((c) => c.id === String(identifier));
      if (!comercio) return;

      const esEntrada = typeof enter === 'boolean' ? enter : String(transition).toLowerCase() === 'enter';
      const esSalida  = typeof enter === 'boolean' ? !enter : String(transition).toLowerCase() === 'exit';

      if (esEntrada) {
        setDentroDeRango((prev) => (prev.includes(identifier) ? prev : [...prev, identifier]));
        mostrarNotifNativa(comercio);
        setNotifInApp((prev) => [
          ...prev,
          {
            id: `${identifier}-${Date.now()}`,
            restauranteId: identifier,
            nombre: comercio.nombre,
            mensaje: comercio.mensaje_promo || `Confirma tu llegada y gana +${comercio.puntos_llegada} puntos`,
            timestamp: Date.now(),
          },
        ]);

        // Solo se reporta una vez por visita: si ya está marcada como "en
        // curso" para este comercio, no se vuelve a llamar al webhook hasta
        // que ocurra el 'exit' correspondiente.
        if (!yaNotificadaEnEstaVisita(identifier)) {
          marcarVisitaEnCurso(identifier, true);
          enviarEventoGeocercaWebhook(userIdRef.current, identifier, latitude, longitude);
        }
      }

      if (esSalida) {
        setDentroDeRango((prev) => prev.filter((id) => id !== identifier));
        marcarVisitaEnCurso(identifier, false);
      }
    },
    [mostrarNotifNativa]
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

      // user_id: quién reporta el evento al Edge Function. Se resuelve una
      // sola vez por arranque de rastreo, igual que deviceId abajo.
      const { data: userData, error: userError } = await supabase.auth.getUser();
      if (userError) {
        console.warn('[useGeofencing] No se pudo resolver el usuario autenticado:', userError.message);
      }
      userIdRef.current = userData?.user?.id ?? null;

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
          if (location) actualizarProximos(location.latitude, location.longitude);
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
