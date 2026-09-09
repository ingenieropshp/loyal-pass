/**
 * GeofencingProvider.jsx — LoyalPass
 *
 * Carga los restaurantes activos de Supabase (tablas `conexion` + `configuracion`)
 * con dos queries simples (sin join) para máxima compatibilidad con RLS.
 * Si falla, lo registra en consola pero NO rompe el resto de la app.
 */

import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { supabase }                    from '../services/supabaseClient';
import { useGeofencing }               from '../hooks/useGeofencing';
import { getDeviceId }                 from '../utils/deviceId';
import { getNotifPrefs }               from './SelectorNotificaciones';

const GeofencingContext = createContext({
  estado:          'idle',
  dentroDeRango:   [],
  proximos:        [],
  notifInApp:      [],
  limpiarNotifInApp: () => {},
  restaurantes:    [],
  suscripcion:     null,
  deviceId:        null,
});

export const useGeofencingContext = () => useContext(GeofencingContext);

export function GeofencingProvider({ children }) {
  const [restaurantes,   setRestaurantes]   = useState([]);
  const [prefsClave,     setPrefsClave]     = useState(0); // fuerza re-render al cambiar prefs
  const [deviceId,       setDeviceId]       = useState(null);

  // Priming: resuelve el deviceId en PARALELO con la carga de restaurantes,
  // no en secuencia — así, para cuando useGeofencing lo necesite, ya está
  // cacheado (getDeviceId() internamente cachea el resultado, ver deviceId.js)
  // y no hay que esperar de nuevo a Device.getId() en nativo.
  useEffect(() => {
    let cancelado = false;
    getDeviceId().then((id) => {
      if (!cancelado) setDeviceId(id);
    });
    return () => { cancelado = true; };
  }, []);

  // Escuchar cambios en las preferencias (cuando el usuario activa/desactiva desde SelectorNotificaciones)
  useEffect(() => {
    const onStorage = (e) => {
      if (e.key === 'loyalpass_notif_prefs') setPrefsClave(k => k + 1);
    };
    window.addEventListener('storage', onStorage);
    // También escuchar cambios en la misma pestaña con un evento custom
    window.addEventListener('loyalpass_notif_changed', () => setPrefsClave(k => k + 1));
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('loyalpass_notif_changed', () => {});
    };
  }, []);

  useEffect(() => {
    const cargar = async () => {
      try {
        // Query 0 (FIX): restaurantes donde el cliente autenticado está
        // REALMENTE registrado y activo. Antes este provider cargaba TODOS
        // los restaurantes activos de la plataforma (query 1 de abajo, sin
        // ningún filtro por cliente) y les registraba geocerca nativa a
        // todos — por eso llegaban notificaciones de sedes donde el usuario
        // nunca se había registrado (ej. "La estación de la pizza" con el
        // dispositivo vinculado solo a "101 Bistro").
        //
        // OJO: no basta con confiar en RLS acá. La tabla `clientes` tiene
        // una policy de SELECT ("Clientes ven su propio perfil") con la
        // condición `auth_user_id = auth.uid() OR cedula IS NOT NULL` —
        // ese "OR cedula IS NOT NULL" existe para que manejarRegistro.jsx
        // pueda resolver el cliente_id de un referidor por nombre, pero
        // como policy de SELECT sin filtro adicional deja leer CUALQUIER
        // fila de `clientes` que tenga cédula (prácticamente todas), sin
        // importar de quién sea. Si este query dependiera solo de RLS,
        // devolvería otra vez los restaurantes de OTROS clientes. Por eso
        // se filtra explícitamente por `auth_user_id` acá también.
        const { data: userData } = await supabase.auth.getUser();
        const authUserId = userData?.user?.id;
        if (!authUserId) { setRestaurantes([]); return; }

        const { data: misRegistros, error: err0 } = await supabase
          .from('clientes')
          .select('restaurante_id')
          .eq('auth_user_id', authUserId)
          .eq('activo', true);

        if (err0) {
          console.error('[GeofencingProvider] Error cargando registros del cliente:', err0.message);
          return;
        }

        const idsRegistrados = new Set((misRegistros || []).map(r => r.restaurante_id).filter(Boolean));
        if (idsRegistrados.size === 0) {
          // El cliente no está registrado (o no tiene ningún registro activo)
          // en ningún restaurante todavía — no hay nada que geocercar.
          setRestaurantes([]);
          return;
        }

        // Query 1: coordenadas de geolocalización (tabla conexion — sin cambios,
        // esto sigue siendo geo, no algoritmo de fidelización)
        const { data: conexionesTodas, error: err1 } = await supabase
          .from('conexion')
          .select('restaurante_id, latitud, longitud, radio_aviso, mensaje_promo')
          .not('latitud', 'is', null)
          .not('longitud', 'is', null);

        if (err1) {
          console.error('[GeofencingProvider] Error en tabla conexion:', err1.message);
          return;
        }

        if (!conexionesTodas || conexionesTodas.length === 0) return;

        // FIX: solo los restaurantes donde el cliente está registrado y activo.
        const conexiones = conexionesTodas.filter(c => idsRegistrados.has(c.restaurante_id));
        if (conexiones.length === 0) { setRestaurantes([]); return; }

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

        // Query 3: algoritmo de fidelización (tabla configuracion_restaurantes)
        const { data: fidelizacion, error: err3 } = await supabase
          .from('configuracion_restaurantes')
          .select('restaurante_id, puntos_geocerca_proximidad, puntos_pago_caja, monto_minimo_redencion, mensaje_incentivo_consumo, mensaje_push_geocerca')
          .in('restaurante_id', ids);

        if (err3) {
          console.warn('[GeofencingProvider] No se pudo cargar configuracion_restaurantes:', err3.message);
        }

        // Combinar los tres resultados manualmente
        const configMap = {};
        (configs || []).forEach(c => { configMap[c.id] = c; });

        const fidelizacionMap = {};
        (fidelizacion || []).forEach(f => { fidelizacionMap[f.restaurante_id] = f; });

        const activos = conexiones
          .filter(r => {
            const cfg = configMap[r.restaurante_id];
            // Si no tenemos config, incluimos el restaurante por defecto
            return !cfg || cfg.activo !== false;
          })
          .map(r => {
            const fid = fidelizacionMap[r.restaurante_id];
            return {
              restaurante_id: r.restaurante_id,
              nombre:         configMap[r.restaurante_id]?.nombre ?? 'Restaurante',
              latitud:        parseFloat(r.latitud),
              longitud:       parseFloat(r.longitud),
              radio_aviso:    r.radio_aviso    ?? 200,
              puntos_llegada: fid?.puntos_pago_caja           ?? 300,
              puntos_geocerca: fid?.puntos_geocerca_proximidad ?? 200,
              meta_puntos:    fid?.monto_minimo_redencion     ?? 15000,
              mensaje_promo:  fid?.mensaje_push_geocerca || r.mensaje_promo || '',
              mensaje_incentivo_consumo: fid?.mensaje_incentivo_consumo ?? '',
            };
          });


        setRestaurantes(activos);
      } catch (err) {
        // Error inesperado: loguear pero NO romper la app
        console.error('[GeofencingProvider] Error inesperado:', err.message);
      }
    };

    cargar();

    // Realtime: actualizar si el admin cambia coordenadas, o (FIX) si el
    // propio cliente se registra/desvincula de un restaurante — antes solo
    // escuchaba `conexion`, así que si el usuario se registraba en una sede
    // nueva sin cerrar y reabrir la app, esa sede no se geocercaba hasta el
    // siguiente arranque. Ahora también reacciona a cambios en `clientes`
    // (la fuente del filtro de la query 0 de arriba).
    const channel = supabase
      .channel('geofencing-conexion')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'conexion' }, cargar)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'clientes' }, cargar)
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, []);

  // Filtrar según preferencias del usuario (solo restaurantes con notifs activas).
  // useMemo es CLAVE acá: sin esto, este array se recrea (con una referencia
  // nueva) en CADA render del provider, sin importar el motivo del render.
  // Como useGeofencing depende de esta referencia para decidir cuándo
  // re-registrar las geocercas, un array "nuevo" de más dispara todo el
  // flujo de nuevo: vuelve a pedir permisos, muestra el diálogo de nuevo,
  // re-registra geocercas, etc. Solo debe recalcularse cuando cambian de
  // verdad los datos (restaurantes) o las preferencias (prefsClave).
  const restaurantesFiltrados = useMemo(() => {
    const prefs = getNotifPrefs();
    return restaurantes.filter(r => prefs[r.restaurante_id] !== false);
  }, [restaurantes, prefsClave]);

  // useGeofencing solo se activa con los restaurantes que el usuario eligió.
  // Se le pasa el deviceId ya "primeado" arriba — si todavía no resolvió
  // (null), el hook lo resuelve por su cuenta internamente, así que no hay
  // riesgo de carrera entre este efecto y el de arriba.
  const { estado, dentroDeRango, proximos, notifInApp, limpiarNotifInApp } =
    useGeofencing(restaurantesFiltrados, deviceId);

  return (
    <GeofencingContext.Provider
      value={{
        estado,
        dentroDeRango,
        proximos,
        notifInApp,
        limpiarNotifInApp,
        restaurantes: restaurantesFiltrados,
        deviceId,
      }}
    >
      {children}
    </GeofencingContext.Provider>
  );
}
