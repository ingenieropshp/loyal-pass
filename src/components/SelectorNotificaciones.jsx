/**
 * SelectorNotificaciones.jsx
 *
 * Permite al usuario activar/desactivar notificaciones de geofencing
 * para cada restaurante donde está inscrito.
 *
 * Preferencias guardadas en localStorage con clave:
 *   bistro_notif_prefs → { [restaurante_id]: true/false }
 *
 * El GeofencingProvider lee estas preferencias para filtrar
 * qué restaurantes pasa al useGeofencing hook.
 */

import { useState, useEffect } from 'react';
import { useIOS } from '../hooks/useIOS';

const LS_KEY = 'bistro_notif_prefs';

// ── Leer/escribir preferencias ────────────────────────────────────────────────
export function getNotifPrefs() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); }
  catch { return {}; }
}

function setNotifPref(restauranteId, activo) {
  const prefs = getNotifPrefs();
  prefs[restauranteId] = activo;
  localStorage.setItem(LS_KEY, JSON.stringify(prefs));
  // Notificar al GeofencingProvider (misma pestaña) que las prefs cambiaron
  window.dispatchEvent(new Event('bistro_notif_changed'));
}

// ── Componente ────────────────────────────────────────────────────────────────
export function SelectorNotificaciones({ restaurantes = [] }) {
  const [prefs,    setPrefs]    = useState(getNotifPrefs());
  const [permiso,  setPermiso]  = useState(Notification.permission); // 'default'|'granted'|'denied'
  const [visible,  setVisible]  = useState(false);
  const { isIOS, isStandalone } = useIOS();
  const iosNoInstalado = isIOS && !isStandalone; // iPhone sin agregar a inicio: push no puede funcionar todavía

  // Sincronizar permiso real del navegador
  useEffect(() => {
    setPermiso(Notification.permission);
  }, [visible]);

  // Cuando se monta: activar por defecto los restaurantes inscritos si no hay prefs previas
  useEffect(() => {
    if (restaurantes.length === 0) return;
    const prefsActuales = getNotifPrefs();
    let cambio = false;
    restaurantes.forEach(r => {
      if (prefsActuales[r.id] === undefined) {
        prefsActuales[r.id] = true; // activado por defecto
        cambio = true;
      }
    });
    if (cambio) {
      localStorage.setItem(LS_KEY, JSON.stringify(prefsActuales));
      setPrefs({ ...prefsActuales });
    }
  }, [restaurantes]);

  const pedirPermiso = async () => {
    const resultado = await Notification.requestPermission();
    setPermiso(resultado);
  };

  const toggleRestaurante = (id) => {
    const nuevoValor = !prefs[id];
    setNotifPref(id, nuevoValor);
    setPrefs(prev => ({ ...prev, [id]: nuevoValor }));
  };

  const activarTodos = () => {
    const nuevas = {};
    restaurantes.forEach(r => { nuevas[r.id] = true; setNotifPref(r.id, true); });
    setPrefs(prev => ({ ...prev, ...nuevas }));
  };

  const desactivarTodos = () => {
    const nuevas = {};
    restaurantes.forEach(r => { nuevas[r.id] = false; setNotifPref(r.id, false); });
    setPrefs(prev => ({ ...prev, ...nuevas }));
  };

  const activados = restaurantes.filter(r => prefs[r.id] !== false).length;

  if (restaurantes.length === 0) return null;

  return (
    <div style={{ margin: '1rem 0' }}>

      {/* ── Botón para mostrar/ocultar ──────────────────────────────────── */}
      <button
        onClick={() => setVisible(v => !v)}
        style={{
          width: '100%', padding: '12px 16px',
          background: 'var(--surface, #f5f5f0)',
          border: '1px solid rgba(0,0,0,0.08)',
          borderRadius: 14, cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          fontSize: '0.88rem', fontWeight: 600,
          color: 'var(--text, #1a1a1a)',
        }}
      >
        <span>🔔 Notificaciones de cercanía</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{
            fontSize: '0.75rem', fontWeight: 700, padding: '2px 8px',
            background: activados > 0 ? '#E8563A' : '#ccc',
            color: 'white', borderRadius: 20,
          }}>
            {activados}/{restaurantes.length}
          </span>
          <span style={{ fontSize: '0.8rem', opacity: 0.5 }}>{visible ? '▲' : '▼'}</span>
        </span>
      </button>

      {/* ── Panel expandible ─────────────────────────────────────────────── */}
      {visible && (
        <div style={{
          marginTop: 8, padding: '16px',
          background: 'var(--surface, #f5f5f0)',
          border: '1px solid rgba(0,0,0,0.08)',
          borderRadius: 14,
        }}>

          {/* Permiso denegado */}
          {permiso === 'denied' && (
            <div style={{
              padding: '10px 14px', marginBottom: 12,
              background: '#fff3cd', borderRadius: 10,
              fontSize: '0.82rem', color: '#7d5900',
            }}>
              ⚠️ Las notificaciones están bloqueadas en tu navegador.
              Ve a <strong>Configuración → Permisos del sitio</strong> y actívalas para esta página.
            </div>
          )}

          {/* iPhone sin instalar: el permiso de notificaciones no funciona todavía.
              Mostramos las instrucciones de instalación en vez del botón, que
              en este estado no haría nada útil y confundiría al usuario. */}
          {iosNoInstalado && (
            <div style={{
              padding: '10px 14px', marginBottom: 12,
              background: '#fff3cd', borderRadius: 10,
              fontSize: '0.82rem', color: '#7d5900',
            }}>
              📲 En iPhone, primero agrega la app a tu pantalla de inicio
              (Compartir → Agregar a inicio) para poder activar las notificaciones.
            </div>
          )}

          {/* Pedir permiso si no se ha decidido — solo cuando sí puede funcionar */}
          {permiso === 'default' && !iosNoInstalado && (
            <div style={{ marginBottom: 12 }}>
              <p style={{ fontSize: '0.82rem', margin: '0 0 8px', opacity: 0.7 }}>
                Activa los permisos para recibir notificaciones cuando estés cerca.
              </p>
              <button
                onClick={pedirPermiso}
                style={{
                  padding: '9px 18px', background: '#E8563A', color: 'white',
                  border: 'none', borderRadius: 10, fontWeight: 700,
                  fontSize: '0.82rem', cursor: 'pointer', width: '100%',
                }}
              >
                🔔 Activar notificaciones
              </button>
            </div>
          )}

          {/* Descripción */}
          <p style={{ fontSize: '0.78rem', opacity: 0.6, margin: '0 0 12px' }}>
            Recibirás una notificación cuando estés cerca de los restaurantes seleccionados.
          </p>

          {/* Acciones rápidas */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <button onClick={activarTodos} style={{
              flex: 1, padding: '7px', background: 'rgba(232,86,58,0.1)',
              color: '#E8563A', border: '1px solid rgba(232,86,58,0.3)',
              borderRadius: 8, fontSize: '0.75rem', fontWeight: 600, cursor: 'pointer',
            }}>
              Activar todos
            </button>
            <button onClick={desactivarTodos} style={{
              flex: 1, padding: '7px', background: 'rgba(0,0,0,0.05)',
              color: 'var(--text-muted, #888)', border: '1px solid rgba(0,0,0,0.1)',
              borderRadius: 8, fontSize: '0.75rem', fontWeight: 600, cursor: 'pointer',
            }}>
              Desactivar todos
            </button>
          </div>

          {/* Lista de restaurantes con toggle */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {restaurantes.map(r => {
              const activo = prefs[r.id] !== false;
              return (
                <div
                  key={r.id}
                  onClick={() => permiso !== 'denied' && toggleRestaurante(r.id)}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '12px 14px',
                    background: activo ? 'rgba(232,86,58,0.06)' : 'rgba(0,0,0,0.03)',
                    border: `1px solid ${activo ? 'rgba(232,86,58,0.2)' : 'rgba(0,0,0,0.07)'}`,
                    borderRadius: 12, cursor: permiso !== 'denied' ? 'pointer' : 'default',
                    transition: 'all 0.15s',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ fontSize: '1.2rem' }}>🍽️</span>
                    <div>
                      <p style={{ margin: 0, fontWeight: 600, fontSize: '0.88rem' }}>{r.nombre}</p>
                      <p style={{ margin: 0, fontSize: '0.72rem', opacity: 0.5 }}>
                        {activo ? '📍 Te avisamos cuando estés cerca' : 'Notificaciones desactivadas'}
                      </p>
                    </div>
                  </div>

                  {/* Toggle switch */}
                  <div style={{
                    width: 44, height: 26, borderRadius: 13, position: 'relative',
                    background: activo ? '#E8563A' : '#ccc',
                    transition: 'background 0.2s', flexShrink: 0,
                  }}>
                    <div style={{
                      position: 'absolute', top: 3,
                      left: activo ? 21 : 3,
                      width: 20, height: 20, borderRadius: '50%',
                      background: 'white', boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
                      transition: 'left 0.2s',
                    }} />
                  </div>
                </div>
              );
            })}
          </div>

        </div>
      )}
    </div>
  );
}
