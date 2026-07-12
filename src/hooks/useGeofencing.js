/**
 * useGeofencing.js — Bistro Connect
 *
 * Hook de React que:
 *  1. Solicita permisos de notificaciones + GPS
 *  2. Registra la suscripción WebPush en Supabase (tabla push_subscriptions)
 *  3. Rastrea posición con watchPosition (actualización continua en segundo plano)
 *  4. Calcula distancia Haversine a cada restaurante del array
 *  5. Si el usuario entra al rango → llama a la Edge Function via supabase.functions.invoke
 *  6. Cooldown por localStorage: no repite notif del mismo restaurante antes de 2 horas
 *
 * USO:
 *   const { estado, dentroDeRango } = useGeofencing(restaurantes);
 *
 * FORMA ESPERADA DE restaurantes[]:
 *   { restaurante_id, nombre, latitud, longitud, radio_aviso, puntos_llegada }
 *
 * COMPATIBILIDAD CON sw.js:
 *   La Edge Function envía exactamente: titulo, cuerpo, icono, urlMenu,
 *   restauranteId, puntosLlegada — que son los campos que lee sw.js.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { supabase } from '../services/supabaseClient';

// ── Constantes ────────────────────────────────────────────────────────────────
const COOLDOWN_MS         = 2 * 60 * 60 * 1000; // 2 horas entre notifs del mismo restaurante
const LS_COOLDOWN_PREFIX  = 'bistro_geo_cd_';
const VAPID_PUBLIC_KEY    = import.meta.env.VITE_VAPID_PUBLIC_KEY;

// ── Utilidades ────────────────────────────────────────────────────────────────

/** Fórmula Haversine → distancia en metros */
function haversineM(lat1, lon1, lat2, lon2) {
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

/** Convierte VAPID public key (base64url) → Uint8Array para PushManager.subscribe */
function urlBase64ToUint8Array(b64) {
  const pad  = '='.repeat((4 - (b64.length % 4)) % 4);
  const base = (b64 + pad).replace(/-/g, '+').replace(/_/g, '/');
  return new Uint8Array([...atob(base)].map(c => c.charCodeAt(0)));
}

/** Gestión del cooldown en localStorage */
const cooldown = {
  get:  (id) => parseInt(localStorage.getItem(`${LS_COOLDOWN_PREFIX}${id}`) || '0', 10),
  set:  (id) => localStorage.setItem(`${LS_COOLDOWN_PREFIX}${id}`, Date.now().toString()),
  clear:(id) => localStorage.removeItem(`${LS_COOLDOWN_PREFIX}${id}`),
  ok:   (id) => Date.now() - cooldown.get(id) > COOLDOWN_MS,
};

// ── Hook principal ────────────────────────────────────────────────────────────
export function useGeofencing(restaurantes = []) {
  /**
   * estados:
   *  'idle'                → sin iniciar
   *  'solicitando_permiso' → esperando respuesta del usuario
   *  'rastreando'          → watchPosition activo
   *  'sin_permiso'         → usuario denegó GPS o notificaciones
   *  'no_soportado'        → navegador sin geolocation/SW/Push
   *  'error'               → error inesperado
   */
  const [estado,        setEstado]        = useState('idle');
  const [dentroDeRango, setDentroDeRango] = useState([]); // IDs de restaurantes en rango ahora

  const watchIdRef      = useRef(null);
  const suscripcionRef  = useRef(null);  // PushSubscription activa
  const restaurantesRef = useRef([]);    // ref para evitar recrear el watcher al cambiar props
  const procesandoRef   = useRef(new Set()); // IDs en proceso de notificación (evita race conditions)

  useEffect(() => { restaurantesRef.current = restaurantes; }, [restaurantes]);

  // ── Registrar suscripción WebPush en Supabase ──────────────────────────────
  const guardarSuscripcion = useCallback(async (sub) => {
    try {
      // Usar supabase.functions.invoke en lugar de fetch directo
      // → maneja automáticamente la URL base correcta en producción (Cloudflare Pages)
      const { error } = await supabase.functions.invoke('save-push-subscription', {
        body: { subscription: sub.toJSON() },
      });
      if (error) console.warn('[Geofencing] No se guardó la suscripción:', error.message);
      else       console.log('[Geofencing] Suscripción guardada en Supabase ✅');
    } catch (err) {
      // No crítico: el push puede funcionar con suscripción inline aunque no esté guardada
      console.warn('[Geofencing] Error guardando suscripción:', err.message);
    }
  }, []);

  // ── Inicializar Service Worker y obtener PushSubscription ─────────────────
  const inicializarPush = useCallback(async () => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      console.warn('[Geofencing] Push no soportado en este navegador');
      return null;
    }

    if (!VAPID_PUBLIC_KEY) {
      console.error('[Geofencing] Falta VITE_VAPID_PUBLIC_KEY en .env');
      return null;
    }

    try {
      const registration = await navigator.serviceWorker.ready;

      // Reutilizar suscripción existente para no generar nuevas innecesariamente
      let sub = await registration.pushManager.getSubscription();

      if (!sub) {
        sub = await registration.pushManager.subscribe({
          userVisibleOnly:      true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
        });
        // Solo guardar cuando es nueva (evita escrituras repetidas)
        await guardarSuscripcion(sub);
      }

      return sub;
    } catch (err) {
      console.error('[Geofencing] Error al suscribirse a push:', err.message);
      return null;
    }
  }, [guardarSuscripcion]);

  // ── Procesar posición GPS ─────────────────────────────────────────────────
  const procesarPosicion = useCallback(async (pos) => {
    const { latitude: uLat, longitude: uLon } = pos.coords;
    const restos = restaurantesRef.current;
    const sub    = suscripcionRef.current;

    const enRangoAhora = [];

    for (const resto of restos) {
      const rId   = resto.restaurante_id || resto.id;
      const rLat  = parseFloat(resto.latitud);
      const rLon  = parseFloat(resto.longitud);
      const radio = parseInt(resto.radio_aviso) || 200;

      if (isNaN(rLat) || isNaN(rLon)) continue;

      const distM      = haversineM(uLat, uLon, rLat, rLon);
      const dentroAhora = distM <= radio;

      if (dentroAhora) enRangoAhora.push(rId);

      // Disparar notificación solo si: está en rango + cooldown expirado + no hay otro en proceso
      if (dentroAhora && cooldown.ok(rId) && !procesandoRef.current.has(rId)) {
        procesandoRef.current.add(rId);
        cooldown.set(rId); // marcar ANTES del fetch para evitar doble disparo

        try {
          /**
           * supabase.functions.invoke() en producción (Cloudflare Pages):
           *  - Usa automáticamente VITE_SUPABASE_URL del .env
           *  - Agrega el header Authorization con el anon key
           *  - No necesita URL absoluta → funciona igual en local y producción
           */
          const { data, error } = await supabase.functions.invoke('send-proximity-notification', {
            body: {
              restauranteId:   rId,
              latitudUsuario:  uLat,
              longitudUsuario: uLon,
              // Enviar la suscripción inline como fallback si la tabla push_subscriptions
              // no tiene la del dispositivo actual (ej: primer uso)
              subscription: sub ? sub.toJSON() : null,
            },
          });

          if (error) {
            console.error(`[Geofencing] Error en send-proximity-notification (${rId}):`, error.message);
            // Revertir cooldown para reintentar en el próximo ciclo GPS
            cooldown.clear(rId);
          } else {
            console.log(`[Geofencing] Push enviado a ${resto.nombre}:`, data);
          }
        } catch (err) {
          console.error('[Geofencing] Error de red:', err.message);
          cooldown.clear(rId); // revertir para reintentar
        } finally {
          procesandoRef.current.delete(rId);
        }
      }
    }

    setDentroDeRango(enRangoAhora);
  }, []);

  // ── Solicitar permisos e iniciar watchPosition ────────────────────────────
  const iniciarRastreo = useCallback(async () => {
    if (!('geolocation' in navigator)) {
      setEstado('no_soportado');
      return;
    }

    setEstado('solicitando_permiso');

    // Solicitar permiso de notificaciones primero (no bloquea el GPS si se rechaza)
    if (Notification.permission === 'default') {
      const permiso = await Notification.requestPermission();
      if (permiso === 'granted') {
        const sub = await inicializarPush();
        suscripcionRef.current = sub;
      } else {
        console.warn('[Geofencing] Notificaciones denegadas — el rastreo GPS continúa');
      }
    } else if (Notification.permission === 'granted') {
      if (!suscripcionRef.current) {
        const sub = await inicializarPush();
        suscripcionRef.current = sub;
      }
    }

    // Iniciar watchPosition
    watchIdRef.current = navigator.geolocation.watchPosition(
      procesarPosicion,
      (err) => {
        console.warn('[Geofencing] Error GPS:', err.message);
        if (err.code === 1) setEstado('sin_permiso'); // PERMISSION_DENIED
        // Otros errores (POSITION_UNAVAILABLE, TIMEOUT) son transitorios → no cambiar estado
      },
      {
        enableHighAccuracy: true,
        timeout:            15_000,
        maximumAge:         30_000, // 30s de caché GPS: balance batería/precisión
      }
    );

    setEstado('rastreando');
    console.log('[Geofencing] Rastreo iniciado ✅');
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
    console.log('[Geofencing] Rastreo detenido');
  }, []);

  // ── Ciclo de vida: iniciar cuando llegan restaurantes, limpiar al desmontar
  useEffect(() => {
    if (restaurantes.length === 0) return;
    iniciarRastreo();
    return () => detenerRastreo();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restaurantes.length]); // solo re-iniciar si cambia el número (no en cada render)

  return {
    estado,            // string — estado actual del rastreo
    dentroDeRango,     // string[] — IDs de restaurantes donde el usuario está ahora
    iniciarRastreo,    // fn — llamar manualmente si necesitas reiniciar
    detenerRastreo,    // fn — llamar para pausar (ej: cuando el usuario se va de la app)
  };
}
