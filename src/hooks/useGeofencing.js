/**
 * useGeofencing.js — LoyalPass v4.0
 *
 * CAMBIOS CLAVE vs v3:
 *  1. Sin cooldown de 2h → detección de BORDE (fuera→dentro) en el SW
 *  2. Envía restaurantes al SW (CACHE_RESTAURANTS) para chequeo en background
 *  3. Envía posición GPS al SW (LOCATION_UPDATE) en cada actualización
 *  4. Escucha REQUEST_LOCATION del SW (Periodic Background Sync)
 *  5. Registra Periodic Background Sync si la PWA está instalada
 */

import { useState, useEffect, useRef, useCallback } from 'react';

const VAPID_PUBLIC_KEY  = import.meta.env.VITE_VAPID_PUBLIC_KEY;
const SUPABASE_URL      = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Ruta del sonido de "ping" que se reproduce al entrar al radio de un restaurante.
// Debe existir físicamente en public/sounds/ping.mp3 para que Vite lo sirva tal cual.
const SONIDO_PING_URL = '/sounds/ping.mp3';

// ── VAPID helper ──────────────────────────────────────────────────────────────
function urlBase64ToUint8Array(b64) {
  const pad  = '='.repeat((4 - (b64.length % 4)) % 4);
  const base = (b64 + pad).replace(/-/g, '+').replace(/_/g, '/');
  return new Uint8Array([...atob(base)].map(c => c.charCodeAt(0)));
}

