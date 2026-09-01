// src/services/permissions.js
//
// Flujo de permisos en DOS pasos, tal como lo requieren tanto Android 10+
// como iOS para llegar a "Allow always" / "Always". Pedir todo de golpe
// falla silenciosamente en Android.

import { BackgroundGeolocation } from '@capgo/background-geolocation';

/**
 * Paso 1: permiso de ubicación en primer plano (+ notificaciones en Android 13+).
 * Muestra el diálogo estándar del sistema.
 */
export async function requestForegroundLocation() {
  return BackgroundGeolocation.requestPermissions({
    permissions: ['location', 'notification'],
  });
}

/**
 * Paso 2: escalar a background/"Always". Idealmente se llama después de
 * mostrarle al usuario una pantalla explicando por qué la app necesita
 * ubicación en segundo plano (Google lo exige para pasar la revisión de
 * Play Store si usas ACCESS_BACKGROUND_LOCATION).
 *
 * - Android 11+: lleva al usuario a Ajustes > Ubicación de la app, donde
 *   debe elegir manualmente "Permitir todo el tiempo".
 * - iOS: el sistema muestra el prompt de upgrade de "Al usar la app" a
 *   "Siempre".
 */
export async function requestBackgroundLocation() {
  const status = await BackgroundGeolocation.requestPermissions({
    permissions: ['backgroundLocation'],
  });

  // En Android 11+ es común que el permiso quede en "denied" tras la
  // primera llamada porque el sistema exige el cambio manual en Ajustes.
  if (status.backgroundLocation === 'denied') {
    await BackgroundGeolocation.openSettings();
  }

  return status;
}

/**
 * Chequeo de solo lectura, sin mostrar diálogos. Útil para pantallas de
 * configuración o para decidir si mostrar el flujo de onboarding de permisos.
 */
export async function checkLocationPermissions() {
  return BackgroundGeolocation.checkPermissions();
}

/**
 * Orquesta el flujo completo de permisos "always" + arranca el watcher de
 * ubicación con notificación persistente (evita que Android/iOS congelen
 * el proceso en background).
 */
export async function ensureAlwaysLocationAndStartWatcher() {
  await requestForegroundLocation();

  const status = await checkLocationPermissions();
  if (status.backgroundLocation !== 'granted' && status.backgroundLocation !== 'always') {
    await requestBackgroundLocation();
  }

  // start() con backgroundMessage/backgroundTitle es lo que obliga a Android
  // a mantener un foreground service con notificación persistente, y a iOS
  // a seguir entregando ubicaciones con la app en background.
  await BackgroundGeolocation.start(
    {
      backgroundTitle: 'Bistro Connect activo',
      backgroundMessage: 'Detectando cuando estás cerca de tus restaurantes favoritos.',
      requestPermissions: false, // ya lo pedimos arriba explícitamente
      stale: false,
      distanceFilter: 30,
    },
    (location, error) => {
      if (error) {
        console.error('[location:error]', error.code, error);
        return;
      }
      // Opcional: solo para depuración; la lógica de geocercas es nativa
      // y no depende de este callback.
      console.log('[location]', location.latitude, location.longitude);
    }
  );
}

export async function stopLocationWatcher() {
  await BackgroundGeolocation.stop();
}
