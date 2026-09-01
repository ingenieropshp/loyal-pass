// src/services/deviceRegistration.js
//
// Obtiene un deviceId estable para el dispositivo actual y lo sincroniza
// con la tabla `device_push_tokens` en Supabase, junto con el token FCM.
// Este mismo deviceId es el que luego se inyecta como `payload` en las
// geocercas (ver geofenceService.js) para que la Edge Function sepa a
// quién notificar.

import { Device } from '@capacitor/device';
import { PushNotifications } from '@capacitor/push-notifications';
import { supabase } from '../lib/supabaseClient'; // ajusta la ruta a tu cliente Supabase

const DEVICE_ID_KEY = 'bistro_device_id';

/**
 * Devuelve un identificador estable del dispositivo.
 * @capacitor/device.getId() ya es estable por instalación (ANDROID_ID en
 * Android, identifierForVendor en iOS), así que no hace falta generar un
 * UUID propio salvo que quieras uno independiente del vendor.
 */
export async function getDeviceId() {
  const cached = localStorage.getItem(DEVICE_ID_KEY);
  if (cached) return cached;

  const { identifier } = await Device.getId();
  localStorage.setItem(DEVICE_ID_KEY, identifier);
  return identifier;
}

/**
 * Pide permiso de notificaciones push, registra el dispositivo en FCM/APNs
 * y guarda (upsert) el par {deviceId, fcmToken} en Supabase.
 *
 * IMPORTANTE: esto debe ejecutarse ANTES de registrar las geocercas, porque
 * geofenceService.js necesita el deviceId ya persistido para incluirlo en
 * el payload nativo.
 */
export async function registerDeviceForPush() {
  const deviceId = await getDeviceId();
  const deviceInfo = await Device.getInfo(); // platform, model, osVersion...

  const permStatus = await PushNotifications.checkPermissions();
  if (permStatus.receive !== 'granted') {
    const req = await PushNotifications.requestPermissions();
    if (req.receive !== 'granted') {
      throw new Error('Permiso de notificaciones push denegado');
    }
  }

  await PushNotifications.register();

  // El token llega de forma asíncrona vía evento nativo.
  const fcmToken = await new Promise((resolve, reject) => {
    const successHandle = PushNotifications.addListener('registration', (token) => {
      successHandle.then((h) => h.remove());
      errorHandle.then((h) => h.remove());
      resolve(token.value);
    });
    const errorHandle = PushNotifications.addListener('registrationError', (err) => {
      successHandle.then((h) => h.remove());
      errorHandle.then((h) => h.remove());
      reject(err);
    });
  });

  const { error } = await supabase
    .from('device_push_tokens')
    .upsert(
      {
        device_id: deviceId,
        fcm_token: fcmToken,
        platform: deviceInfo.platform, // 'ios' | 'android'
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'device_id' }
    );

  if (error) throw error;

  return { deviceId, fcmToken };
}
