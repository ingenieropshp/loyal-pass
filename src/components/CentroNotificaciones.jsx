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
 * puntos pasivos de geocerca de 200 m ni las alertas de vencimiento. Los
 * chequeos en sí viven en utils/permisosDispositivo.js (compartidos con el
 * bloque de diagnóstico de CuentaScreen.jsx — misma lógica, un solo lugar).
 */
import { useState, useEffect, useCallback } from 'react';
import { Capacitor } from '@capacitor/core';
import { chequearPermisoGPS, chequearPermisoPush, abrirConfiguracionSistema } from '../utils/permisosDispositivo';
import { abrirGuiaPermisos } from './GuiaPermisosModal';
import './CentroNotificaciones.css';

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
          <button
            type="button"
            className="centro-notif-diag-btn"
            style={{ marginTop: 8 }}
            onClick={() => { abrirGuiaPermisos(); cerrar(); }}
          >
            Ver guía de permisos
          </button>
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
