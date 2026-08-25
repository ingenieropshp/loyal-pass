/**
 * useGeofencingCapgo.js — LoyalPass
 * ────────────────────────────────────────────────────────────────────────
 * Geofencing NATIVO (iOS/Android) con @capgo/background-geolocation +
 * notificación local con @capacitor/local-notifications al entrar al
 * radio de un comercio, incluso con la app completamente cerrada.
 *
 * DIFERENCIA CLAVE con tu hooks/useGeofencing.js actual (v5.4):
 * Tu hook v5.4 usa `addWatcher` (tracking continuo de GPS) y calcula la
 * distancia por Haversine en JS cada vez que llega una posición — por eso
 * el comentario en ese archivo dice "en nativo no hay Service Worker que
 * lo haga". Eso funciona pero exige que TU código JS esté vivo para hacer
 * la cuenta, lo cual es más pesado en batería y depende de que el proceso
 * de la app siga corriendo.
 *
 * @capgo/background-geolocation añade geocercas NATIVAS reales
 * (setupGeofencing + addGeofence): el sistema operativo (Core Location en
 * iOS / Geofencing API en Android) vigila el radio a nivel de SO, sin
 * mantener tu JS ni tu GPS activo todo el tiempo, y despierta el proceso
 * SOLO en el instante del cruce de borde. Es el camino recomendado cuando
 * el requisito es "notificar con la app 100% cerrada" con el menor
 * consumo de batería posible.
 *
 * Este archivo es un módulo NUEVO y autosuficiente (no reemplaza tu
 * useGeofencing.js v5.4). Te lo entrego así para que puedas probarlo en
 * paralelo o migrar el camino nativo internamente cuando estés conforme.
 * Reutiliza tus mismas convenciones: comentarios en español, nombres de
 * función en español, canal de notificación Android con sonido, e id
 * numérico estable por comercio para evitar notificaciones duplicadas.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { Capacitor } from '@capacitor/core';
import { BackgroundGeolocation } from '@capgo/background-geolocation';
import { LocalNotifications } from '@capacitor/local-notifications';

// ── Configuración ─────────────────────────────────────────────────────────

// Nombre de marca usado en el copy de la notificación.
const NOMBRE_MARCA = 'LoyalPass';

// v2: se cambió el ID a propósito. Los canales de notificación de Android
// son INMUTABLES una vez creados en el teléfono del usuario — si dejábamos
// el mismo ID de antes, cualquier teléfono donde la app ya se hubiera
// instalado se habría quedado para siempre con el canal viejo (sin el
// sonido personalizado), sin importar qué diga el código de ahora en
// adelante. Con un ID nuevo, Android crea el canal de cero, ya con el
// sonido correcto, incluso en teléfonos que ya tenían la app instalada.
const CANAL_ID_GEOFENCE = 'geofence-cercania-capgo-v2';

// ⚠️ RADIO MÍNIMO RECOMENDADO: 100 m es el piso que pediste, y coincide
// con el mínimo que documentan los plugins de geofencing nativo (Apple
// recomienda no bajar de ~100 m). Con radios más chicos, el margen de
// error normal del GPS (10-50 m en ciudad, peor entre edificios altos)
// genera falsos negativos (nunca dispara) o falsos positivos (dispara y
// se cancela en loop) — ver sección de buenas prácticas más abajo.
const RADIO_MINIMO_METROS = 100;

// Ejemplo de comercios aliados — en tu app real esto vendría de Supabase
// (mismo shape que ya devuelve GeofencingProvider.jsx: restaurante_id,
// nombre, latitud, longitud, radio_aviso). Lo dejo hardcodeado acá solo
// para que el ejemplo sea ejecutable de forma aislada.
const COMERCIOS_EJEMPLO = [
  { id: 'resto_001', nombre: 'Café Central',      latitude: 6.244203, longitude: -75.581212, radius: 100 },
  { id: 'resto_002', nombre: 'Pizzería Napoli',    latitude: 6.208227, longitude: -75.567390, radius: 150 },
  { id: 'resto_003', nombre: 'Panadería El Trigo', latitude: 6.217407, longitude: -75.583639, radius: 100 },
];

// LocalNotifications.schedule requiere id numérico (int32) por notificación.
// Mismo hash estable que ya usas en useGeofencing.js — así un mismo comercio
// siempre reemplaza su notificación anterior en vez de acumular duplicados.
function idNumericoDesde(texto) {
  const str = String(texto);
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) || 1;
}

// ── Canal de notificación Android (igual razón que en tu hook v4/v5.4:
// en Android 8+ el sonido se define en el canal, no en la notificación,
// y el canal es inmutable una vez creado en el celular del usuario) ────────
async function asegurarCanalNotificacion() {
  if (Capacitor.getPlatform() !== 'android') return;
  try {
    await LocalNotifications.createChannel({
      id:          CANAL_ID_GEOFENCE,
      name:        'Cercanía a comercios',
      description: 'Avisos cuando estás cerca de un comercio afiliado',
      importance:  5, // IMPORTANCE_HIGH → heads-up + sonido
      visibility:  1,
      // Debe existir en android/app/src/main/res/raw/ (sin subcarpetas).
      // El plugin arma internamente la URI android.resource://.../raw/<nombre>,
      // así que aquí sí se incluye la extensión del archivo.
      sound: 'mixkit_happy_bells_notification_937.wav',
    });
  } catch (err) {
    console.warn('[GeofencingCapgo] Error creando canal:', err.message);
  }
}

/**
 * Disclosure previo OBLIGATORIO antes del diálogo nativo de "Permitir
 * siempre" — no es solo buena práctica de UX: Google Play y App Store lo
 * EXIGEN para apps que piden ubicación en segundo plano (ver notas en
 * AndroidManifest-permisos.xml e Info-plist-snippet.xml). Debe explicar,
 * con tu propia UI, qué haces con la ubicación ANTES de que el usuario
 * vea el diálogo del sistema.
 *
 * Acá solo dejo la función como punto de extensión — reemplázala por tu
 * propio modal/bottom-sheet (ej. reutilizando el patrón visual de
 * BatteryOptimizationGuide.jsx, que ya tienes en el proyecto).
 */
