/**
 * GeofencingProvider.jsx — Bistro Connect
 *
 * Carga los restaurantes activos de Supabase (tablas `conexion` + `configuracion`)
 * con dos queries simples (sin join) para máxima compatibilidad con RLS.
 * Si falla, lo registra en consola pero NO rompe el resto de la app.
 */

import { createContext, useContext, useEffect, useState } from 'react';
import { supabase }                    from '../services/supabaseClient';
import { useGeofencing }               from '../hooks/useGeofencing';
import { getNotifPrefs }               from './SelectorNotificaciones';

const GeofencingContext = createContext({
  estado:        'idle',
  dentroDeRango: [],
  restaurantes:  [],
  suscripcion:   null,
});

export const useGeofencingContext = () => useContext(GeofencingContext);

export function GeofencingProvider({ children }) {
  const [restaurantes,   setRestaurantes]   = useState([]);
  const [prefsClave,     setPrefsClave]     = useState(0); // fuerza re-render al cambiar prefs

  // Escuchar cambios en las preferencias (cuando el usuario activa/desactiva desde SelectorNotificaciones)
  useEffect(() => {
    const onStorage = (e) => {
      if (e.key === 'bistro_notif_prefs') setPrefsClave(k => k + 1);
    };
    window.addEventListener('storage', onStorage);
    // También escuchar cambios en la misma pestaña con un evento custom
    window.addEventListener('bistro_notif_changed', () => setPrefsClave(k => k + 1));
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('bistro_notif_changed', () => {});
    };
  }, []);

  useEffect(() => {
    const cargar = async () => {
      try {
        // Query 1: coordenadas y config de puntos (tabla conexion)
        const { data: conexiones, error: err1 } = await supabase
          .from('conexion')
          .select('restaurante_id, latitud, longitud, radio_aviso, puntos_llegada, meta_puntos, mensaje_promo')
          .not('latitud', 'is', null)
          .not('longitud', 'is', null);

        if (err1) {
          console.error('[GeofencingProvider] Error en tabla conexion:', err1.message);
          return;
        }

        if (!conexiones || conexiones.length === 0) return;

        // Query 2: nombres y estado activo (tabla configuracion)
        const ids = conexiones.map(c => c.restaurante_id).filter(Boolean);
        const { data: configs, error: err2 } = await supabase
          .from('configuracion')
          .select('id, nombre, activo')
          .in('id', ids);

        if (err2) {
          console.warn('[GeofencingProvider] No se pudo cargar configuracion:', err2.message);
          // Continuar sin filtrar por activo si falla esta query
        }

        // Combinar los dos resultados manualmente
        const configMap = {};
        (configs || []).forEach(c => { configMap[c.id] = c; });

        const activos = conexiones
          .filter(r => {
            const cfg = configMap[r.restaurante_id];
            // Si no tenemos config, incluimos el restaurante por defecto
            return !cfg || cfg.activo !== false;
          })
          .map(r => ({
            restaurante_id: r.restaurante_id,
            nombre:         configMap[r.restaurante_id]?.nombre ?? 'Restaurante',
            latitud:        parseFloat(r.latitud),
            longitud:       parseFloat(r.longitud),
            radio_aviso:    r.radio_aviso    ?? 200,
            puntos_llegada: r.puntos_llegada ?? 2,
            meta_puntos:    r.meta_puntos    ?? 20,
            mensaje_promo:  r.mensaje_promo  ?? '',
          }));

        setRestaurantes(activos);
      } catch (err) {
        // Error inesperado: loguear pero NO romper la app
        console.error('[GeofencingProvider] Error inesperado:', err.message);
      }
    };

    cargar();

    // Realtime: actualizar si el admin cambia coordenadas
    const channel = supabase
      .channel('geofencing-conexion')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'conexion' }, cargar)
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, []);

  // Filtrar según preferencias del usuario (solo restaurantes con notifs activas)
  const prefs = getNotifPrefs();
  const restaurantesFiltrados = restaurantes.filter(r =>
    prefs[r.restaurante_id] !== false  // activo por defecto si no hay preferencia
  );

  // useGeofencing solo se activa con los restaurantes que el usuario eligió
  const { estado, dentroDeRango } = useGeofencing(restaurantesFiltrados);

  return (
    <GeofencingContext.Provider value={{ estado, dentroDeRango, restaurantes: restaurantesFiltrados }}>
      {children}
    </GeofencingContext.Provider>
  );
}
