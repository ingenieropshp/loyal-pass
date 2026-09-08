/**
 * CentroNotificaciones.jsx
 * ────────────────────────────────────────────────────────────────────────
 * Centro de Notificaciones "in-app" del cliente (bistro-app). Drawer
 * lateral deslizante, estilo "Luxury Charcoal & Gold", que se abre desde
 * la campanita de AppHeader.jsx. Consume la tabla real `historial_notificaciones`
 * (RLS ya la filtra por el cliente autenticado) a través del hook
 * `useNotificaciones` (instanciado UNA sola vez en App.jsx y pasado aquí
 * por props, junto con AppHeader, para no duplicar la consulta/suscripción).
 *
 * Incluye además un bloque de diagnóstico de permisos (GPS + notificaciones
 * push) — crucial para que los clientes de Apartadó no se pierdan los
 * puntos pasivos de geocerca de 200 m ni las alertas de vencimiento.
 *
 * Nota sobre el diagnóstico de GPS: en este proyecto no existe todavía
 * ningún llamado a `BackgroundGeolocation.checkPermissions()` (el plugin
 * @capgo/background-geolocation instalado no garantiza esa forma de
 * respuesta), así que el chequeo es defensivo: si el método existe se
 * intenta primero (try/catch), y siempre queda un fallback a la API web
 * estándar `navigator.permissions.query({ name: 'geolocation' })`, que sí
 * está documentada y funciona igual dentro del WebView de Capacitor. Si
 * ninguna de las dos puede responder, se muestra un estado neutro ("—")
 * en vez de afirmar "INACTIVA" sin estar seguros.
 */
import { useState, useEffect, useCallback } from 'react';
import { Capacitor } from '@capacitor/core';

function iconoParaTipo(tipo = '') {
  const t = String(tipo).toLowerCase();
  if (t.includes('geocerca') || t.includes('proximidad') || t.includes('llegada') || t.includes('cercania')) return '📍';
  if (t.includes('vencimiento') || t.includes('vence')) return '⏳';
  if (t.includes('nivel') || t.includes('recompensa') || t.includes('bono') || t.includes('bienvenida') || t.includes('canje') || t.includes('redenc')) return '🎁';
  return '🔔';
}

function formatearFecha(fechaISO) {
  if (!fechaISO) return '';
  try {
    const fecha = new Date(fechaISO);
    const texto = new Intl.DateTimeFormat('es-CO', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(fecha);
    return texto.replace('.', '');
  } catch {
    return '';
  }
}

// Chequeo defensivo de GPS: intenta primero la API nativa del plugin (si
// existe), y si no puede responder cae a la API web estándar.
async function chequearPermisoGPS() {
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
async function chequearPermisoPush() {
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

async function abrirConfiguracionSistema() {
  try {
    const mod = await import('capacitor-native-settings');
    const { NativeSettings, AndroidSettings, IOSSettings } = mod || {};
    if (NativeSettings) {
      await NativeSettings.open({ optionAndroid: AndroidSettings.ApplicationDetails, optionIOS: IOSSettings.App });
    }
  } catch (err) {
    console.warn('[CentroNotificaciones] No se pudo abrir la configuración del sistema:', err?.message || err);
  }
}

function EstadoDiagnostico({ icono, etiqueta, estado }) {
  const texto = estado === 'activa' ? 'ACTIVA' : estado === 'inactiva' ? 'INACTIVA' : '—';
  return (
    <div className="centro-notif-diag-item">
      <span>{icono} {etiqueta}</span>
      <span className={`centro-notif-diag-estado ${estado}`}>{texto}</span>
      {estado === 'inactiva' && Capacitor.isNativePlatform() && (
        <button type="button" className="centro-notif-diag-btn" onClick={abrirConfiguracionSistema}>
          Activar
        </button>
      )}
    </div>
  );
}

export function CentroNotificaciones({
  open,
  onClose,
  notificaciones = [],
  cargando = false,
  unreadCount = 0,
  onMarcarTodasLeidas,
}) {
  const [gpsEstado,  setGpsEstado]  = useState('desconocida');
  const [pushEstado, setPushEstado] = useState('desconocida');

  useEffect(() => {
    if (!open) return;
    let cancelado = false;

    chequearPermisoGPS().then(estado => { if (!cancelado) setGpsEstado(estado); });
    chequearPermisoPush().then(estado => { if (!cancelado) setPushEstado(estado); });

    return () => { cancelado = true; };
  }, [open]);

  const cerrar = useCallback(() => onClose?.(), [onClose]);

  return (
    <div
      className={`centro-notif-overlay ${open ? 'is-open' : ''}`}
      onClick={cerrar}
      aria-hidden={!open}
    >
      <div
        className={`centro-notif-drawer ${open ? 'is-open' : ''}`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Centro de notificaciones"
      >
        <div className="centro-notif-header">
          <h3>Notificaciones</h3>
          <button type="button" className="centro-notif-cerrar" onClick={cerrar} aria-label="Cerrar">
            ✕
          </button>
        </div>

        <div className="centro-notif-diagnostico">
          <EstadoDiagnostico icono="📍" etiqueta="Localización" estado={gpsEstado} />
          <EstadoDiagnostico icono="🔔" etiqueta="Notif. push" estado={pushEstado} />
          {(gpsEstado === 'inactiva' || pushEstado === 'inactiva') && (
            <p className="centro-notif-diag-nota">
              Actívalos para no perderte los puntos pasivos de cercanía (200 m) ni las alertas de vencimiento.
            </p>
          )}
        </div>

        <div className="centro-notif-list">
          {cargando ? (
            <p className="centro-notif-vacio">Cargando…</p>
          ) : notificaciones.length === 0 ? (
            <p className="centro-notif-vacio">No tienes notificaciones todavía.</p>
          ) : (
            notificaciones.map((n) => (
              <div key={n.id} className={`centro-notif-item${n.leido ? '' : ' no-leida'}`}>
                <span className="centro-notif-icon">{iconoParaTipo(n.tipo)}</span>
                <div className="centro-notif-texto">
                  <p className="centro-notif-titulo">{n.titulo}</p>
                  {n.contenido && <p className="centro-notif-contenido">{n.contenido}</p>}
                  <p className="centro-notif-fecha">{formatearFecha(n.fecha_envio)}</p>
                </div>
                {!n.leido && <span className="centro-notif-dot" />}
              </div>
            ))
          )}
        </div>

        <div className="centro-notif-footer">
          <button
            type="button"
            className="centro-notif-btn-marcar"
            onClick={onMarcarTodasLeidas}
            disabled={unreadCount === 0}
          >
            Marcar todas como leídas
          </button>
        </div>
      </div>
    </div>
  );
}
