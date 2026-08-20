/**
 * useGeofencing.js — LoyalPass v5.3
 *
 * CAMBIOS CLAVE vs v5.2:
 *  - Canal de notificación dedicado en Android (createChannel) con
 *    SONIDO_NATIVO ya incluido, creado ANTES de la primera notificación.
 *    Sin esto, en Android 8+ el campo `sound` de schedule() no garantiza
 *    que suene el audio personalizado (el sonido vive en el canal, no en
 *    la notificación individual, y los canales son inmutables una vez
 *    creados).
 *  - Listener 'localNotificationActionPerformed' para manejar el tap en la
 *    notificación nativa y navegar a la URL del restaurante (antes la
 *    notificación se mostraba pero tocarla no hacía nada).
 *
 * CAMBIOS CLAVE vs v5.1:
 *  - Se elimina por completo cualquier import (estático o dinámico) de
 *    '@capacitor-community/background-geolocation'. El intento de v5.1 con
 *    `await import(...)` seguía fallando en build porque Rolldown analiza el
 *    string literal del import dinámico e igual intenta resolver el paquete
 *    en node_modules — y esa resolución venía fallando ahí (paquete
 *    ausente/roto en este proyecto), no por ser estático vs dinámico.
 *  - Solución real (según el propio README del plugin): el wrapper JS de
 *    @capacitor-community/background-geolocation es un simple proxy creado
 *    con `registerPlugin('BackgroundGeolocation')` de @capacitor/core. La
 *    implementación nativa (Java/Swift) ya quedó instalada con
 *    `npm install` + `npx cap sync android/ios`, totalmente independiente
 *    del paquete JS del wrapper. Así que registramos el plugin nosotros
 *    mismos con la misma función que ya usa @capacitor/core internamente,
 *    sin depender de que ese paquete se resuelva en el bundle web.
 *    → vite.config.js NO necesita ningún cambio (external, alias, etc.).
 *
 * CAMBIOS CLAVE vs v4:
 *  1. Soporte nativo Capacitor: en Android/iOS empaquetados usa
 *     background-geolocation (GPS en 2do plano, bajo consumo) +
 *     @capacitor/local-notifications (notificación en pantalla de bloqueo
 *     con sonido personalizado), en vez de watchPosition + SW.
 *  2. En navegador web tradicional (Capacitor.isNativePlatform() === false)
 *     se mantiene EXACTAMENTE el flujo v4: watchPosition + Service Worker
 *     (sw.js) + Web Push, sin cambios de comportamiento.
 *  3. La detección de borde (fuera→dentro) para el camino nativo vive en un
 *     ref local de este hook (estadoRangoNativoRef), equivalente al
 *     `estadoRango` que ya existía dentro de sw.js para el camino web.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';

// Proxy hacia la implementación NATIVA del plugin (Java/Swift), instalada
// vía `npx cap sync`. No importa el paquete '@capacitor-community/
// background-geolocation' de npm — por eso Vite/Rolldown ya no necesita
// resolverlo y `npm run build` deja de fallar. En camino web esta constante
// existe pero nunca se invoca (guardada detrás de `esNativo`).
const BackgroundGeolocation = registerPlugin('BackgroundGeolocation');

const VAPID_PUBLIC_KEY  = import.meta.env.VITE_VAPID_PUBLIC_KEY;
const SUPABASE_URL      = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Sonido del ping en foreground (solo camino WEB). Debe existir en public/sounds/.
const SONIDO_PING_URL = '/sounds/ping.mp3';

// Nombre del sonido para la notificación NATIVA (pantalla de bloqueo).
// ⚠️ OJO ANDROID: el plugin busca este archivo como recurso "raw" en
// android/app/src/main/res/raw/, y los nombres de recursos Android SOLO
// admiten [a-z0-9_] (sin guiones, sin mayúsculas). Por eso NO se puede usar
// el nombre original "mixkit-happy-bells-notification-937.wav" tal cual:
// hay que copiar el archivo a res/raw/ renombrado a snake_case:
//   android/app/src/main/res/raw/mixkit_happy_bells_notification_937.wav
// En iOS el archivo debe agregarse al bundle de Xcode (arrastrarlo al target
// "App" → "Copy Bundle Resources") y ahí sí puede conservar el nombre con
// guiones — pero para no duplicar lógica por plataforma, referenciamos el
// mismo nombre normalizado en ambas y usamos ese archivo también en iOS.
const SONIDO_NATIVO = 'mixkit_happy_bells_notification_937.wav';

// ── Canal de notificación (solo Android) ──────────────────────────────────────
// A partir de Android 8 (API 26+) el sonido de una notificación NO se define
// por notificación individual: se define una sola vez en el "canal" al que
// esa notificación pertenece, y el canal es inmutable una vez creado (si lo
// creás sin sonido y luego querés agregarlo, el sistema ignora el cambio —
// hay que crear el canal ANTES con el sonido ya incluido). Por eso creamos
// un canal dedicado con SONIDO_NATIVO antes de la primera notificación.
const CANAL_ID_GEOFENCE = 'geofence-cercania';

async function asegurarCanalNotificacionNativo() {
  if (Capacitor.getPlatform() !== 'android') return; // los canales son un concepto exclusivo de Android

  try {
    await LocalNotifications.createChannel({
      id:          CANAL_ID_GEOFENCE,
      name:        'Cercanía a restaurantes',
      description: 'Avisos cuando estás cerca de un restaurante afiliado',
      importance:  5, // IMPORTANCE_HIGH → heads-up + sonido; con menos, Android puede silenciarla
      sound:       SONIDO_NATIVO, // mismo archivo que debe existir en android/app/src/main/res/raw/
      visibility:  1,
    });
  } catch (err) {
    console.warn('[Geofencing] Error creando canal de notificación:', err.message);
  }
}

// ── VAPID helper (solo camino web) ────────────────────────────────────────────
function urlBase64ToUint8Array(b64) {
  const pad  = '='.repeat((4 - (b64.length % 4)) % 4);
  const base = (b64 + pad).replace(/-/g, '+').replace(/_/g, '/');
  return new Uint8Array([...atob(base)].map(c => c.charCodeAt(0)));
}

// Haversine — lo usan tanto el camino web (badge de UI) como el nativo
// (detección de entrada, ya que en nativo no hay Service Worker que lo haga).
function distanciaMetros(lat1, lon1, lat2, lon2) {
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

// LocalNotifications.schedule requiere un id numérico (int32) por notificación.
// restaurante_id puede ser un UUID/string, así que lo convertimos a un entero
// estable vía hash simple (mismo restaurante → mismo id → se reemplaza, no se duplica).
function idNumericoDesde(texto) {
  const str = String(texto);
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) || 1;
}

// ── Hook ──────────────────────────────────────────────────────────────────────
export function useGeofencing(restaurantes = []) {
  const esNativo = Capacitor.isNativePlatform();

  const [estado,        setEstado]        = useState('idle');
  const [dentroDeRango, setDentroDeRango] = useState([]);

  const watchIdRef          = useRef(null); // watchPosition (web)
  const watcherIdNativoRef  = useRef(null); // BackgroundGeolocation (nativo)
  const swRegRef            = useRef(null);
  const restaurantesRef     = useRef([]);
  const estadoRangoNativoRef = useRef({}); // { [restaurante_id]: true/false } — solo camino nativo

  // ── Refs para el sonido de ping (solo camino web) ─────────────────────────
  const audioRef = useRef(null);
  const audioDesbloqueadoRef = useRef(false);

  useEffect(() => { restaurantesRef.current = restaurantes; }, [restaurantes]);

  const obtenerAudio = useCallback(() => {
    if (!audioRef.current) {
      audioRef.current = new Audio(SONIDO_PING_URL);
      audioRef.current.preload = 'auto';
    }
    return audioRef.current;
  }, []);

  // El desbloqueo de audio HTML5 por gesto del usuario solo tiene sentido en
  // el camino web; en nativo el sonido lo dispara LocalNotifications (SONIDO_NATIVO).
  useEffect(() => {
    if (esNativo) return;

    const desbloquear = () => {
      if (audioDesbloqueadoRef.current) return;
      const audio = obtenerAudio();
      const promesa = audio.play();
      if (promesa?.then) {
        promesa
          .then(() => {
            audio.pause();
            audio.currentTime = 0;
            audioDesbloqueadoRef.current = true;
          })
          .catch(() => {});
      } else {
        audioDesbloqueadoRef.current = true;
      }
    };

    window.addEventListener('touchend', desbloquear, { passive: true });
    window.addEventListener('click',    desbloquear);

    return () => {
      window.removeEventListener('touchend', desbloquear);
      window.removeEventListener('click',    desbloquear);
    };
  }, [esNativo, obtenerAudio]);

  const reproducirPing = useCallback(() => {
    if (esNativo) return;
    const audio = obtenerAudio();
    try {
      audio.currentTime = 0;
      const promesa = audio.play();
      if (promesa?.catch) {
        promesa.catch((err) => {
          console.warn('[Geofencing] No se pudo reproducir ping.mp3:', err.message);
        });
      }
    } catch (err) {
      console.warn('[Geofencing] Error al reproducir ping.mp3:', err.message);
    }
  }, [esNativo, obtenerAudio]);

  // ════════════════════════════════════════════════════════════════════════
  // CAMINO WEB (navegador tradicional) — igual que v4, sin cambios de lógica
  // ════════════════════════════════════════════════════════════════════════

  const enviarAlSW = useCallback((type, payload) => {
    if (esNativo || !swRegRef.current?.active) return;
    swRegRef.current.active.postMessage({ type, payload });
  }, [esNativo]);

  const inicializarSW = useCallback(async (listaRestaurantes) => {
    if (esNativo || !('serviceWorker' in navigator)) return;

    try {
      const reg = await navigator.serviceWorker.ready;
      swRegRef.current = reg;

      const urlBase = `${window.location.origin}/?r=`;
      const restosSW = listaRestaurantes.map(r => ({
        ...r,
        urlApp: `${urlBase}${r.restaurante_id}`,
      }));
      reg.active?.postMessage({ type: 'CACHE_RESTAURANTS', payload: { restaurantes: restosSW } });

      if (Notification.permission === 'granted' && VAPID_PUBLIC_KEY) {
        let sub = await reg.pushManager.getSubscription();
        if (!sub) {
          sub = await reg.pushManager.subscribe({
            userVisibleOnly:      true,
            applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
          });
        }
        const primerRestaurante = listaRestaurantes[0]?.restaurante_id ?? null;
        fetch(`${SUPABASE_URL}/functions/v1/save-push-subscription`, {
          method:  'POST',
          headers: {
            'Content-Type':  'application/json',
            'apikey':        SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
          },
          body: JSON.stringify({
            subscription:  sub.toJSON(),
            restauranteId: primerRestaurante,
          }),
        }).catch(() => {});
      }

      if ('periodicSync' in reg) {
        try {
          const perm = await navigator.permissions.query({ name: 'periodic-background-sync' });
          if (perm.state === 'granted') {
            await reg.periodicSync.register('geofence-check', { minInterval: 15 * 60 * 1000 });
            console.log('[Geofencing] Periodic Background Sync registrado ✅');
          }
        } catch {
          // No soportado en este navegador — no es crítico
        }
      }

    } catch (err) {
      console.warn('[Geofencing] Error inicializando SW:', err.message);
    }
  }, [esNativo]);

  useEffect(() => {
    if (esNativo || !('serviceWorker' in navigator)) return;

    const handleSWMessage = (event) => {
      if (event.data?.type === 'REQUEST_LOCATION') {
        navigator.geolocation?.getCurrentPosition((pos) => {
          enviarAlSW('LOCATION_UPDATE', {
            lat: pos.coords.latitude,
            lon: pos.coords.longitude,
          });
        }, () => {}, { maximumAge: 60_000 });
        return;
      }
      if (event.data?.type === 'GEOFENCE_ENTERED') {
        reproducirPing();
      }
    };

    navigator.serviceWorker.addEventListener('message', handleSWMessage);
    return () => navigator.serviceWorker.removeEventListener('message', handleSWMessage);
  }, [esNativo, enviarAlSW, reproducirPing]);

  const procesarPosicionWeb = useCallback((pos) => {
    const { latitude: uLat, longitude: uLon } = pos.coords;

    enviarAlSW('LOCATION_UPDATE', { lat: uLat, lon: uLon });

    const enRango = restaurantesRef.current
      .filter(r => {
        const rLat = parseFloat(r.latitud);
        const rLon = parseFloat(r.longitud);
        const radio = parseInt(r.radio_aviso) || 200;
        if (isNaN(rLat) || isNaN(rLon)) return false;
        return distanciaMetros(uLat, uLon, rLat, rLon) <= radio;
      })
      .map(r => r.restaurante_id);

    setDentroDeRango(enRango);
  }, [enviarAlSW]);

  const iniciarRastreoWeb = useCallback(async (listaRestaurantes) => {
    if (!('geolocation' in navigator)) { setEstado('no_soportado'); return; }

    setEstado('solicitando_permiso');

    if (Notification.permission === 'default') {
      await Notification.requestPermission();
    }

    await inicializarSW(listaRestaurantes);

    watchIdRef.current = navigator.geolocation.watchPosition(
      procesarPosicionWeb,
      (err) => {
        console.warn('[Geofencing] Error GPS:', err.message);
        if (err.code === 1) setEstado('sin_permiso');
      },
      {
        enableHighAccuracy: true,
        timeout:            15_000,
        maximumAge:         15_000,
      }
    );

    setEstado('rastreando');
    console.log('[Geofencing] Rastreo GPS (web) iniciado ✅');
  }, [inicializarSW, procesarPosicionWeb]);

  const detenerRastreoWeb = useCallback(() => {
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    setEstado('idle');
    setDentroDeRango([]);
  }, []);

  // ── Manejar el tap en la notificación nativa (abrir el restaurante) ───────
  // Equivalente al listener 'notificationclick' de sw.js, que ahí abre/enfoca
  // la ventana y navega a resto.urlApp. En nativo no hay "ventanas": se
  // maneja con este listener del propio plugin.
  useEffect(() => {
    if (!esNativo) return;

    const listenerPromise = LocalNotifications.addListener(
      'localNotificationActionPerformed',
      (accion) => {
        const url = accion.notification?.extra?.url;
        if (url) {
          // Si la app usa un router client-side (react-router, etc.), lo ideal
          // es reemplazar esta línea por una navegación programática (ej.
          // navigate(url)) para evitar el reload completo que hace location.href.
          window.location.href = url;
        }
      }
    );

    return () => { listenerPromise.then((listener) => listener.remove()); };
  }, [esNativo]);

  // ════════════════════════════════════════════════════════════════════════
  // CAMINO NATIVO (Capacitor Android/iOS)
  // ════════════════════════════════════════════════════════════════════════

  // Reemplaza a mostrarNotifGeofence() de sw.js para este camino: muestra la
  // notificación local en pantalla de bloqueo con el sonido personalizado.
  const mostrarNotifNativa = useCallback(async (resto) => {
    const puntosLlegada = resto.puntos_llegada ?? 2;
    const urlApp        = resto.urlApp || `${window.location.origin}/?r=${resto.restaurante_id}`;

    try {
      await LocalNotifications.schedule({
        notifications: [
          {
            id:        idNumericoDesde(resto.restaurante_id),
            title:     `📍 Estás cerca de ${resto.nombre}`,
            body:      resto.mensaje_geofence?.trim()
                       || resto.mensaje_promo?.trim()
                       || `Confirma tu llegada y gana +${puntosLlegada} puntos`,
            sound:     SONIDO_NATIVO,
            channelId: CANAL_ID_GEOFENCE, // Android: define qué canal (y por lo tanto qué sonido) usa
            smallIcon: 'ic_stat_icon',
            extra:     { url: urlApp, restauranteId: resto.restaurante_id },
          },
        ],
      });
      console.log(`[Geofencing] 🔔 Notificación nativa enviada: ${resto.nombre}`);
    } catch (err) {
      console.warn('[Geofencing] Error mostrando notificación nativa:', err.message);
    }
  }, []);

  // Equivalente a verificarGeofence() de sw.js: en nativo no hay Service
  // Worker corriendo el chequeo, así que la detección de borde (fuera→dentro)
  // vive acá, con la misma regla de "solo notificar al entrar".
  const verificarGeofenceNativo = useCallback((uLat, uLon) => {
    const listaActual = restaurantesRef.current;
    if (listaActual.length === 0) return;

    const enRango = [];

    for (const resto of listaActual) {
      const rLat  = parseFloat(resto.latitud);
      const rLon  = parseFloat(resto.longitud);
      const radio = parseInt(resto.radio_aviso) || 200;
      const rId   = resto.restaurante_id;
      if (isNaN(rLat) || isNaN(rLon) || !rId) continue;

      const dist        = distanciaMetros(uLat, uLon, rLat, rLon);
      const dentroAhora  = dist <= radio;
      const estabaAntes  = estadoRangoNativoRef.current[rId] === true;

      if (dentroAhora) enRango.push(rId);

      if (dentroAhora && !estabaAntes) {
        console.log(`[Geofencing] 🟢 Entró al rango de ${resto.nombre} (${Math.round(dist)}m)`);
        mostrarNotifNativa(resto);
      }
      if (!dentroAhora && estabaAntes) {
        console.log(`[Geofencing] 🔴 Salió del rango de ${resto.nombre}`);
      }

      estadoRangoNativoRef.current[rId] = dentroAhora;
    }

    setDentroDeRango(enRango);
  }, [mostrarNotifNativa]);

  const iniciarRastreoNativo = useCallback(async () => {
    setEstado('solicitando_permiso');

    try {
      // Permiso de notificaciones locales (POST_NOTIFICATIONS en Android 13+, iOS)
      const permisoNotif = await LocalNotifications.requestPermissions();
      if (permisoNotif.display !== 'granted') {
        console.warn('[Geofencing] Permiso de notificaciones no concedido');
      }

      // Crear/asegurar el canal ANTES de la primera notificación (Android).
      await asegurarCanalNotificacionNativo();

      // addWatcher con requestPermissions:true dispara internamente los
      // diálogos de ACCESS_FINE_LOCATION / ACCESS_COARSE_LOCATION y, en
      // Android, el paso adicional para ACCESS_BACKGROUND_LOCATION; en iOS
      // dispara "When In Use" y luego el upgrade a "Always" según los
      // textos de Info.plist ya configurados.
      const watcherId = await BackgroundGeolocation.addWatcher(
        {
          backgroundTitle:     'LoyalPass está activo',
          backgroundMessage:   'Te avisaremos cuando estés cerca de tus restaurantes favoritos.',
          requestPermissions:  true,
          stale:               false,
          distanceFilter:      15, // metros — evita procesar cada micro-movimiento
        },
        (location, error) => {
          if (error) {
            console.warn('[Geofencing] Error BackgroundGeolocation:', error.message);
            if (error.code === 'NOT_AUTHORIZED') setEstado('sin_permiso');
            return;
          }
          if (location) {
            verificarGeofenceNativo(location.latitude, location.longitude);
          }
        }
      );

      watcherIdNativoRef.current = watcherId;
      setEstado('rastreando');
      console.log('[Geofencing] Rastreo GPS (nativo) iniciado ✅');
    } catch (err) {
      console.warn('[Geofencing] Error inicializando rastreo nativo:', err.message);
      setEstado('sin_permiso');
    }
  }, [verificarGeofenceNativo]);

  const detenerRastreoNativo = useCallback(async () => {
    if (watcherIdNativoRef.current !== null) {
      try {
        await BackgroundGeolocation.removeWatcher({ id: watcherIdNativoRef.current });
      } catch (err) {
        console.warn('[Geofencing] Error deteniendo rastreo nativo:', err.message);
      }
      watcherIdNativoRef.current = null;
    }
    estadoRangoNativoRef.current = {};
    setEstado('idle');
    setDentroDeRango([]);
  }, []);

  // ════════════════════════════════════════════════════════════════════════
  // API pública unificada — despacha al camino nativo o web según corresponda
  // ════════════════════════════════════════════════════════════════════════

  const iniciarRastreo = useCallback(async (listaRestaurantes) => {
    if (esNativo) {
      await iniciarRastreoNativo();
    } else {
      await iniciarRastreoWeb(listaRestaurantes);
    }
  }, [esNativo, iniciarRastreoNativo, iniciarRastreoWeb]);

  const detenerRastreo = useCallback(() => {
    if (esNativo) {
      detenerRastreoNativo();
    } else {
      detenerRastreoWeb();
    }
  }, [esNativo, detenerRastreoNativo, detenerRastreoWeb]);

  // ── Lifecycle: iniciar cuando llegan restaurantes ─────────────────────────
  useEffect(() => {
    if (restaurantes.length === 0) return;

    iniciarRastreo(restaurantes);

    // Re-enviar restaurantes actualizados al SW (solo camino web — en nativo
    // restaurantesRef ya se mantiene sincronizado con el efecto de arriba).
    if (!esNativo) {
      const urlBase = `${window.location.origin}/?r=`;
      const restosSW = restaurantes.map(r => ({ ...r, urlApp: `${urlBase}${r.restaurante_id}` }));
      enviarAlSW('CACHE_RESTAURANTS', { restaurantes: restosSW });
    }

    return () => detenerRastreo();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restaurantes.length]);

  // Re-enviar restaurantes al SW cuando se activa (recarga de página) — solo web
  useEffect(() => {
    if (esNativo || !('serviceWorker' in navigator) || restaurantes.length === 0) return;
    navigator.serviceWorker.ready.then(reg => {
      swRegRef.current = reg;
      const urlBase = `${window.location.origin}/?r=`;
      const restosSW = restaurantes.map(r => ({ ...r, urlApp: `${urlBase}${r.restaurante_id}` }));
      reg.active?.postMessage({ type: 'CACHE_RESTAURANTS', payload: { restaurantes: restosSW } });
    });
  }, [esNativo, restaurantes]);

  return { estado, dentroDeRango, iniciarRastreo, detenerRastreo };
}