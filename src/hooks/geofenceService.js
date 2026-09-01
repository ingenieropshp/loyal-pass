// src/services/geofenceService.js
//
// Configura la entrega nativa de transiciones de geocerca hacia la Edge
// Function de Supabase, incluyendo el deviceId en el payload base para que
// el webhook llegue con toda la info que necesita.

import { BackgroundGeolocation } from '@capgo/background-geolocation';
import { getDeviceId } from './deviceRegistration';

const GEOFENCE_WEBHOOK_URL =
  'https://<project-ref>.supabase.co/functions/v1/geofence-webhook';

/**
 * Debe llamarse UNA sola vez al iniciar sesión (o al arrancar la app si el
 * usuario ya está autenticado), y SIEMPRE después de registerDeviceForPush().
 *
 * Punto clave: `payload` en setupGeofencing() es la base que el plugin
 * fusiona automáticamente con el payload de cada geocerca individual y la
 * envía en cada POST nativo al webhook, incluso con el WebView suspendido.
 * Si el deviceId no está aquí, nunca va a llegar a tu Edge Function en las
 * transiciones reales — por eso te funciona en curl (lo mandas a mano) y no
 * en el dispositivo físico.
 */
export async function setupGeofenceWebhook() {
  const deviceId = await getDeviceId();

  await BackgroundGeolocation.setupGeofencing({
    url: GEOFENCE_WEBHOOK_URL,
    notifyOnEntry: true,
    notifyOnExit: true,
    payload: { deviceId }, // <-- se fusiona en CADA transición, sin importar la geocerca
    // Necesario para que la POST nativa se dispare con la app en background/cerrada.
    // Requiere ACCESS_BACKGROUND_LOCATION en el manifest de Android (ver permissions.js).
    backgroundLocation: true,
    requestPermissions: true,
  });

  return deviceId;
}

/**
 * Registra una geocerca. No hace falta volver a pasar deviceId aquí: ya
 * viene del payload base de setupGeofencing(). Si en el futuro quieres
 * distinguir el tipo de zona (ej. "restaurante" vs "zona de entrega"),
 * puedes añadir campos extra por región — se fusionan sobre el payload base.
 */
export async function addRestaurantGeofence({ identifier, latitude, longitude, radius = 150, extra = {} }) {
  await BackgroundGeolocation.addGeofence({
    identifier,
    latitude,
    longitude,
    radius,
    notifyOnEntry: true,
    notifyOnExit: true,
    payload: extra, // se fusiona SOBRE el payload base -> { deviceId, ...extra }
  });
}

export async function addRestaurantGeofences(zones) {
  // zones: [{ identifier, latitude, longitude, radius, extra }, ...]
  for (const zone of zones) {
    await addRestaurantGeofence(zone);
  }
}

export async function removeGeofence(identifier) {
  await BackgroundGeolocation.removeGeofence({ identifier });
}

export async function listMonitoredGeofences() {
  const { regions } = await BackgroundGeolocation.getMonitoredGeofences();
  return regions;
}

/**
 * Listener opcional para depurar en vivo mientras la app está abierta.
 * El webhook nativo llega igual aunque no tengas este listener montado.
 */
export function watchGeofenceTransitionsForDebug(onTransition) {
  return BackgroundGeolocation.addListener('geofenceTransition', (event) => {
    console.log('[geofence]', event.transition, event.identifier, event.payload);
    onTransition?.(event);
  });
}

export function watchGeofenceErrorsForDebug(onError) {
  return BackgroundGeolocation.addListener('geofenceError', (event) => {
    console.error('[geofence:error]', event.identifier, event.message);
    onError?.(event);
  });
}
