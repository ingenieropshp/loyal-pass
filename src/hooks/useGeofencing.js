/**
 * useGeofencing.js — Bistro Connect
 *
 * Hook que:
 *  1. Solicita permiso de notificaciones y suscripción WebPush
 *  2. Inicia watchPosition para rastrear al usuario en tiempo real
 *  3. Calcula distancia Haversine a cada restaurante del array
 *  4. Si el usuario entra al rango, llama a la Edge Function para disparar el push
 *  5. Cooldown por localStorage: no repite notif del mismo restaurante antes de N ms
 *
 * Uso:
 *   const { estado, dentroDeRango } = useGeofencing(restaurantes);
 *
 *   `restaurantes` es el array de la tabla `conexion` de Supabase:
 *   [{ restaurante_id, nombre, latitud, longitud, radio_aviso, puntos_llegada, meta_puntos }]
 */

import { useState, useEffect, useRef, useCallback } from 'react';

// ── Constantes ────────────────────────────────────────────────────────────────
const COOLDOWN_MS        = 2 * 60 * 60 * 1000; // 2 horas entre notifs del mismo restaurante
const COOLDOWN_KEY_PREFIX = 'bistro_geo_cd_';   // localStorage key prefix
const VAPID_PUBLIC_KEY    = import.meta.env.VITE_VAPID_PUBLIC_KEY; // ← añadir al .env
const EDGE_FN_URL         = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;

// ── Utilidades ────────────────────────────────────────────────────────────────

/**
 * Fórmula de Haversine
 * @returns distancia en metros entre dos puntos geográficos
 */
function haversineMetros(lat1, lon1, lat2, lon2) {
  const R    = 6_371_000; // Radio de la Tierra en metros
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
    Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Convierte la VAPID public key (base64url) a Uint8Array para la suscripción */
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw     = atob(base64);
  return new Uint8Array([...raw].map(c => c.charCodeAt(0)));
}

/** Lee la marca de tiempo del último push para un restaurante */
function getCooldownTs(restauranteId) {
  const ts = localStorage.getItem(`${COOLDOWN_KEY_PREFIX}${restauranteId}`);
  return ts ? parseInt(ts, 10) : 0;
}

/** Guarda la marca de tiempo del push actual para el cooldown */
function setCooldownTs(restauranteId) {
  localStorage.setItem(`${COOLDOWN_KEY_PREFIX}${restauranteId}`, Date.now().toString());
}

/** Verifica si el cooldown ya expiró */
function cooldownExpirado(restauranteId) {
  return Date.now() - getCooldownTs(restauranteId) > COOLDOWN_MS;
}

