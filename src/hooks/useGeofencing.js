/**
 * useGeofencing.js — Bistro Connect v3.0
 *
 * FLUJO PRINCIPAL:
 *  - App ABIERTA:  showNotification() directo desde el SW (inmediato, sin Edge Function)
 *  - App CERRADA:  Edge Function check-geofence → web-push → SW
 *
 * Cuando el usuario entra al rango de un restaurante muestra:
 *  "📍 Estás cerca de [Nombre]"
 *  "Confirma tu llegada y gana +N puntos"
 */

import { useState, useEffect, useRef, useCallback } from 'react';

const COOLDOWN_MS        = 2 * 60 * 60 * 1000; // 2 horas entre notifs del mismo restaurante
const LS_PREFIX          = 'bistro_geo_cd_';
const VAPID_PUBLIC_KEY   = import.meta.env.VITE_VAPID_PUBLIC_KEY;
const SUPABASE_URL        = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY   = import.meta.env.VITE_SUPABASE_ANON_KEY;

// ── Haversine ─────────────────────────────────────────────────────────────────
function distanciaM(lat1, lon1, lat2, lon2) {
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

// ── Cooldown ──────────────────────────────────────────────────────────────────
const cooldown = {
  ok:    (id) => Date.now() - parseInt(localStorage.getItem(`${LS_PREFIX}${id}`) || '0', 10) > COOLDOWN_MS,
  set:   (id) => localStorage.setItem(`${LS_PREFIX}${id}`, Date.now().toString()),
  clear: (id) => localStorage.removeItem(`${LS_PREFIX}${id}`),
};

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
  const swRegRef        = useRef(null);   // ServiceWorkerRegistration
  const suscripcionRef  = useRef(null);   // PushSubscription
  const restaurantesRef = useRef([]);
  const procesandoRef   = useRef(new Set());

  useEffect(() => { restaurantesRef.current = restaurantes; }, [restaurantes]);

  // ── Inicializar SW y suscripción push ─────────────────────────────────────
  const inicializarPush = useCallback(async () => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;

    try {
      const reg = await navigator.serviceWorker.ready;
      swRegRef.current = reg;

      if (!VAPID_PUBLIC_KEY) {
        console.error('[Geofencing] Falta VITE_VAPID_PUBLIC_KEY en .env');
        return;
      }

      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly:      true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
        });
        console.log('[Geofencing] Nueva suscripción push creada ✅');
      }
      suscripcionRef.current = sub;

      // Guardar suscripción en Supabase (para pushes cuando la app está cerrada)
      fetch(`${SUPABASE_URL}/functions/v1/save-push-subscription`, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'apikey':        SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({ subscription: sub.toJSON() }),
      }).catch(err => console.warn('[Geofencing] No se guardó suscripción:', err.message));

    } catch (err) {
      console.warn('[Geofencing] Error inicializando push:', err.message);
    }
  }, []);

  // ── Mostrar notificación LOCAL (app abierta) ──────────────────────────────
  // Este método es 100% confiable: no depende de Edge Functions ni internet
  const mostrarNotificacionLocal = useCallback(async (resto) => {
    const reg = swRegRef.current;
    if (!reg) return false;

    try {
      const puntosLlegada = resto.puntos_llegada ?? 2;
      const urlApp        = `${window.location.origin}/?r=${resto.restaurante_id}`;

      await reg.showNotification(`📍 Estás cerca de ${resto.nombre}`, {
        body:     `${resto.mensaje_promo || 'Confirma tu llegada'} y gana +${puntosLlegada} puntos.`,
        icon:     '/icons/icon-192.png',
        badge:    '/icons/badge-72.png',
        tag:      `bistro-cerca-${resto.restaurante_id}`,
        renotify: false,
        vibrate:  [200, 100, 200],
        data: {
          url:           urlApp,
          restauranteId: resto.restaurante_id,
        },
        actions: [
          { action: 'ver-menu', title: `Confirmar llegada (+${puntosLlegada} pts) ✅` },
          { action: 'dismiss',  title: 'Ahora no' },
        ],
      });

      console.log(`[Geofencing] ✅ Notificación local mostrada: ${resto.nombre}`);
      return true;
    } catch (err) {
      console.error('[Geofencing] Error mostrando notificación local:', err.message);
      return false;
    }
  }, []);

  // ── Llamar Edge Function (app cerrada / backup) ───────────────────────────
  const llamarEdgeFunction = useCallback(async (resto, uLat, uLon) => {
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/check-geofence`, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'apikey':        SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({
          restauranteId:   resto.restaurante_id,
          latitudUsuario:  uLat,
          longitudUsuario: uLon,
          subscription:    suscripcionRef.current?.toJSON() ?? null,
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        console.warn(`[Geofencing] Edge Function respondió ${res.status}:`, data?.error);
      }
    } catch (err) {
      console.warn('[Geofencing] Edge Function no disponible:', err.message);
      // No es crítico — la notificación local ya se mostró
    }
  }, []);

  // ── Procesar posición GPS ─────────────────────────────────────────────────
  const procesarPosicion = useCallback(async (pos) => {
    const { latitude: uLat, longitude: uLon } = pos.coords;
    const restos = restaurantesRef.current;
    const enRango = [];

    for (const resto of restos) {
      const rLat  = parseFloat(resto.latitud);
      const rLon  = parseFloat(resto.longitud);
      const radio = parseInt(resto.radio_aviso) || 200;
      const rId   = resto.restaurante_id;

      if (isNaN(rLat) || isNaN(rLon) || !rId) continue;

      const distM       = distanciaM(uLat, uLon, rLat, rLon);
      const dentroAhora = distM <= radio;

      if (dentroAhora) enRango.push(rId);

      // Disparar solo si: en rango + cooldown expirado + no hay otro proceso en curso
      if (dentroAhora && cooldown.ok(rId) && !procesandoRef.current.has(rId)) {
        procesandoRef.current.add(rId);
        cooldown.set(rId); // marcar ANTES para evitar doble disparo

        console.log(`[Geofencing] Usuario a ${Math.round(distM)}m de ${resto.nombre} (radio: ${radio}m)`);

        // PASO 1: Notificación local inmediata (no depende de servidor)
        await mostrarNotificacionLocal(resto);

        // PASO 2: Edge Function en paralelo (para registrar métrica + push cuando app cerrada)
        llamarEdgeFunction(resto, uLat, uLon).catch(() => {});

        procesandoRef.current.delete(rId);
      }
    }

    setDentroDeRango(enRango);
  }, [mostrarNotificacionLocal, llamarEdgeFunction]);

  // ── Iniciar rastreo ───────────────────────────────────────────────────────
  const iniciarRastreo = useCallback(async () => {
    if (!('geolocation' in navigator)) {
      setEstado('no_soportado');
      return;
    }

    setEstado('solicitando_permiso');

    // Pedir permiso de notificaciones
    if (Notification.permission === 'default') {
      await Notification.requestPermission();
    }

    // Inicializar push si hay permiso
    if (Notification.permission === 'granted') {
      await inicializarPush();
    } else {
      // Sin permiso de notificaciones, al menos guardar la reg del SW para el local
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.ready.then(reg => { swRegRef.current = reg; });
      }
    }

    // Iniciar watchPosition
    watchIdRef.current = navigator.geolocation.watchPosition(
      procesarPosicion,
      (err) => {
        console.warn('[Geofencing] Error GPS:', err.message);
        if (err.code === 1) setEstado('sin_permiso');
      },
      {
        enableHighAccuracy: true,
        timeout:            15_000,
        maximumAge:         30_000,
      }
    );

    setEstado('rastreando');
    console.log('[Geofencing] Rastreo GPS iniciado ✅');
  }, [inicializarPush, procesarPosicion]);

  // ── Detener rastreo ───────────────────────────────────────────────────────
  const detenerRastreo = useCallback(() => {
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    procesandoRef.current.clear();
    setEstado('idle');
    setDentroDeRango([]);
  }, []);

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (restaurantes.length === 0) return;
    iniciarRastreo();
    return () => detenerRastreo();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restaurantes.length]);

  return { estado, dentroDeRango, iniciarRastreo, detenerRastreo };
}