/**
 * CatalogoRecompensas.jsx
 * Muestra las recompensas configuradas por el admin para el restaurante.
 * Lee de la tabla `recompensas` de Supabase.
 * El cliente ve cuántos puntos le faltan para cada recompensa.
 *
 * CAMBIOS:
 * 1. La redención ahora consume la función RPC FIFO `fn_redimir_puntos`
 *    (antes: `canjear_recompensa`).
 * 2. Reglas mínimas de redención: no se puede redimir si el saldo del
 *    cliente es menor a 15.000 pts, ni si el valor en COP de la recompensa
 *    (campo `valor_cop`, ajusta el nombre si tu tabla lo llama distinto)
 *    es menor a $15.000 COP.
 * 3. Aviso visual: tras redimir, las compras del mismo día no acumulan
 *    puntos. El aviso se persiste con localStorage para el día en curso.
 */

import { useEffect, useState } from 'react';
import { supabase } from '../services/supabaseClient';

// ── Íconos por categoría ──────────────────────────────────────────────────────
const ICONOS = {
  bebida:    '☕',
  postre:    '🍰',
  descuento: '🎫',
  producto:  '🎁',
  premium:   '👑',
  default:   '🎁',
};

// ── Reglas mínimas de redención ───────────────────────────────────────────────
const MIN_PUNTOS_SALDO   = 15000; // saldo mínimo del cliente para poder redimir
const MIN_VALOR_COP_CANJE = 15000; // valor mínimo (COP) de la recompensa a redimir

// ── Aviso "no acumulas puntos hoy" — persistido por día en localStorage ──────
const LS_KEY_REDIMIDO_HOY = 'lp_redimido_hoy';

function hoyISO() {
  return new Date().toISOString().slice(0, 10);
}

function fueRedimidoHoy() {
  try {
    return localStorage.getItem(LS_KEY_REDIMIDO_HOY) === hoyISO();
  } catch {
    return false;
  }
}

function marcarRedimidoHoy() {
  try {
    localStorage.setItem(LS_KEY_REDIMIDO_HOY, hoyISO());
  } catch {
    /* localStorage no disponible, se omite el flag persistente */
  }
}

function IconoRecompensa({ tipo }) {
  return <span style={{ fontSize: '1.4rem' }}>{ICONOS[tipo] ?? ICONOS.default}</span>;
}

