/**
 * deviceId.js — LoyalPass
 *
 * Identificador estable de dispositivo/navegador, usado para asociar cada
 * suscripción Web Push (tabla `push_subscriptions`) y cada métrica de
 * proximidad (tabla `metricas_proximidad`) a "alguien", en ausencia de un
 * sistema de auth de usuario en este flujo. Se genera una sola vez y se
 * persiste en localStorage — sobrevive recargas pero no reinstalaciones
 * ni "borrar datos del sitio".
 *
 * NOTA: si en el futuro agregan supabase.auth (login real), lo ideal es
 * reemplazar esto por auth.uid() y usarlo como FK en ambas tablas — este
 * helper es un puente mientras tanto, no un reemplazo definitivo.
 */

const LS_KEY = 'loyalpass_device_id';

export function getDeviceId() {
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
