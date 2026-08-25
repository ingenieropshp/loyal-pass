import { useState, useEffect, useCallback, useRef } from 'react';
import { BackgroundGeolocation } from '@capgo/background-geolocation';
import { LocalNotifications } from '@capacitor/local-notifications';

const CHANNEL_ID = 'geofence-alerts';

export function useGeofencing(restaurantes = [], usuarioId = null) {
  const [dentroDeRango, setDentroDeRango] = useState(false);
  const [estado, setEstado] = useState('cargando'); // 'cargando' | 'activo' | 'sin_permiso' | 'error'
  const [proximos, setProximos] = useState([]);
  const [notifInApp, setNotifInApp] = useState(null);

  const watcherIdRef = useRef(null);
  const transitionListenerRef = useRef(null);

  // 1. Crear el canal de notificaciones en Android con prioridad máxima
  const crearCanalNotificaciones = async () => {
    try {
      await LocalNotifications.createChannel({
        id: CHANNEL_ID,
        name: 'Alertas de Restaurantes',
        description: 'Notificaciones cuando estás cerca de un restaurante asociado',
        importance: 5, // Prioridad máxima (Banner/Sonido en Android)
        visibility: 1,
        sound: 'default',
        vibration: true,
      });
    } catch (err) {
      console.error('Error al crear canal de notificaciones:', err);
    }
  };

  // 2. Disparar notificación local
  const enviarNotificacion = async (restaurante) => {
    const titulo = '¡Estás cerca!';
    const mensaje = `Llegaste a ${restaurante.nombre || 'un restaurante asociado'}. ¡Abre la app para sumar puntos!`;

    // Notificación en pantalla si la app está abierta
    setNotifInApp({
      id: restaurante.id,
      nombre: restaurante.nombre,
      mensaje,
    });

    // Notificación nativa (funciona en segundo plano)
    try {
      await LocalNotifications.schedule({
        notifications: [
          {
            title: titulo,
            body: mensaje,
            id: typeof restaurante.id === 'number' ? restaurante.id : Math.floor(Math.random() * 100000),
            channelId: CHANNEL_ID,
            schedule: { at: new Date(Date.now() + 100) },
            extra: { restauranteId: restaurante.id },
          },
        ],
      });
    } catch (err) {
      console.error('Error al enviar notificación local:', err);
    }
  };

  const limpiarNotifInApp = () => setNotifInApp(null);

  // 3. Inicializar Geofencing y Bajo Consumo con Capgo
  useEffect(() => {
    let montado = true;

    const inicializarGeofencing = async () => {
      if (!usuarioId || !restaurantes || restaurantes.length === 0) {
        if (montado) setEstado('activo');
        return;
      }

      try {
        await crearCanalNotificaciones();

        // Solicitar permisos de localización al usuario
        const permisoNotif = await LocalNotifications.requestPermissions();
        if (permisoNotif.display !== 'granted') {
          console.warn('Permisos de notificación no concedidos');
        }

        // Formatear la lista de restaurantes al estándar que requiere @capgo/background-geolocation
        const geofences = restaurantes.map((r) => ({
          id: String(r.id),
          latitude: Number(r.latitud || r.latitude),
          longitude: Number(r.longitud || r.longitude),
          radius: Number(r.radio_metros || r.radius || 100),
          notifyOnEntry: true,
          notifyOnExit: true,
        }));

        // Añadir las geocercas a Capgo
        await BackgroundGeolocation.addGeofences({ geofences });

        // Escuchar eventos de entrada/salida de la geocerca
        transitionListenerRef.current = await BackgroundGeolocation.addListener(
          'geofenceTransition',
          (event) => {
            const restEncontrado = restaurantes.find(
              (r) => String(r.id) === String(event.id)
            );

            if (event.transitionType === 'ENTER') {
              setDentroDeRango(true);
              if (restEncontrado) {
                enviarNotificacion(restEncontrado);
              }
            } else if (event.transitionType === 'EXIT') {
              setDentroDeRango(false);
            }
          }
        );

        // Listener de posición de bajo consumo en segundo plano
        watcherIdRef.current = await BackgroundGeolocation.addWatcher(
          {
            backgroundMessage: 'Monitoreando restaurantes cercanos en segundo plano',
            backgroundTitle: 'Pisingo Geofencing',
            requestPermissions: true,
            stale: false,
            distanceFilter: 50, // Notificar cambios cada 50 metros para bajo consumo
          },
          (location, error) => {
            if (error) {
              console.error('Error en watcher de localización Capgo:', error);
              return;
            }
            if (location && montado) {
              // Actualizar lista de restaurantes próximos para la UI
              const cerca = restaurantes.filter((r) => {
                const lat = Number(r.latitud || r.latitude);
                const lng = Number(r.longitud || r.longitude);
                const radio = Number(r.radio_metros || r.radius || 100);
                const d = calcularDistanciaHaversine(
                  location.latitude,
                  location.longitude,
                  lat,
                  lng
                );
                return d <= radio * 3; // Mostrar como 'próximos' los que están a 3x del radio
              });
              setProximos(cerca);
            }
          }
        );

        if (montado) setEstado('activo');
      } catch (error) {
        console.error('Error inicializando Capgo Geofencing:', error);
        if (montado) setEstado('error');
      }
    };

    inicializarGeofencing();

    // Limpieza de listeners y watchers al desmontar el componente
    return () => {
      montado = false;
      if (watcherIdRef.current) {
        BackgroundGeolocation.removeWatcher({ id: watcherIdRef.current });
      }
      if (transitionListenerRef.current) {
        transitionListenerRef.current.remove();
      }
    };
  }, [restaurantes, usuarioId]);

  return {
    dentroDeRango,
    estado,
    proximos,
    notifInApp,
    limpiarNotifInApp,
  };
}

// Función auxiliar para calcular distancias en metros (Haversine)
function calcularDistanciaHaversine(lat1, lon1, lat2, lon2) {
  const R = 6371000; // Radio de la Tierra en metros
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}