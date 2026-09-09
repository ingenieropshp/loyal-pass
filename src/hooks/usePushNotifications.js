/**
 * usePushNotifications.js — LoyalPass
 * ─────────────────────────────────────────────────────────────────────────
 * Registra el dispositivo en FCM (Firebase Cloud Messaging) vía
 * @capacitor/push-notifications y guarda el token resultante en
 * `device_push_tokens`, asociado al mismo `device_id` que ya usa el resto
 * de la app (utils/deviceId.js).
 *
 * Este token es lo que le permite al backend (Edge Function
 * geofence-webhook) despertar una notificación real cuando la app está
 * completamente cerrada — algo que LocalNotifications NO puede hacer,
 * porque requiere JS corriendo y el proceso puede estar muerto.
 *
 * ── Primer plano, segundo plano y app cerrada ──────────────────────────
 * Android decide solo QUIÉN muestra el push, según el estado de la app:
 *   - App cerrada / en segundo plano → el propio sistema operativo dibuja
 *     la notificación usando `android.notification` del payload FCM (ver
 *     geofence-webhook/index.ts) — nada que hacer acá.
 *   - App en primer plano (JS corriendo) → Android NO dibuja nada solo:
 *     dispara el evento 'pushNotificationReceived' y espera que la app
 *     decida qué mostrar. Antes este archivo no escuchaba ese evento, así
 *     que un push que llegaba con la app abierta no se veía en ningún
 *     lado. El listener de abajo lo resuelve mostrando un toast propio
 *     (ver components/PushToast.jsx) — no bloqueante, con el mismo
 *     lenguaje visual del resto de la app.
 *   - Toque sobre la notificación (segundo plano o app cerrada) → dispara
 *     'pushNotificationActionPerformed'. Se usa el `data` que manda el
 *     backend (ver geofence-webhook/index.ts) para llevar al usuario
 *     directo a la tarjeta/saldo del restaurante correspondiente, en vez
 *     de abrir la app en la pantalla que haya quedado guardada.
 *
 * Requiere:
 *   npm install @capacitor/push-notifications
 *   npx cap sync android
 *   google-services.json colocado en android/app/ (ver instrucciones)
 */

import { useEffect } from 'react';
import { Capacitor } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';
import { supabase } from '../services/supabaseClient';
import { getDeviceId } from '../utils/deviceId';
import { dispararToastPush } from '../components/PushToast';
import { CANAL_ID_GEOFENCE } from './useGeofencing';

async function guardarTokenEnSupabase(token) {
  const deviceId = await getDeviceId();
  if (!deviceId) return;

  // SEGURIDAD: ya no se escribe directo a `device_push_tokens` (esa tabla
  // quedó blindada — sin política RLS abierta para anon/authenticated).
  // Ahora se pasa por la función RPC `fn_guardar_token_push`, que corre
  // como SECURITY DEFINER y hace el mismo upsert (device_id, fcm_token,
  // platform) pero con privilegios controlados, para que nadie pueda
  // escribir o pisar el token de OTRO dispositivo llamando directo a la
  // tabla con las llaves públicas del proyecto.
  const { error } = await supabase.rpc('fn_guardar_token_push', {
    p_device_id: deviceId,
    p_fcm_token: token,
    p_platform: Capacitor.getPlatform(),
  });

  if (error) {
    console.error('[usePushNotifications] Error guardando token FCM:', error.message);
  }
}

/**
 * Crea (o confirma) el canal nativo de Android que usa el backend en
 * `android.notification.channel_id` (ver geofence-webhook/index.ts). Es EL
 * MISMO canal que `useGeofencing.js` ya crea para las notificaciones
 * locales de geocerca (`CANAL_ID_GEOFENCE = 'geofence-alerts'`) — no uno
 * nuevo: los canales de notificación son un recurso del sistema operativo
 * compartido entre plugins de Capacitor, y crear dos canales casi
 * idénticos ("geofence-alerts" vs "geofence_alerts") confundiría al
 * usuario en Ajustes → Notificaciones sin ningún beneficio. Se llama acá
 * TAMBIÉN (además de en useGeofencing.js) porque un push puede llegar
 * antes de que el usuario haya cargado nunca ningún restaurante con
 * geocerca configurada — crear un canal ya existente con el mismo ID es
 * una operación segura y sin efecto en Android (gana la primera
 * definición, esta llamada es un no-op si ya se creó antes).
 */
async function asegurarCanalPush() {
  if (Capacitor.getPlatform() !== 'android') return;
  try {
    await PushNotifications.createChannel({
      id: CANAL_ID_GEOFENCE,
      name: 'Alertas de cercanía y puntos',
      description: 'Notificaciones de puntos ganados por proximidad y por consumo',
      importance: 5, // IMPORTANCE_HIGH → heads-up + sonido
      visibility: 1, // visible en pantalla de bloqueo
      sound: 'default',
      vibration: true,
    });
  } catch (err) {
    console.warn('[usePushNotifications] Error creando canal de notificación push:', err?.message || err);
  }
}

export function usePushNotifications() {
  useEffect(() => {
    // Push real (FCM) solo existe en build nativo — en la PWA esto no aplica,
    // ahí seguís usando push_subscriptions + VAPID (SelectorNotificaciones.jsx).
    if (!Capacitor.isNativePlatform()) return;

    let listenerRegistration;
    let listenerError;
    let listenerRecibido;
    let listenerAccion;

    (async () => {
      try {
        await asegurarCanalPush();

        let estado = await PushNotifications.checkPermissions();
        if (estado.receive === 'prompt') {
          estado = await PushNotifications.requestPermissions();
        }
        if (estado.receive !== 'granted') {
          console.warn('[usePushNotifications] Permiso de notificaciones push denegado');
          return;
        }

        listenerRegistration = await PushNotifications.addListener('registration', (token) => {
          guardarTokenEnSupabase(token.value);
        });

        listenerError = await PushNotifications.addListener('registrationError', (err) => {
          console.error('[usePushNotifications] Error de registro FCM:', err);
        });

        // ── Primer plano: Android no dibuja nada solo, hay que mostrarlo ──
        listenerRecibido = await PushNotifications.addListener('pushNotificationReceived', (notificacion) => {
          dispararToastPush({
            titulo: notificacion.title || 'LoyalPass',
            cuerpo:  notificacion.body || '',
          });
        });

        // ── El usuario tocó la notificación (segundo plano o app cerrada) ──
        // `data` viaja en el payload FCM (ver geofence-webhook/index.ts:
        // tipo/restaurante_id/puntos) — se usa para llevarlo directo a la
        // sede correspondiente en vez de abrir la app donde haya quedado.
        listenerAccion = await PushNotifications.addListener('pushNotificationActionPerformed', (accion) => {
          const datos = accion?.notification?.data || {};
          if (datos.restaurante_id) {
            window.location.href = `/?restaurante_id=${encodeURIComponent(datos.restaurante_id)}`;
          }
        });

        await PushNotifications.register();
      } catch (err) {
        console.error('[usePushNotifications] Error inicializando push nativo:', err.message);
      }
    })();

    return () => {
      listenerRegistration?.remove();
      listenerError?.remove();
      listenerRecibido?.remove();
      listenerAccion?.remove();
    };
  }, []);
}