// Clave en localStorage para recordar que el usuario ya aceptó el
// disclosure — así solo se pregunta UNA VEZ en la vida de la instalación,
// no cada vez que se vuelve a llamar iniciar() (por ejemplo al navegar
// entre perfiles de restaurantes, o al cerrar y reabrir la app).
const DISCLOSURE_ACEPTADO_KEY = 'loyalpass_geofencing_disclosure_ok';

async function mostrarDisclosurePrevio() {
  // Si ya lo aceptó antes, no volver a preguntar.
  try {
    if (localStorage.getItem(DISCLOSURE_ACEPTADO_KEY) === 'true') {
      return true;
    }
  } catch (err) {
    // localStorage no disponible (muy raro en un WebView) — seguimos y
    // preguntamos igual, simplemente no vamos a poder recordar la respuesta.
  }

  // TODO: reemplazar por un modal real de tu UI.
  // Ejemplo mínimo con window.confirm solo para que el flujo sea funcional
  // de entrada:
  const acepta = window.confirm(
    `${NOMBRE_MARCA} quiere avisarte cuando pases cerca de un comercio ` +
    'afiliado, incluso con la app cerrada, para que no pierdas la ' +
    'oportunidad de sumar puntos. Tu ubicación nunca se comparte con ' +
    'terceros ni se usa para otro fin.\n\n¿Activar avisos de cercanía?'
  );

  if (acepta) {
    try { localStorage.setItem(DISCLOSURE_ACEPTADO_KEY, 'true'); } catch (err) { /* no-op */ }
  }
  // Si el usuario RECHAZA, a propósito NO lo guardamos como "definitivo" —
  // así, la próxima vez que abra la app, se le vuelve a preguntar (puede
  // haber sido un rechazo accidental). Si prefieres que un rechazo también
  // quede fijo para siempre, avísame y lo cambiamos.

  return acepta;
}

// ── Hook ─────────────────────────────────────────────────────────────────

