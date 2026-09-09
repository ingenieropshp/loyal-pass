/**
 * permisosDispositivo.js
 * ────────────────────────────────────────────────────────────────────────
 * Chequeos de permisos del sistema (GPS + notificaciones push) y acceso
 * rápido a la configuración nativa. Extraído de CentroNotificaciones.jsx
 * para que CuentaScreen.jsx (bloque "Diagnóstico rápido") comparta EXACTAMENTE
 * la misma lógica en vez de duplicarla — un solo lugar que mantener si
 * algún día se agrega, por ejemplo, un plugin nativo distinto.
 *
 * Nota sobre el diagnóstico de GPS: en este proyecto no hay ningún llamado
 * previo a `BackgroundGeolocation.checkPermissions()` (el plugin
 * @capgo/background-geolocation instalado no garantiza esa forma de
 * respuesta en todas las plataformas), así que el chequeo es defensivo: si
 * el método existe se intenta primero (try/catch), y siempre queda un
 * fallback a la API web estándar `navigator.permissions.query({ name:
 * 'geolocation' })`, que sí está documentada y funciona igual dentro del
 * WebView de Capacitor. Si ninguna de las dos puede responder, se devuelve
 * un estado neutro ('desconocida') en vez de afirmar "inactiva" sin estar
 * seguros.
 */
import { Capacitor } from '@capacitor/core';

// Chequeo defensivo de GPS: intenta primero la API nativa del plugin (si
// existe), y si no puede responder cae a la API web estándar.
export async function chequearPermisoGPS() {
  try {
    if (Capacitor.isNativePlatform()) {
      const mod = await import('@capgo/background-geolocation');
      const BackgroundGeolocation = mod?.BackgroundGeolocation;
      if (BackgroundGeolocation && typeof BackgroundGeolocation.checkPermissions === 'function') {
        const res = await BackgroundGeolocation.checkPermissions();
        const valores = Object.values(res || {}).map(String).join(' ').toLowerCase();
        if (valores) return valores.includes('grant') ? 'activa' : 'inactiva';
      }
    }
  } catch {
    // El plugin no expone (o no soporta en esta plataforma) checkPermissions — seguimos al fallback web.
  }

  try {
    if (typeof navigator !== 'undefined' && navigator.permissions?.query) {
      const estado = await navigator.permissions.query({ name: 'geolocation' });
      if (estado.state === 'granted') return 'activa';
      if (estado.state === 'denied') return 'inactiva';
    }
  } catch {
    // Algunos navegadores/WebViews no soportan 'geolocation' en la Permissions API.
  }

  return 'desconocida';
}

// Chequeo de notificaciones push: en nativo usa @capacitor/push-notifications
// (API estable y documentada, `checkPermissions()` → { receive }); en web
// cae al mismo patrón `Notification.permission` que ya usa SelectorNotificaciones.jsx.
export async function chequearPermisoPush() {
  try {
    if (Capacitor.isNativePlatform()) {
      const mod = await import('@capacitor/push-notifications');
      const PushNotifications = mod?.PushNotifications;
      if (PushNotifications && typeof PushNotifications.checkPermissions === 'function') {
        const res = await PushNotifications.checkPermissions();
        if (res?.receive === 'granted') return 'activa';
        if (res?.receive) return 'inactiva';
      }
    } else if (typeof window !== 'undefined' && 'Notification' in window) {
      if (Notification.permission === 'granted') return 'activa';
      if (Notification.permission === 'denied') return 'inactiva';
    }
  } catch {
    // Seguimos con estado desconocido antes que afirmar algo sin estar seguros.
  }
  return 'desconocida';
}

// Acceso directo a la pantalla de configuración de la app (Android/iOS) —
// usa el plugin capacitor-native-settings, ya instalado en package.json.
export async function abrirConfiguracionSistema() {
  try {
    const mod = await import('capacitor-native-settings');
    const { NativeSettings, AndroidSettings, IOSSettings } = mod || {};
    if (NativeSettings) {
      await NativeSettings.open({ optionAndroid: AndroidSettings.ApplicationDetails, optionIOS: IOSSettings.App });
    }
  } catch (err) {
    console.warn('[permisosDispositivo] No se pudo abrir la configuración del sistema:', err?.message || err);
  }
}
