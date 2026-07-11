/**
 * GeofencingProvider.jsx — Bistro Connect
 *
 * Carga los restaurantes activos de Supabase (tabla `conexion`)
 * y activa el hook useGeofencing. Se monta una sola vez en App.jsx.
 *
 * Expone el contexto GeofencingContext para que cualquier componente
 * hijo pueda saber si el usuario está dentro del rango de algún local.
 *
 * Uso en App.jsx:
 *   <GeofencingProvider>
 *     <App />
 *   </GeofencingProvider>
 *
 * Uso en cualquier componente hijo:
 *   const { dentroDeRango, estado } = useGeofencingContext();
 */

import { createContext, useContext, useEffect, useState } from 'react';
import { supabase }       from '../services/supabaseClient';
import { useGeofencing }  from '../hooks/useGeofencing';

// ── Contexto ──────────────────────────────────────────────────────────────────
const GeofencingContext = createContext({
  estado:        'idle',
  dentroDeRango: [],
  restaurantes:  [],
});

export const useGeofencingContext = () => useContext(GeofencingContext);

// ── Provider ──────────────────────────────────────────────────────────────────
export function GeofencingProvider({ children }) {
  const [restaurantes, setRestaurantes] = useState([]);

  // Cargar restaurantes activos con coordenadas desde Supabase
  useEffect(() => {
    const cargar = async () => {
      const { data, error } = await supabase
        .from('conexion')
        .select(`
          restaurante_id,
          latitud,
          longitud,
          radio_aviso,
          puntos_llegada,
          meta_puntos,
          configuracion (
            id,
            nombre,
            activo,
            mensaje_promo
          )
        `)
        .not('latitud', 'is', null)
        .not('longitud', 'is', null);

      if (error) {
        console.error('[GeofencingProvider] Error cargando restaurantes:', error.message);
        return;
      }

      // Filtrar solo restaurantes activos y mapear a la forma que espera useGeofencing
      const activos = (data || [])
        .filter(r => r.configuracion?.activo !== false)
        .map(r => ({
          restaurante_id:  r.restaurante_id,
          nombre:          r.configuracion?.nombre ?? 'Restaurante',
          latitud:         parseFloat(r.latitud),
          longitud:        parseFloat(r.longitud),
          radio_aviso:     r.radio_aviso ?? 200,
          puntos_llegada:  r.puntos_llegada ?? 2,
          meta_puntos:     r.meta_puntos ?? 20,
          mensaje_promo:   r.configuracion?.mensaje_promo ?? '',
        }));

      setRestaurantes(activos);
    };

    cargar();

    // Suscripción realtime: si el admin cambia coordenadas, actualizamos en vivo
    const channel = supabase
      .channel('geofencing-conexion')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'conexion' }, cargar)
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, []);

  const { estado, dentroDeRango, suscripcion } = useGeofencing(restaurantes);

  return (
    <GeofencingContext.Provider value={{ estado, dentroDeRango, restaurantes, suscripcion }}>
      {children}
    </GeofencingContext.Provider>
  );
}
