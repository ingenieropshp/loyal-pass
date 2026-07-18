import { useState, useEffect, useRef } from 'react';

/**
 * Hook para calcular la distancia en metros entre el usuario y una sede en tiempo real.
 * Estrategia en cascada:
 *   1. Intenta alta precisión (GPS real) con timeout de 8s
 *   2. Si falla o tarda, cae a baja precisión (WiFi/IP) que funciona en PC y móvil
 * @param {number|null} targetLat
 * @param {number|null} targetLon
 */
export const useLocation = (targetLat, targetLon) => {
  const [distance, setDistance] = useState(null);
  const [error,    setError]    = useState(null);
  const watchIdRef    = useRef(null);
  const fallbackTimer = useRef(null);
  const gotPositionRef = useRef(false);

  useEffect(() => {
    // Limpiar estado anterior
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    if (fallbackTimer.current) {
      clearTimeout(fallbackTimer.current);
      fallbackTimer.current = null;
    }
    gotPositionRef.current = false;

    const tLat = parseFloat(targetLat);
    const tLon = parseFloat(targetLon);

    if (!targetLat || !targetLon || isNaN(tLat) || isNaN(tLon) || tLat === 0) {
      setDistance(null);
      return;
    }
    if (!navigator.geolocation) {
      setError('Geolocalización no soportada en este navegador');
      return;
    }

    const calcular = (latitude, longitude) => {
      const R    = 6371000;
      const dLat = (tLat - latitude)  * (Math.PI / 180);
      const dLon = (tLon - longitude) * (Math.PI / 180);
      const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(latitude * (Math.PI / 180)) *
        Math.cos(tLat    * (Math.PI / 180)) *
        Math.sin(dLon / 2) ** 2;
      const d = Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
      if (!isNaN(d)) { setDistance(d); setError(null); }
    };

    const onSuccess = (pos) => {
      gotPositionRef.current = true;
      calcular(pos.coords.latitude, pos.coords.longitude);
    };

    const onError = (err) => {
      console.warn(`GPS watch error (${err.code}): ${err.message}`);
      // No mostrar error al usuario si ya tenemos posición; solo loguear
      if (!gotPositionRef.current) {
        setError(null); // silencioso — el fallback ya habrá activado
      }
    };

    // ── Intento 1: alta precisión (GPS real en móvil) ──────────────────
    watchIdRef.current = navigator.geolocation.watchPosition(
      onSuccess,
      onError,
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 10000 }
    );

    // ── Intento 2 (fallback): si en 6s no hay posición, usar baja precisión ──
    // Baja precisión usa WiFi/red IP → funciona en PC y en móvil sin GPS claro
    fallbackTimer.current = setTimeout(() => {
      if (!gotPositionRef.current) {
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            gotPositionRef.current = true;
            calcular(pos.coords.latitude, pos.coords.longitude);
          },
          () => {}, // silencioso
          { enableHighAccuracy: false, timeout: 10000, maximumAge: 30000 }
        );
      }
    }, 6000);

    return () => {
      if (watchIdRef.current !== null) {
        navigator.geolocation.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
      }
      if (fallbackTimer.current) {
        clearTimeout(fallbackTimer.current);
        fallbackTimer.current = null;
      }
    };
  }, [targetLat, targetLon]);

  return { distance, error };
};