/**
 * @param {Array<{id:string, nombre:string, latitude:number, longitude:number, radius:number}>} comercios
 *        Lista de geocercas a registrar. Si no se pasa, usa COMERCIOS_EJEMPLO.
 */
export function useGeofencingCapgo(comercios = COMERCIOS_EJEMPLO) {
  // Estados posibles: 'idle' | 'pidiendo_permiso' | 'permiso_denegado' |
  // 'activo' | 'error'
  const [estado, setEstado]             = useState('idle');
  const [comerciosActivos, setComerciosActivos] = useState([]);
  const listenersRef = useRef([]); // handles de addListener, para poder limpiarlos

  // ── Paso 1: permisos ──────────────────────────────────────────────────
  const solicitarPermisos = useCallback(async () => {
    setEstado('pidiendo_permiso');

    // 1a. Disclosure propio ANTES del diálogo del sistema.
    const aceptaDisclosure = await mostrarDisclosurePrevio();
    if (!aceptaDisclosure) {
      console.warn('[GeofencingCapgo] Usuario rechazó el disclosure previo');
      setEstado('permiso_denegado');
      return false;
    }

    // 1b. Permiso de notificaciones locales (Android 13+ / iOS).
    try {
      const permisoNotif = await LocalNotifications.requestPermissions();
      if (permisoNotif.display !== 'granted') {
        // No bloqueamos el flujo por esto: seguimos pudiendo registrar
        // geocercas, pero avisamos porque sin este permiso nunca se va
        // a VER la notificación aunque la geocerca dispare correctamente.
        console.warn('[GeofencingCapgo] Notificaciones no concedidas — las geocercas van a disparar pero no se mostrará nada');
      }
      await asegurarCanalNotificacion();
    } catch (err) {
      console.warn('[GeofencingCapgo] Error pidiendo permiso de notificaciones:', err.message);
    }

    // 1c. Permiso de ubicación "Permitir siempre". setupGeofencing con
    // backgroundLocation:true dispara internamente el flujo de dos pasos
    // (foreground primero, luego el upgrade a background) tanto en
    // Android como en iOS, usando los textos ya definidos en
    // AndroidManifest.xml / Info.plist.
    try {
      await BackgroundGeolocation.setupGeofencing({
        backgroundLocation: true, // pide ACCESS_BACKGROUND_LOCATION en Android
        notifyOnEntry:      true, // nos interesa el evento de ENTRADA
        notifyOnExit:       false, // no pediste aviso de salida; déjalo en true si luego lo necesitas
      });
      return true;
    } catch (err) {
      console.warn('[GeofencingCapgo] Permiso de ubicación denegado o error de setup:', err.message);
      setEstado('permiso_denegado');
      return false;
    }
  }, []);

  // ── Paso 2: registrar la lista de geocercas ────────────────────────────
  const registrarGeocercas = useCallback(async (lista) => {
    const validas = lista.filter(c => {
      if (!c.id || Number.isNaN(c.latitude) || Number.isNaN(c.longitude)) {
        console.warn('[GeofencingCapgo] Comercio inválido, se omite:', c);
        return false;
      }
      if (c.radius < RADIO_MINIMO_METROS) {
        console.warn(
          `[GeofencingCapgo] Radio de "${c.nombre}" (${c.radius}m) por debajo ` +
          `del mínimo recomendado (${RADIO_MINIMO_METROS}m) — puede fallar por deriva de GPS`
        );
      }
      return true;
    });

    // Límites nativos: iOS permite ~20 geocercas simultáneas por app,
    // Android bastantes más (~100) pero conviene no acercarse al límite.
    // Si tu comercio afiliado supera ese número, registra solo las N más
    // cercanas a la última ubicación conocida del usuario y ve rotando
    // (algunos SDKs comerciales resuelven esto solos; el plugin gratuito no).
    if (validas.length > 20) {
      console.warn(
        `[GeofencingCapgo] ${validas.length} geocercas solicitadas — iOS solo ` +
        'soporta ~20 simultáneas. Se registran todas, pero en iOS puede fallar ' +
        'silenciosamente a partir de la #20. Considera limitar a las más cercanas.'
      );
    }

    for (const comercio of validas) {
      try {
        await BackgroundGeolocation.addGeofence({
          identifier: comercio.id,
          latitude:   comercio.latitude,
          longitude:  comercio.longitude,
          radius:     Math.max(comercio.radius, RADIO_MINIMO_METROS),
          notifyOnEntry: true,
          notifyOnExit:  false,
          extras: { nombre: comercio.nombre }, // viaja de vuelta en el evento geofenceTransition
        });
      } catch (err) {
        console.warn(`[GeofencingCapgo] Error registrando geocerca "${comercio.nombre}":`, err.message);
      }
    }

    setComerciosActivos(validas);
  }, []);

  // ── Paso 3: mostrar la notificación al entrar ──────────────────────────
  const mostrarNotificacionEntrada = useCallback(async (nombreComercio, identifier) => {
    try {
      await LocalNotifications.schedule({
        notifications: [
          {
            id:        idNumericoDesde(identifier),
            title:     `¡Estás cerca de ${nombreComercio}!`,
            body:      `Acumula puntos con ${NOMBRE_MARCA}`,
            channelId: CANAL_ID_GEOFENCE, // Android: qué canal (y sonido) usa
            smallIcon: 'ic_stat_icon',    // debe existir en android/app/src/main/res/drawable*
            extra:     { restauranteId: identifier },
          },
        ],
      });
      console.log(`[GeofencingCapgo] 🔔 Notificación enviada: ${nombreComercio}`);
    } catch (err) {
      console.warn('[GeofencingCapgo] Error mostrando notificación:', err.message);
    }
  }, []);

  // ── Orquestación completa ───────────────────────────────────────────────
  const iniciar = useCallback(async (listaComercios = comercios) => {
    if (!Capacitor.isNativePlatform()) {
      console.warn('[GeofencingCapgo] Geofencing nativo requiere build nativo (Android/iOS) — no funciona en navegador web');
      setEstado('error');
      return;
    }

    const permisoOk = await solicitarPermisos();
    if (!permisoOk) return; // ya quedó en 'permiso_denegado' — ver manejo abajo

    // Listener del evento de cruce de geocerca. Se registra ANTES de
    // agregar las geocercas para no perder ningún evento que llegue
    // apenas se registran (poco probable, pero es la práctica segura).
    const handleTransition = await BackgroundGeolocation.addListener(
      'geofenceTransition',
      (evento) => {
        // evento: { identifier, transition: 'ENTER' | 'EXIT', extras, ... }
        if (evento.transition !== 'ENTER') return;
        const nombre = evento.extras?.nombre ?? 'un comercio afiliado';
        console.log(`[GeofencingCapgo] 🟢 Entrada detectada: ${evento.identifier} (${nombre})`);
        mostrarNotificacionEntrada(nombre, evento.identifier);
      }
    );

    const handleError = await BackgroundGeolocation.addListener(
      'geofenceError',
      (evento) => {
        console.warn(`[GeofencingCapgo] Error de monitoreo en geocerca "${evento.identifier}":`, evento.message);
      }
    );

    listenersRef.current = [handleTransition, handleError];

    await registrarGeocercas(listaComercios);
    setEstado('activo');
    console.log('[GeofencingCapgo] Geofencing nativo activo ✅');
  }, [comercios, solicitarPermisos, registrarGeocercas, mostrarNotificacionEntrada]);

  const detener = useCallback(async () => {
    for (const comercio of comerciosActivos) {
      try {
        await BackgroundGeolocation.removeGeofence({ identifier: comercio.id });
      } catch (err) {
        console.warn(`[GeofencingCapgo] Error removiendo geocerca "${comercio.id}":`, err.message);
      }
    }
    listenersRef.current.forEach(h => h.remove());
    listenersRef.current = [];
    setComerciosActivos([]);
    setEstado('idle');
  }, [comerciosActivos]);

  // Limpieza al desmontar (ej. logout del usuario)
  useEffect(() => {
    return () => { detener(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { estado, comerciosActivos, iniciar, detener };
}