// ── Hook ──────────────────────────────────────────────────────────────────────
export function useGeofencing(restaurantes = []) {
  const [estado,        setEstado]        = useState('idle');
  const [dentroDeRango, setDentroDeRango] = useState([]);

  const watchIdRef      = useRef(null);
  const swRegRef        = useRef(null);
  const restaurantesRef = useRef([]);

  // ── Refs para el sonido de ping ────────────────────────────────────────────
  // audioRef: instancia única del <audio>, se crea una sola vez (lazy) para no
  //           recrear el objeto Audio en cada render.
  const audioRef = useRef(null);
  // audioDesbloqueadoRef: en iOS/Android los navegadores bloquean audio.play()
  //           si no hubo una interacción del usuario (tap/click) antes. Esta
  //           bandera indica si ya "desbloqueamos" el audio con un gesto real.
  const audioDesbloqueadoRef = useRef(false);
  // NOTA sobre duplicados: el control de "solo una vez por entrada" NO se
  // maneja aquí. El Service Worker (sw.js) es la única fuente de verdad para
  // la detección de borde fuera→dentro (usa su propio `estadoRango` interno)
  // y nos avisa vía postMessage('GEOFENCE_ENTERED') solo cuando corresponde.
  // Duplicar esa lógica en React causaría dos detecciones independientes que
  // podrían desincronizarse (y notificaciones duplicadas), así que React solo
  // reacciona al aviso del SW en vez de recalcular el borde por su cuenta.

  useEffect(() => { restaurantesRef.current = restaurantes; }, [restaurantes]);

  // ── Obtener (o crear) la instancia de Audio, una sola vez ────────────────
  const obtenerAudio = useCallback(() => {
    if (!audioRef.current) {
      audioRef.current = new Audio(SONIDO_PING_URL);
      audioRef.current.preload = 'auto'; // pre-cargar el mp3 para reproducción instantánea
    }
    return audioRef.current;
  }, []);

  // ── Desbloquear audio en el primer gesto del usuario (requisito iOS/Android) ─
  // Los navegadores móviles solo permiten reproducir audio mediante JS si esa
  // reproducción ocurre como resultado directo (o muy cercano) de una interacción
  // del usuario. Aprovechamos el primer tap/click en cualquier parte de la app
  // para "primar" el audio: lo reproducimos y pausamos inmediatamente en silencio.
  // A partir de ahí, el navegador nos deja reproducirlo programáticamente
  // (por ejemplo, al detectar el geofence) sin que sea un gesto directo.
  useEffect(() => {
    const desbloquear = () => {
      if (audioDesbloqueadoRef.current) return; // ya desbloqueado, nada que hacer
      const audio = obtenerAudio();
      const promesa = audio.play();
      if (promesa?.then) {
        promesa
          .then(() => {
            audio.pause();
            audio.currentTime = 0;
            audioDesbloqueadoRef.current = true;
          })
          .catch(() => {
            // El navegador todavía lo bloqueó; se reintentará en el próximo gesto
          });
      } else {
        audioDesbloqueadoRef.current = true;
      }
    };

    // 'once: true' remueve el listener automáticamente tras el primer disparo exitoso;
    // igual lo removemos manualmente en el cleanup por si el componente se desmonta antes.
    window.addEventListener('touchend', desbloquear, { passive: true });
    window.addEventListener('click',    desbloquear);

    return () => {
      window.removeEventListener('touchend', desbloquear);
      window.removeEventListener('click',    desbloquear);
    };
  }, [obtenerAudio]);

  // ── Reproducir el ping de forma segura (maneja el rechazo de la promesa) ──
  const reproducirPing = useCallback(() => {
    const audio = obtenerAudio();
    try {
      audio.currentTime = 0; // reiniciar por si quedó a mitad de reproducción de una vez anterior
      const promesa = audio.play();
      if (promesa?.catch) {
        promesa.catch((err) => {
          // Autoplay bloqueado (usuario aún no interactuó con la página) u otro
          // error de reproducción. No rompemos el flujo de geofencing por esto.
          console.warn('[Geofencing] No se pudo reproducir ping.mp3:', err.message);
        });
      }
    } catch (err) {
      console.warn('[Geofencing] Error al reproducir ping.mp3:', err.message);
    }
  }, [obtenerAudio]);

  // ── Enviar datos al SW ────────────────────────────────────────────────────
  const enviarAlSW = useCallback((type, payload) => {
    if (!swRegRef.current?.active) return;
    swRegRef.current.active.postMessage({ type, payload });
  }, []);

  // ── Inicializar SW + Push + Periodic Sync ────────────────────────────────
  const inicializarSW = useCallback(async (listaRestaurantes) => {
    if (!('serviceWorker' in navigator)) return;

    try {
      const reg = await navigator.serviceWorker.ready;
      swRegRef.current = reg;

      // 1. Enviar restaurantes al SW para que los use en background
      const urlBase = `${window.location.origin}/?r=`;
      const restosSW = listaRestaurantes.map(r => ({
        ...r,
        urlApp: `${urlBase}${r.restaurante_id}`,
      }));
      reg.active?.postMessage({ type: 'CACHE_RESTAURANTS', payload: { restaurantes: restosSW } });

      // 2. Suscripción push (para notifs cuando la app está cerrada via Edge Function)
      if (Notification.permission === 'granted' && VAPID_PUBLIC_KEY) {
        let sub = await reg.pushManager.getSubscription();
        if (!sub) {
          sub = await reg.pushManager.subscribe({
            userVisibleOnly:      true,
            applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
          });
        }
        // Guardar suscripción en Supabase — incluir restauranteId para que
        // check-geofence pueda filtrar suscripciones por restaurante
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
            restauranteId: primerRestaurante,   // ← fix: sin esto push_subscriptions.restaurante_id queda null
          }),
        }).catch(() => {});
      }

      // 3. Periodic Background Sync (Chrome Android con PWA instalada)
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
  }, [enviarAlSW]);

  // ── Escuchar mensajes del SW (REQUEST_LOCATION / GEOFENCE_ENTERED) ────────
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    const handleSWMessage = (event) => {
      // El SW despertó por Periodic Sync y nos pide nuestra posición actual
      if (event.data?.type === 'REQUEST_LOCATION') {
        navigator.geolocation?.getCurrentPosition((pos) => {
          enviarAlSW('LOCATION_UPDATE', {
            lat: pos.coords.latitude,
            lon: pos.coords.longitude,
          });
        }, () => {}, { maximumAge: 60_000 });
        return;
      }

      // El SW detectó la entrada al radio de un restaurante (borde fuera→dentro)
      // y ya mostró/mostrará la Notification nativa. Aquí solo reproducimos el
      // ping, sincronizado exactamente con ese evento y sin recalcular nada.
      if (event.data?.type === 'GEOFENCE_ENTERED') {
        reproducirPing();
      }
    };

    navigator.serviceWorker.addEventListener('message', handleSWMessage);
    return () => navigator.serviceWorker.removeEventListener('message', handleSWMessage);
  }, [enviarAlSW, reproducirPing]);

  // ── Procesar posición GPS ─────────────────────────────────────────────────
  const procesarPosicion = useCallback((pos) => {
    const { latitude: uLat, longitude: uLon } = pos.coords;

    // Enviar posición al SW → él hace el chequeo de geofence y muestra la notif
    // Esto funciona incluso con la app en background porque el SW sigue vivo
    enviarAlSW('LOCATION_UPDATE', { lat: uLat, lon: uLon });

    // También actualizar estado de React para el UI (badge "Estás aquí").
    // Este cálculo es solo informativo para la interfaz: la detección real de
    // "entrada" (borde fuera→dentro) que dispara sonido + notificación vive en
    // el SW, que es quien recibe este mismo LOCATION_UPDATE arriba.
    const enRango = restaurantesRef.current
      .filter(r => {
        const rLat = parseFloat(r.latitud);
        const rLon = parseFloat(r.longitud);
        const radio = parseInt(r.radio_aviso) || 200;
        if (isNaN(rLat) || isNaN(rLon)) return false;
        const R = 6_371_000;
        const dLat = ((r.latitud - uLat) * Math.PI) / 180;
        const dLon = ((r.longitud - uLon) * Math.PI) / 180;
        const a = Math.sin(dLat/2)**2 + Math.cos(uLat*Math.PI/180)*Math.cos(rLat*Math.PI/180)*Math.sin(dLon/2)**2;
        const dist = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
        return dist <= radio;
      })
      .map(r => r.restaurante_id);

    setDentroDeRango(enRango);
  }, [enviarAlSW]);

  // ── Iniciar rastreo ───────────────────────────────────────────────────────
  const iniciarRastreo = useCallback(async (listaRestaurantes) => {
    if (!('geolocation' in navigator)) { setEstado('no_soportado'); return; }

    setEstado('solicitando_permiso');

    // Pedir permiso de notificaciones
    if (Notification.permission === 'default') {
      await Notification.requestPermission();
    }

    // Inicializar SW con la lista de restaurantes
    await inicializarSW(listaRestaurantes);

    // Iniciar GPS continuo
    watchIdRef.current = navigator.geolocation.watchPosition(
      procesarPosicion,
      (err) => {
        console.warn('[Geofencing] Error GPS:', err.message);
        if (err.code === 1) setEstado('sin_permiso');
      },
      {
        enableHighAccuracy: true,
        timeout:            15_000,
        maximumAge:         15_000, // 15s → más actualizaciones para background
      }
    );

    setEstado('rastreando');
    console.log('[Geofencing] Rastreo GPS iniciado ✅');
  }, [inicializarSW, procesarPosicion]);

  // ── Detener rastreo ───────────────────────────────────────────────────────
  const detenerRastreo = useCallback(() => {
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    setEstado('idle');
    setDentroDeRango([]);
  }, []);

  // ── Lifecycle: iniciar cuando llegan restaurantes ─────────────────────────
  useEffect(() => {
    if (restaurantes.length === 0) return;

    iniciarRastreo(restaurantes);

    // Re-enviar restaurantes al SW cuando cambien (ej: admin actualizó coordenadas)
    const urlBase = `${window.location.origin}/?r=`;
    const restosSW = restaurantes.map(r => ({ ...r, urlApp: `${urlBase}${r.restaurante_id}` }));
    enviarAlSW('CACHE_RESTAURANTS', { restaurantes: restosSW });

    return () => detenerRastreo();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restaurantes.length]);

  // Re-enviar restaurantes al SW cuando el SW se activa (recarga de página)
  useEffect(() => {
    if (!('serviceWorker' in navigator) || restaurantes.length === 0) return;
    navigator.serviceWorker.ready.then(reg => {
      swRegRef.current = reg;
      const urlBase = `${window.location.origin}/?r=`;
      const restosSW = restaurantes.map(r => ({ ...r, urlApp: `${urlBase}${r.restaurante_id}` }));
      reg.active?.postMessage({ type: 'CACHE_RESTAURANTS', payload: { restaurantes: restosSW } });
    });
  }, [restaurantes]);

  return { estado, dentroDeRango, iniciarRastreo, detenerRastreo };
}