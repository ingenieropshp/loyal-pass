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

  useEffect(() => { restaurantesRef.current = restaurantes; }, [restaurantes]);

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

  // ── Escuchar REQUEST_LOCATION del SW (Periodic Sync despertó la app) ──────
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    const handleSWMessage = (event) => {
      if (event.data?.type === 'REQUEST_LOCATION') {
        // El SW nos pide nuestra posición actual → la obtenemos y se la enviamos
        navigator.geolocation?.getCurrentPosition((pos) => {
          enviarAlSW('LOCATION_UPDATE', {
            lat: pos.coords.latitude,
            lon: pos.coords.longitude,
          });
        }, () => {}, { maximumAge: 60_000 });
      }
    };

    navigator.serviceWorker.addEventListener('message', handleSWMessage);
    return () => navigator.serviceWorker.removeEventListener('message', handleSWMessage);
  }, [enviarAlSW]);

  // ── Procesar posición GPS ─────────────────────────────────────────────────
  const procesarPosicion = useCallback((pos) => {
    const { latitude: uLat, longitude: uLon } = pos.coords;

    // Enviar posición al SW → él hace el chequeo de geofence y muestra la notif
    // Esto funciona incluso con la app en background porque el SW sigue vivo
    enviarAlSW('LOCATION_UPDATE', { lat: uLat, lon: uLon });

    // También actualizar estado de React para el UI (badge "Estás aquí")
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