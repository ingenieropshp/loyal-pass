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

// ── Utilidad: código corto único para el cupón ────────────────────────────────
function generarCodigoCupon() {
  return Math.random().toString(36).slice(2, 7).toUpperCase();
}

// ── Modal de confirmación de canje ────────────────────────────────────────────
export function ModalCanje({ recompensa, clienteId, puntosActuales, onExito, onCerrar }) {
  const [procesando, setProcesando] = useState(false);

  const confirmarCanje = async () => {
    if (!recompensa || procesando) return;
    setProcesando(true);
    try {
      const nuevosPuntos = puntosActuales - recompensa.puntos_requeridos;

      // Descontar puntos del cliente
      const { error: errPuntos } = await supabase
        .from('clientes')
        .update({ puntos: nuevosPuntos })
        .eq('id', clienteId);
      if (errPuntos) throw errPuntos;

      // Registrar en historial
      await supabase.from('historial_puntos').insert([{
        cliente_id:     clienteId,
        tipo:           'canje',
        puntos:         -recompensa.puntos_requeridos,
        descripcion:    `Canjeó: ${recompensa.nombre}`,
        restaurante_id: recompensa.restaurante_id,
      }]);

      // Generar el cupón real: código único + vigencia (dias_vigencia de la
      // recompensa, o 7 días por defecto si el admin no lo configuró)
      const diasVigencia = recompensa.dias_vigencia || 7;
      const fechaVencimiento = new Date();
      fechaVencimiento.setDate(fechaVencimiento.getDate() + diasVigencia);

      const { error: errCupon } = await supabase.from('cupones').insert([{
        cliente_id:        clienteId,
        restaurante_id:    recompensa.restaurante_id,
        recompensa_id:     recompensa.id,
        nombre:            recompensa.nombre,
        codigo:            generarCodigoCupon(),
        estado:            'activo',
        fecha_vencimiento: fechaVencimiento.toISOString(),
      }]);
      if (errCupon) console.error('[ModalCanje] Error al crear el cupón:', errCupon);

      onExito?.(nuevosPuntos, recompensa);
    } catch {
      alert('Error al procesar el canje. Intenta de nuevo.');
    } finally {
      setProcesando(false);
    }
  };

  if (!recompensa) return null;

  return (
    <div style={{
      position:   'fixed', inset: 0, zIndex: 9999,
      background: 'rgba(0,0,0,0.55)',
      display:    'flex', alignItems: 'flex-end',
    }} onClick={e => e.target === e.currentTarget && onCerrar?.()}>
      <div style={{
        width: '100%', background: 'var(--bg-card)',
        borderRadius: '20px 20px 0 0', padding: '24px 20px 32px',
      }}>
        {/* Handle */}
        <div style={{ width: 36, height: 4, background: 'var(--border)', borderRadius: 2, margin: '0 auto 20px' }} />

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
            Se descontarán de tu cuenta
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
      </div>
    </div>
  );
}