// ── Hook principal ────────────────────────────────────────────────────────────
export function useGeofencing(restaurantes = []) {
  const [estado,        setEstado]        = useState('idle');
  // 'idle' | 'solicitando_permiso' | 'rastreando' | 'sin_permiso' | 'error'
  const [dentroDeRango, setDentroDeRango] = useState([]); // IDs de restaurantes en rango
  const [suscripcion,   setSuscripcion]   = useState(null);

  const watchIdRef      = useRef(null);
  const suscripcionRef  = useRef(null); // para acceder en el callback de watchPosition
  const restaurantesRef = useRef([]);   // ref para no re-crear el watcher al cambiar el array

  // Mantener refs sincronizados
  useEffect(() => { restaurantesRef.current = restaurantes; }, [restaurantes]);
  useEffect(() => { suscripcionRef.current  = suscripcion;  }, [suscripcion]);

  // ── 1. Registrar Service Worker y obtener suscripción push ──────────────────
  const inicializarSW = useCallback(async () => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      console.warn('[Geofencing] Push no soportado en este navegador.');
      return null;
    }

    const registration = await navigator.serviceWorker.ready;

    // Reutilizar suscripción existente si ya hay una
    let sub = await registration.pushManager.getSubscription();
    if (!sub) {
      if (!VAPID_PUBLIC_KEY) {
        console.error('[Geofencing] Falta VITE_VAPID_PUBLIC_KEY en .env');
        return null;
      }
      sub = await registration.pushManager.subscribe({
        userVisibleOnly:      true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
    }

    // Persistir la suscripción en Supabase (tabla push_subscriptions)
    // para que el backend pueda enviarle pushes más tarde
    try {
      await fetch(`${EDGE_FN_URL}/save-push-subscription`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ subscription: sub.toJSON() }),
      });
    } catch (err) {
      // No es crítico — el push aún puede funcionar si la sub ya estaba guardada
      console.warn('[Geofencing] No se pudo persistir la suscripción:', err.message);
    }

    return sub;
  }, []);

  // ── 2. Procesar posición GPS: calcular distancias y disparar push ────────────
  const procesarPosicion = useCallback(async (pos) => {
    const { latitude: uLat, longitude: uLon } = pos.coords;
    const restos = restaurantesRef.current;
    const sub    = suscripcionRef.current;

    const enRango = [];

    for (const resto of restos) {
      const rLat   = parseFloat(resto.latitud);
      const rLon   = parseFloat(resto.longitud);
      const radio  = parseInt(resto.radio_aviso) || 200;

      if (isNaN(rLat) || isNaN(rLon)) continue; // restaurante sin coordenadas

      const distM = haversineMetros(uLat, uLon, rLat, rLon);
      const dentroAhora = distM <= radio;

      if (dentroAhora) enRango.push(resto.restaurante_id || resto.id);

      if (dentroAhora && cooldownExpirado(resto.restaurante_id || resto.id)) {
        // Marcar cooldown ANTES del fetch para evitar doble disparo en caso de
        // respuesta lenta + nueva posición GPS casi simultánea
        setCooldownTs(resto.restaurante_id || resto.id);

        // Llamar a la Edge Function para validar server-side y enviar el push
        try {
          await fetch(`${EDGE_FN_URL}/check-geofence`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              restauranteId: resto.restaurante_id || resto.id,
              latitudUsuario:  uLat,
              longitudUsuario: uLon,
              subscription:    sub?.toJSON() ?? null,
            }),
          });
        } catch (err) {
          // Revertir cooldown si el fetch falla para que reintente en el próximo ciclo
          localStorage.removeItem(`${COOLDOWN_KEY_PREFIX}${resto.restaurante_id || resto.id}`);
          console.error('[Geofencing] Error al llamar check-geofence:', err.message);
        }
      }
    }

    setDentroDeRango(enRango);
  }, []);

  // ── 3. Iniciar rastreo ───────────────────────────────────────────────────────
  const iniciarRastreo = useCallback(async () => {
    if (!('geolocation' in navigator)) {
      setEstado('error');
      return;
    }

    setEstado('solicitando_permiso');

    // Solicitar permiso de notificaciones
    let notifPermiso = Notification.permission;
    if (notifPermiso === 'default') {
      notifPermiso = await Notification.requestPermission();
    }

    if (notifPermiso === 'granted') {
      const sub = await inicializarSW();
      setSuscripcion(sub);
    }
    // Si el usuario rechaza las notificaciones, el rastreo GPS igual funciona
    // (solo fallará el push remoto, pero puede mostrar un banner local)

    watchIdRef.current = navigator.geolocation.watchPosition(
      procesarPosicion,
      (err) => {
        console.warn('[Geofencing] Error GPS:', err.message);
        if (err.code === 1) setEstado('sin_permiso'); // permiso denegado
      },
      {
        enableHighAccuracy: true,
        timeout:            15_000,
        maximumAge:         30_000, // 30s de caché GPS: balance batería/precisión
      }
    );

    setEstado('rastreando');
  }, [inicializarSW, procesarPosicion]);

  // ── 4. Detener rastreo ───────────────────────────────────────────────────────
  const detenerRastreo = useCallback(() => {
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    setEstado('idle');
    setDentroDeRango([]);
  }, []);

  // ── Lifecycle: iniciar cuando hay restaurantes, limpiar al desmontar ─────────
  useEffect(() => {
    if (restaurantes.length === 0) return;
    iniciarRastreo();
    return () => detenerRastreo();
  }, [restaurantes.length]); // solo re-iniciar si cambia el número de restaurantes

  return {
    estado,           // 'idle' | 'solicitando_permiso' | 'rastreando' | 'sin_permiso' | 'error'
    dentroDeRango,    // string[] de restaurante IDs actualmente en rango
    suscripcion,      // PushSubscription | null
    iniciarRastreo,
    detenerRastreo,
  };
}
