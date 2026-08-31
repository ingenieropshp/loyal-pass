/**
 * usePushNotifications.js — LoyalPass
 * ─────────────────────────────────────────────────────────────────────────
 * ⚠️ VERSIÓN TEMPORAL DE DEBUG — tiene alert() en cada paso para ver en
 * pantalla, sin depender de la compu, en qué punto falla el registro del
 * token FCM. Cuando confirmemos que anda, hay que sacar los alert() y
 * volver a la versión limpia (solo console.log/console.error).
 *
 * Registra el dispositivo en FCM (Firebase Cloud Messaging) vía
 * @capacitor/push-notifications y guarda el token resultante en
 * `device_push_tokens`, asociado al mismo `device_id` que ya usa el resto
 * de la app (utils/deviceId.js).
 */

import { useEffect } from 'react';
import { Capacitor } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';
import { supabase } from '../services/supabaseClient';
import { getDeviceId } from '../utils/deviceId';

async function guardarTokenEnSupabase(token) {
  const deviceId = getDeviceId();
  alert('[DEBUG] Token FCM recibido: ' + token.substring(0, 20) + '...\ndeviceId: ' + deviceId);

  if (!deviceId) {
    alert('[DEBUG] ERROR: no hay deviceId, no se puede guardar');
    return;
  }

  const { error } = await supabase
    .from('device_push_tokens')
    .upsert(
      {
        device_id: deviceId,
        fcm_token: token,
        platform: Capacitor.getPlatform(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'device_id' }
    );

  if (error) {
    alert('[DEBUG] ERROR guardando en Supabase: ' + error.message);
  } else {
    alert('[DEBUG] ✅ Token guardado en Supabase correctamente');
  }
}

export function usePushNotifications() {
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) {
      alert('[DEBUG] No es plataforma nativa, se salta el registro push');
      return;
    }

    let listenerRegistration;
    let listenerError;

    (async () => {
      try {
        alert('[DEBUG] Iniciando registro push...');

        let estado = await PushNotifications.checkPermissions();
        alert('[DEBUG] Permiso actual: ' + estado.receive);

        if (estado.receive === 'prompt') {
          estado = await PushNotifications.requestPermissions();
          alert('[DEBUG] Permiso después de pedir: ' + estado.receive);
        }

        if (estado.receive !== 'granted') {
          alert('[DEBUG] ❌ Permiso denegado, no se puede registrar push');
          return;
        }

        listenerRegistration = await PushNotifications.addListener('registration', (token) => {
          guardarTokenEnSupabase(token.value);
        });

        listenerError = await PushNotifications.addListener('registrationError', (err) => {
          alert('[DEBUG] ❌ Error de registro FCM: ' + JSON.stringify(err));
        });

        alert('[DEBUG] Listeners listos, llamando a register()...');
        await PushNotifications.register();
        alert('[DEBUG] register() llamado sin errores, esperando token...');
      } catch (err) {
        alert('[DEBUG] ❌ Excepción inicializando push nativo: ' + err.message);
      }
    })();

    return () => {
      listenerRegistration?.remove();
      listenerError?.remove();
    };
  }, []);
}
