/**
 * deviceId.js — LoyalPass
 *
 * Identificador estable de dispositivo, usado para asociar cada
 * suscripción push (device_push_tokens, push_subscriptions) y cada
 * métrica de proximidad (metricas_proximidad) a "alguien", en ausencia
 * de un sistema de auth de usuario en este flujo.
 *
 * En nativo (Android/iOS): usa Device.getId() de @capacitor/device, que
 * sobrevive desinstalaciones/reinstalaciones (a diferencia de localStorage,
 * que se borra al desinstalar la app) — solo cambia con un factory reset
 * del dispositivo. Requiere: npm install @capacitor/device && npx cap sync.
 *
 * En web/PWA (o si la API nativa falla): fallback a un UUID generado una
 * sola vez y persistido en localStorage, igual que antes.
 *
 * ⚠️ Es ASYNC ahora. Todo lugar que llamaba a getDeviceId() debe hacer
 * `await getDeviceId()`. Como cambia el identificador que se genera en
 * nativo, dispositivos que ya tenían un deviceId viejo (basado en
 * localStorage) van a registrar uno NUEVO la próxima vez que abran la
 * app — la fila vieja en device_push_tokens queda huérfana, no rompe nada,
 * pero no se borra sola.
 */

import { Capacitor } from '@capacitor/core';

const LS_KEY = 'loyalpass_device_id';

let cachedId = null;
let pendingPromise = null;

async function resolverDeviceId() {
  if (Capacitor.isNativePlatform()) {
    try {
      const { Device } = await import('@capacitor/device');
      const info = await Device.getId();
      if (info?.identifier) return info.identifier;
    } catch (err) {
      console.warn('[deviceId] Device.getId() falló, usando fallback:', err.message);
    }
  }

  // Fallback: web, o falló la API nativa.
  if (typeof window === 'undefined') return null;
  try {
    let id = localStorage.getItem(LS_KEY);
    if (!id) {
      id = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : `dev-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      localStorage.setItem(LS_KEY, id);
    }
    return id;
  } catch {
    // localStorage no disponible (modo privado estricto, etc.)
    return null;
  }
}

export async function getDeviceId() {
  if (cachedId) return cachedId;
  if (!pendingPromise) {
    pendingPromise = resolverDeviceId().then((id) => {
      cachedId = id;
      return id;
    });
  }
  return pendingPromise;
}
