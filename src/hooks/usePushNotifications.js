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

export function usePushNotifications() {
  useEffect(() => {
    // Push real (FCM) solo existe en build nativo — en la PWA esto no aplica,
    // ahí seguís usando push_subscriptions + VAPID (SelectorNotificaciones.jsx).
    if (!Capacitor.isNativePlatform()) return;

    let listenerRegistration;
    let listenerError;

    (async () => {
      try {
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

        await PushNotifications.register();
      } catch (err) {
        console.error('[usePushNotifications] Error inicializando push nativo:', err.message);
      }
    })();

    return () => {
      listenerRegistration?.remove();
      listenerError?.remove();
    };
  }, []);
}
