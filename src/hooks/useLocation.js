import { useState, useEffect, useRef } from 'react';

/**
 * Hook para calcular la distancia en metros entre el usuario y una sede en tiempo real.
 * @param {number|null} targetLat - Latitud de destino
 * @param {number|null} targetLon - Longitud de destino
 */
export const useLocation = (targetLat, targetLon) => {
  const [distance, setDistance] = useState(null);
  const [error, setError]       = useState(null);
  const watchIdRef = useRef(null);

  useEffect(() => {
    // Limpiar watch anterior antes de arrancar uno nuevo
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }

    const tLat = parseFloat(targetLat);
    const tLon = parseFloat(targetLon);

    // Si los datos aún no llegaron (null / NaN / 0) simplemente esperamos
    if (!targetLat || !targetLon || isNaN(tLat) || isNaN(tLon) || tLat === 0) {
      setDistance(null);
      return;
    }

    if (!navigator.geolocation) {
      setError('Geolocalización no soportada en este navegador');
      return;
    }

    const options = {
      enableHighAccuracy: true,
      timeout: 15000,
      maximumAge: 0,
    };

    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;

        // Fórmula de Haversine
        const R    = 6371000;
        const dLat = (tLat - latitude)  * (Math.PI / 180);
        const dLon = (tLon - longitude) * (Math.PI / 180);
        const a =
          Math.sin(dLat / 2) ** 2 +
          Math.cos(latitude * (Math.PI / 180)) *
          Math.cos(tLat    * (Math.PI / 180)) *
          Math.sin(dLon / 2) ** 2;
        const d = Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));

        if (!isNaN(d)) {
          setDistance(d);
          setError(null);
        }
      },
      (err) => {
        setError(err.message);
        console.warn(`Error GPS (${err.code}): ${err.message}`);
      },
      options
    );

    return () => {
      if (watchIdRef.current !== null) {
        navigator.geolocation.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
      }
    };
  }, [targetLat, targetLon]);

  return { distance, error };
};