export function CatalogoRecompensas({ restauranteId, puntosActuales = 0, onCanjear }) {
  const [recompensas, setRecompensas] = useState([]);
  const [cargando,    setCargando]    = useState(true);
  const [redimidoHoy, setRedimidoHoy] = useState(fueRedimidoHoy());

  useEffect(() => {
    if (!restauranteId) return;
    supabase
      .from('recompensas')
      .select('*')
      .eq('restaurante_id', restauranteId)
      .eq('activo', true)
      .order('puntos_requeridos', { ascending: true })
      .then(({ data }) => {
        setRecompensas(data || []);
        setCargando(false);
      });
  }, [restauranteId]);

  // Escucha el evento disparado por ModalCanje cuando una redención se confirma,
  // para reflejar el aviso "no acumulas puntos hoy" sin recargar la pantalla.
  useEffect(() => {
    const onRedimido = () => setRedimidoHoy(true);
    window.addEventListener('lp:canje-confirmado', onRedimido);
    return () => window.removeEventListener('lp:canje-confirmado', onRedimido);
  }, []);

  if (cargando) return null;
  if (recompensas.length === 0) return null;

  return (
    <div style={{ marginBottom: 20 }}>
      {/* Cabecera */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <p style={{
          margin: 0, fontFamily: 'var(--font-display)',
          fontWeight: 700, fontSize: '1rem', color: 'var(--text-h)',
        }}>
          Recompensas
        </p>
        <span style={{ fontSize: '0.72rem', color: 'var(--text)', opacity: 0.55 }}>
          Canjea con tus puntos
        </span>
      </div>

      {/* Aviso: no se acumulan puntos hoy tras una redención */}
      {redimidoHoy && (
        <div style={{
          background:   'var(--bg-subtle)',
          border:       '1px solid var(--border)',
          borderRadius: 12,
          padding:      '10px 12px',
          marginBottom: 12,
          fontSize:     '0.75rem',
          color:        'var(--text)',
          display:      'flex',
          alignItems:   'center',
          gap:          8,
        }}>
          <span>⚠️</span>
          <span>Ya redimiste puntos hoy: las compras de hoy no acumularán puntos nuevos.</span>
        </div>
      )}

      {/* Grid de recompensas */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        {recompensas.map(r => {
          const puntasFaltan     = Math.max(0, r.puntos_requeridos - puntosActuales);
          const tienePuntos      = puntasFaltan === 0;
          const cumpleMinSaldo   = puntosActuales >= MIN_PUNTOS_SALDO;
          const cumpleMinValor   = (r.valor_cop ?? 0) >= MIN_VALOR_COP_CANJE;
          const disponible       = tienePuntos && cumpleMinSaldo && cumpleMinValor;

          // Motivo de bloqueo, para mostrar un mensaje útil en vez de un simple "Faltan X"
          let motivoBloqueo = null;
          if (!tienePuntos) {
            motivoBloqueo = `Faltan ${puntasFaltan.toLocaleString()}`;
          } else if (!cumpleMinSaldo) {
            motivoBloqueo = `Mínimo ${MIN_PUNTOS_SALDO.toLocaleString()} pts en tu cuenta`;
          } else if (!cumpleMinValor) {
            motivoBloqueo = `Este canje no alcanza el mínimo de $${MIN_VALOR_COP_CANJE.toLocaleString()} COP`;
          }

          return (
            <div
              key={r.id}
              onClick={() => disponible && onCanjear?.(r)}
              style={{
                padding:       '14px 12px',
                borderRadius:  14,
                border:        `1.5px solid ${disponible ? 'rgba(29,158,117,0.35)' : 'var(--border)'}`,
                background:    disponible ? 'var(--green-light)' : 'var(--bg-subtle)',
                cursor:        disponible ? 'pointer' : 'default',
                transition:    'all 0.2s',
                position:      'relative',
                overflow:      'hidden',
              }}
            >
              {/* Badge "Disponible" */}
              {disponible && (
                <div style={{
                  position:   'absolute', top: 8, right: 8,
                  background: 'var(--green)', color: 'white',
                  fontSize:   '0.6rem', fontWeight: 700,
                  padding:    '2px 7px', borderRadius: 99,
                  letterSpacing: '0.04em',
                }}>
                  ¡Disponible!
                </div>
              )}

              <IconoRecompensa tipo={r.tipo} />

              <p style={{
                margin:     '6px 0 2px',
                fontWeight: 700, fontSize: '0.85rem',
                color:      'var(--text-h)',
                lineHeight: 1.2,
              }}>
                {r.nombre}
              </p>

              <p style={{ margin: 0, fontSize: '0.72rem', color: 'var(--text)', opacity: 0.6 }}>
                {r.puntos_requeridos.toLocaleString()} puntos
              </p>

              {/* Estado */}
              <div style={{ marginTop: 8 }}>
                {disponible ? (
                  <span style={{
                    fontSize: '0.72rem', fontWeight: 700,
                    color: 'var(--green)',
                  }}>
                    ✓ Toca para canjear
                  </span>
                ) : (
                  <span style={{
                    display:    'inline-block',
                    background: 'var(--border)',
                    color:      'var(--text)',
                    fontSize:   '0.7rem', fontWeight: 600,
                    padding:    '3px 8px', borderRadius: 8,
                    opacity: 0.8,
                  }}>
                    {motivoBloqueo}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Modal de confirmación de canje ────────────────────────────────────────────
// NOTA: la redención corre de forma atómica en la función RPC FIFO
// `fn_redimir_puntos(p_user_id, p_puntos_redimir)`. Esta función se encarga
// de descontar los puntos más antiguos primero (FIFO) del saldo vigente del
// cliente. Ajusta el nombre de los campos del objeto retornado (`data`) según
// lo que tu función realmente devuelva — aquí se asume que puede incluir un
// código de cupón (`codigo`) y una fecha de vencimiento opcional.
export function ModalCanje({ recompensa, clienteId, puntosActuales, onExito, onCerrar }) {
  const [procesando, setProcesando]       = useState(false);
  const [cuponGenerado, setCuponGenerado] = useState(null);

  const puntasFaltan   = recompensa ? Math.max(0, recompensa.puntos_requeridos - puntosActuales) : 0;
  const cumpleMinSaldo = puntosActuales >= MIN_PUNTOS_SALDO;
  const cumpleMinValor = recompensa ? (recompensa.valor_cop ?? 0) >= MIN_VALOR_COP_CANJE : false;
  const puedeRedimir   = recompensa && puntasFaltan === 0 && cumpleMinSaldo && cumpleMinValor;

  const confirmarCanje = async () => {
    if (!recompensa || procesando || !puedeRedimir) return;
    setProcesando(true);
    try {
      const { data, error } = await supabase.rpc('fn_redimir_puntos', {
        p_user_id:        clienteId,
        p_puntos_redimir: recompensa.puntos_requeridos,
      });
      if (error) throw error;

      setCuponGenerado(data);
      marcarRedimidoHoy();
      window.dispatchEvent(new Event('lp:canje-confirmado'));
    } catch (err) {
      const legibles = {
        PUNTOS_INSUFICIENTES:     'No tienes suficientes puntos para este premio.',
        RECOMPENSA_NO_DISPONIBLE: 'Este premio ya no está disponible.',
        CLIENTE_NO_ENCONTRADO:    'No se pudo identificar tu cuenta.',
      };
      alert(legibles[err.message] || 'Error al procesar el canje. Intenta de nuevo.');
    } finally {
      setProcesando(false);
    }
  };

  const cerrarConExito = () => {
    onExito?.(puntosActuales, recompensa, cuponGenerado);
  };

  if (!recompensa) return null;

  return (
    <div style={{
      position:   'fixed', inset: 0, zIndex: 9999,
      background: 'rgba(0,0,0,0.55)',
      display:    'flex', alignItems: 'flex-end',
    }} onClick={e => e.target === e.currentTarget && (cuponGenerado ? cerrarConExito() : onCerrar?.())}>
      <div style={{
        width: '100%', background: 'var(--bg-card)',
        borderRadius: '20px 20px 0 0', padding: '24px 20px 32px',
      }}>
        {/* Handle */}
        <div style={{ width: 36, height: 4, background: 'var(--border)', borderRadius: 2, margin: '0 auto 20px' }} />

        {cuponGenerado ? (
          <>
            <div style={{ textAlign: 'center', marginBottom: 20 }}>
              <span style={{ fontSize: '3rem' }}>✅</span>
              <h3 style={{ margin: '10px 0 4px', fontFamily: 'var(--font-display)', fontWeight: 800 }}>
                ¡Canje confirmado!
              </h3>
              <p style={{ margin: 0, color: 'var(--text)', opacity: 0.6, fontSize: '0.85rem' }}>
                {cuponGenerado.codigo
                  ? `Muéstrale este código al mesero para reclamar tu ${recompensa.nombre}.`
                  : `Tu canje de ${recompensa.nombre} quedó registrado.`}
              </p>
            </div>

            {cuponGenerado.codigo && (
              <div style={{
                background: 'var(--bg-subtle)', borderRadius: 12,
                padding: '18px 16px', marginBottom: 20, textAlign: 'center',
              }}>
                <p style={{ margin: 0, fontSize: '0.75rem', color: 'var(--text)', opacity: 0.6, letterSpacing: '0.05em', textTransform: 'uppercase' }}>
                  Código de canje
                </p>
                <p style={{
                  margin: '6px 0 0', fontFamily: 'var(--font-display)', fontWeight: 800,
                  fontSize: '2.2rem', letterSpacing: '0.15em', color: 'var(--coral)',
                }}>
                  {cuponGenerado.codigo}
                </p>
                {cuponGenerado.fecha_vencimiento && (
                  <p style={{ margin: '6px 0 0', fontSize: '0.75rem', color: 'var(--text)', opacity: 0.5 }}>
                    Válido hasta {new Date(cuponGenerado.fecha_vencimiento).toLocaleDateString('es-CO', {
                      day: '2-digit', month: 'short', year: 'numeric',
                    })}
                  </p>
                )}
              </div>
            )}

            {/* Aviso: no acumula puntos hoy */}
            <div style={{
              background: 'var(--bg-subtle)', border: '1px solid var(--border)',
              borderRadius: 12, padding: '10px 12px', marginBottom: 20,
              fontSize: '0.75rem', color: 'var(--text)', display: 'flex', gap: 8, alignItems: 'center',
            }}>
              <span>⚠️</span>
              <span>Las compras que hagas hoy no acumularán puntos, ya que realizaste una redención.</span>
            </div>

            <button
              onClick={cerrarConExito}
              style={{
                width: '100%', padding: '14px',
                background: 'var(--coral)', color: 'white',
                border: 'none', borderRadius: 14,
                fontWeight: 800, fontSize: '1rem', cursor: 'pointer',
              }}
            >
              Listo
            </button>
          </>
        ) : (
          <>
            <div style={{ textAlign: 'center', marginBottom: 20 }}>
              <span style={{ fontSize: '3rem' }}>{ICONOS[recompensa.tipo] ?? ICONOS.default}</span>
              <h3 style={{ margin: '10px 0 4px', fontFamily: 'var(--font-display)', fontWeight: 800 }}>
                {recompensa.nombre}
              </h3>
              <p style={{ margin: 0, color: 'var(--text)', opacity: 0.6, fontSize: '0.85rem' }}>
                {recompensa.descripcion || 'Muestra este canje al mesero para reclamarlo.'}
              </p>
            </div>

            <div style={{
              background: 'var(--bg-subtle)', borderRadius: 12,
              padding: '12px 16px', marginBottom: 12, textAlign: 'center',
            }}>
              <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text)', opacity: 0.7 }}>
                Se descontarán de tu saldo vigente al confirmar
              </p>
              <p style={{ margin: '4px 0 0', fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: '1.5rem', color: 'var(--coral)' }}>
                -{recompensa.puntos_requeridos} pts
              </p>
            </div>

            {/* Validaciones visuales de mínimos */}
            {!cumpleMinSaldo && (
              <p style={{ margin: '0 0 10px', fontSize: '0.78rem', color: 'var(--coral)', textAlign: 'center' }}>
                Necesitas al menos {MIN_PUNTOS_SALDO.toLocaleString()} pts en tu cuenta para redimir.
              </p>
            )}
            {cumpleMinSaldo && !cumpleMinValor && (
              <p style={{ margin: '0 0 10px', fontSize: '0.78rem', color: 'var(--coral)', textAlign: 'center' }}>
                Este premio no alcanza el mínimo de ${MIN_VALOR_COP_CANJE.toLocaleString()} COP para redimir.
              </p>
            )}

            <p style={{ margin: '0 0 16px', fontSize: '0.72rem', color: 'var(--text)', opacity: 0.6, textAlign: 'center' }}>
              ⚠️ Si redimes hoy, tus compras de hoy no acumularán puntos nuevos.
            </p>

            <button
              onClick={confirmarCanje}
              disabled={procesando || !puedeRedimir}
              style={{
                width: '100%', padding: '14px',
                background: (procesando || !puedeRedimir) ? 'var(--bg-subtle)' : 'var(--coral)',
                color: (procesando || !puedeRedimir) ? 'var(--text)' : 'white',
                border: 'none', borderRadius: 14,
                fontWeight: 800, fontSize: '1rem', cursor: (procesando || !puedeRedimir) ? 'not-allowed' : 'pointer',
                marginBottom: 10,
              }}
            >
              {procesando ? 'Procesando…' : '✅ Confirmar canje'}
            </button>
            <button
              onClick={onCerrar}
              style={{
                width: '100%', padding: '12px',
                background: 'transparent', border: '1px solid var(--border)',
                borderRadius: 14, fontWeight: 600, fontSize: '0.9rem',
                cursor: 'pointer', color: 'var(--text)',
              }}
            >
              Cancelar
            </button>
          </>
        )}
      </div>
    </div>
  );
}
