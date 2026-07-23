/**
 * CatalogoRecompensas.jsx
 * Muestra las recompensas configuradas por el admin para el restaurante.
 * Lee de la tabla `recompensas` de Supabase.
 * El cliente ve cuántos puntos le faltan para cada recompensa.
 */

import { useState, useEffect } from 'react';
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

function IconoRecompensa({ tipo }) {
  return <span style={{ fontSize: '1.4rem' }}>{ICONOS[tipo] ?? ICONOS.default}</span>;
}

export function CatalogoRecompensas({ restauranteId, puntosActuales = 0, onCanjear }) {
  const [recompensas, setRecompensas] = useState([]);
  const [cargando,    setCargando]    = useState(true);

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

      {/* Grid de recompensas */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        {recompensas.map(r => {
          const puntasFaltan = Math.max(0, r.puntos_requeridos - puntosActuales);
          const disponible   = puntasFaltan === 0;

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
                    Faltan {puntasFaltan.toLocaleString()}
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
// NOTA: la generación del código y el descuento de puntos ya NO se hacen aquí.
// Todo corre de forma atómica en la función RPC `canjear_recompensa`
// (ver 002_canje_rpc.sql), para que un fallo a mitad de camino no deje al
// cliente sin puntos y sin cupón.
export function ModalCanje({ recompensa, clienteId, puntosActuales, onExito, onCerrar }) {
  const [procesando, setProcesando]     = useState(false);
  const [cuponGenerado, setCuponGenerado] = useState(null); // { codigo, nombre, fecha_vencimiento }

  const confirmarCanje = async () => {
    if (!recompensa || procesando) return;
    setProcesando(true);
    try {
      const { data: cupon, error } = await supabase.rpc('canjear_recompensa', {
        p_cliente_id: clienteId,
        p_recompensa_id: recompensa.id,
      });
      if (error) throw error;

      setCuponGenerado(cupon);
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

  // IMPORTANTE: los puntos ya NO se descuentan aquí. Se descuentan en el panel
  // admin cuando el cajero confirma el código, así que la UI debe mostrar los
  // mismos puntos que tenía antes — no restar nada todavía.
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
                Muéstrale este código al mesero para reclamar tu {cuponGenerado.nombre}.
                Tus {recompensa.puntos_requeridos} pts se descuentan al confirmarlo en caja.
              </p>
            </div>

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
              padding: '12px 16px', marginBottom: 20, textAlign: 'center',
            }}>
              <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text)', opacity: 0.7 }}>
                Se descontarán al confirmar tu código en caja
              </p>
              <p style={{ margin: '4px 0 0', fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: '1.5rem', color: 'var(--coral)' }}>
                -{recompensa.puntos_requeridos} pts
              </p>
            </div>

            <button
              onClick={confirmarCanje}
              disabled={procesando}
              style={{
                width: '100%', padding: '14px',
                background: procesando ? 'var(--bg-subtle)' : 'var(--coral)',
                color: procesando ? 'var(--text)' : 'white',
                border: 'none', borderRadius: 14,
                fontWeight: 800, fontSize: '1rem', cursor: 'pointer',
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
