/**
 * CatalogoRecompensas.jsx
 * Pantalla "Recompensas" del cliente — reemplaza el mensaje temporal
 * "Estamos preparando esta sección" (ver App.jsx, pestaña 'recompensas').
 * Lee en tiempo real de la tabla `recompensas` de Supabase y permite
 * canjear con el saldo de puntos vigente del cliente.
 *
 * ── HISTORIA (por qué este archivo cambió) ──────────────────────────────────
 * Ya existía una versión de este componente, pero llamaba a una función RPC
 * rota (`fn_redimir_puntos`) que:
 *   1. Insertaba en `transacciones_puntos` usando columnas que no existen
 *      (`monto_factura`, `detalles`) y omitía `restaurante_id` (NOT NULL) —
 *      cualquier canje fallaba con un error de Postgres.
 *   2. No generaba ningún código de 6 dígitos para mostrarle al cajero — era
 *      un descuento directo, no el flujo "solicitar código → cajero valida"
 *      que pide este diseño.
 * También validaba un mínimo de saldo (15.000 pts) y un "valor COP mínimo
 * por canje" contra una columna `valor_cop` que no existe en `recompensas` —
 * ninguna de esas dos reglas está en las reglas de negocio reales del
 * proyecto, así que se quitaron: la única condición para canjear es tener
 * saldo_puntos >= puntos_requeridos de la recompensa, tal como se pidió.
 *
 * Ahora usa `canjear_recompensa` (RPC, SECURITY DEFINER) — ya arreglada
 * para leer `clientes.saldo_puntos` (antes apuntaba a una columna `puntos`
 * que ya no existe) — que valida el saldo y crea el cupón pendiente con su
 * código de 6 dígitos. El descuento REAL de puntos ocurre después, cuando
 * el cajero confirma en caja con `quemar_cupon` (ver ValidadorCupones.jsx
 * en bistro-admin) — ese es el paso que efectivamente escribe en el Ledger
 * (`transacciones_puntos`, tipo 'canje_recompensa'). Este archivo nunca
 * toca el Ledger directamente.
 */

import { useEffect, useState } from 'react';
import { supabase } from '../services/supabaseClient';

// ── Íconos por categoría (columna `recompensas.tipo`) ────────────────────────
const ICONOS = {
  bebida:    '☕',
  postre:    '🍰',
  descuento: '🎫',
  producto:  '🎁',
  premium:   '👑',
  default:   '🎁',
};

function IconoRecompensa({ tipo }) {
  return <span style={{ fontSize: '2rem', lineHeight: 1 }}>{ICONOS[tipo] ?? ICONOS.default}</span>;
}

export function CatalogoRecompensas({ restauranteId, clienteId, puntosActuales = 0 }) {
  const [recompensas, setRecompensas] = useState([]);
  const [cargando,    setCargando]    = useState(true);
  const [seleccionada, setSeleccionada] = useState(null); // recompensa elegida → abre el modal

  useEffect(() => {
    if (!restauranteId) return;

    supabase
      .from('recompensas')
      .select('*')
      .eq('restaurante_id', restauranteId)
      .eq('activo', true)
      .order('puntos_requeridos', { ascending: true })
      .then(({ data, error }) => {
        if (error) {
          console.error('[CatalogoRecompensas] No se pudieron cargar las recompensas:', error.message);
          setRecompensas([]);
        } else {
          setRecompensas(data || []);
        }
        setCargando(false);
      })
      .catch((err) => {
        console.error('[CatalogoRecompensas] Error inesperado cargando recompensas:', err?.message || err);
        setRecompensas([]);
        setCargando(false);
      });

    // Tiempo real: si el admin activa/desactiva o edita una recompensa
    // (o crea una nueva) mientras el cliente tiene la pantalla abierta, el
    // catálogo se actualiza solo, sin recargar la app.
    const canal = supabase
      .channel(`recompensas-cliente-${restauranteId}`)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'recompensas', filter: `restaurante_id=eq.${restauranteId}` },
        (payload) => {
          setRecompensas(prev => {
            const fila = payload.new && Object.keys(payload.new).length ? payload.new : payload.old;
            if (payload.eventType === 'DELETE' || fila.activo === false) {
              return prev.filter(r => r.id !== fila.id);
            }
            const yaEsta = prev.some(r => r.id === fila.id);
            const siguiente = yaEsta
              ? prev.map(r => r.id === fila.id ? fila : r)
              : [...prev, fila];
            return siguiente.sort((a, b) => a.puntos_requeridos - b.puntos_requeridos);
          });
        }
      )
      .subscribe();

    return () => supabase.removeChannel(canal);
  }, [restauranteId]);

  if (cargando) {
    return (
      <p style={{ textAlign: 'center', fontSize: '0.85rem', color: 'var(--text)', opacity: 0.6, padding: '2rem 0' }}>
        Cargando recompensas…
      </p>
    );
  }

  if (recompensas.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '2.5rem 1rem' }}>
        <p style={{ fontSize: '2rem', margin: '0 0 10px' }}>🎁</p>
        <p style={{ margin: 0, fontSize: '0.9rem', fontWeight: 600, color: 'var(--text-h)' }}>
          Aún no hay recompensas disponibles
        </p>
        <p style={{ margin: '4px 0 0', fontSize: '0.8rem', color: 'var(--text)', opacity: 0.6 }}>
          Vuelve pronto — tu restaurante todavía está armando su catálogo.
        </p>
      </div>
    );
  }

  return (
    <div style={{ padding: '1rem 0.25rem 2rem' }}>
      <p style={{
        margin: '0 0 4px', fontFamily: 'var(--font-display)',
        fontWeight: 700, fontSize: '1.1rem', color: 'var(--luxury-gold, #D4AF37)',
      }}>
        🎁 Recompensas
      </p>
      <p style={{ margin: '0 0 16px', fontSize: '0.8rem', color: 'var(--luxury-cream, #F5F5DC)', opacity: 0.7 }}>
        Canjea tus puntos por premios reales en el local.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        {recompensas.map(r => {
          const faltan     = Math.max(0, r.puntos_requeridos - puntosActuales);
          const disponible = faltan === 0;

          return (
            <div
              key={r.id}
              onClick={() => disponible && setSeleccionada(r)}
              style={{
                padding:      '16px 14px',
                borderRadius: 16,
                background:   'var(--bg-card, #1E1E1E)',
                border:       `1px solid ${disponible ? 'rgba(212,175,55,0.55)' : 'var(--luxury-bronze, #4A3B2C)'}`,
                boxShadow:    disponible ? '0 0 0 1px rgba(212,175,55,0.15), 0 6px 16px rgba(212,175,55,0.12)' : 'none',
                cursor:       disponible ? 'pointer' : 'default',
                display:      'flex',
                flexDirection: 'column',
                gap: 6,
              }}
            >
              <IconoRecompensa tipo={r.tipo} />

              <p style={{
                margin: '2px 0 0', fontWeight: 700, fontSize: '0.9rem',
                color: 'var(--luxury-cream, #F5F5DC)', lineHeight: 1.25,
              }}>
                {r.nombre}
              </p>

              {r.descripcion && (
                <p style={{ margin: 0, fontSize: '0.72rem', color: 'var(--luxury-cream, #F5F5DC)', opacity: 0.55 }}>
                  {r.descripcion}
                </p>
              )}

              <p style={{ margin: '4px 0 0', fontSize: '0.75rem', color: 'var(--luxury-cream, #F5F5DC)', opacity: 0.6 }}>
                {r.puntos_requeridos.toLocaleString('es-CO')} pts
              </p>

              {/* Botón de estado — solo visual, el click real es en toda la tarjeta */}
              <div style={{ marginTop: 8 }}>
                {disponible ? (
                  <span style={{
                    display: 'block', textAlign: 'center',
                    padding: '9px 10px', borderRadius: 10,
                    background: 'var(--gold-gradient, linear-gradient(135deg, #CA8A04 0%, #F5C451 45%, #EAB308 100%))',
                    color: '#241A04', fontWeight: 800, fontSize: '0.78rem',
                    textShadow: '0 1px 0 rgba(255,255,255,0.35)',
                  }}>
                    Canjear por {r.puntos_requeridos.toLocaleString('es-CO')} pts
                  </span>
                ) : (
                  <span style={{
                    display: 'block', textAlign: 'center',
                    padding: '9px 10px', borderRadius: 10,
                    background: 'rgba(255,255,255,0.06)',
                    color: '#9A9A9A', fontWeight: 700, fontSize: '0.78rem',
                  }}>
                    Te faltan {faltan.toLocaleString('es-CO')} pts
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <ModalCanje
        recompensa={seleccionada}
        clienteId={clienteId}
        onCerrar={() => setSeleccionada(null)}
      />
    </div>
  );
}

// ── Modal de canje: genera el código de 6 dígitos vía canjear_recompensa ────
function ModalCanje({ recompensa, clienteId, onCerrar }) {
  const [procesando, setProcesando] = useState(false);
  const [cupon,       setCupon]     = useState(null);
  const [errorMsg,    setErrorMsg]  = useState(null);

  // Se resetea cada vez que se abre con una recompensa distinta.
  useEffect(() => {
    setCupon(null);
    setErrorMsg(null);
  }, [recompensa?.id]);

  if (!recompensa) return null;

  const confirmarCanje = async () => {
    setProcesando(true);
    setErrorMsg(null);
    try {
      const { data, error } = await supabase.rpc('canjear_recompensa', {
        p_cliente_id:    clienteId,
        p_recompensa_id: recompensa.id,
      });
      if (error) throw error;
      setCupon(data);
    } catch (err) {
      const legibles = {
        PUNTOS_INSUFICIENTES:       'No tienes suficientes puntos para este premio.',
        RECOMPENSA_NO_DISPONIBLE:   'Este premio ya no está disponible.',
        CLIENTE_NO_ENCONTRADO:      'No se pudo identificar tu cuenta.',
        RECOMPENSA_DE_OTRO_RESTAURANTE: 'Este premio no pertenece a este restaurante.',
      };
      setErrorMsg(legibles[err.message] || 'No se pudo generar el código. Intenta de nuevo.');
    } finally {
      setProcesando(false);
    }
  };

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'flex-end' }}
      onClick={(e) => e.target === e.currentTarget && onCerrar()}
    >
      <div style={{
        width: '100%', background: 'var(--luxury-charcoal, #1E1E1E)',
        borderRadius: '20px 20px 0 0', padding: '24px 20px 32px',
        border: '1px solid rgba(212,175,55,0.3)', borderBottom: 'none',
      }}>
        <div style={{ width: 36, height: 4, background: 'rgba(212,175,55,0.35)', borderRadius: 2, margin: '0 auto 20px' }} />

        {cupon ? (
          <>
            <div style={{ textAlign: 'center', marginBottom: 18 }}>
              <span style={{ fontSize: '2.4rem' }}>{ICONOS[recompensa.tipo] ?? ICONOS.default}</span>
              <h3 style={{ margin: '10px 0 4px', fontFamily: 'var(--font-display)', fontWeight: 800, color: '#FFFFFF' }}>
                ¡Canje confirmado!
              </h3>
              <p style={{ margin: 0, color: 'var(--luxury-cream, #F5F5DC)', opacity: 0.7, fontSize: '0.85rem' }}>
                Muéstrale este código al cajero para reclamar tu {recompensa.nombre}.
              </p>
            </div>

            <div style={{
              background: 'var(--charcoal-mate, #1A1A1A)', borderRadius: 14,
              padding: '20px 16px', marginBottom: 18, textAlign: 'center',
              border: '1px solid rgba(212,175,55,0.35)',
            }}>
              <p style={{ margin: 0, fontSize: '0.7rem', color: '#FFFFFF', opacity: 0.55, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                Código de canje
              </p>
              <p style={{
                margin: '8px 0 0', fontFamily: 'var(--font-display)', fontWeight: 800,
                fontSize: '2.6rem', letterSpacing: '0.18em', color: '#D4AF37',
              }}>
                {cupon.codigo}
              </p>
              {cupon.fecha_vencimiento && (
                <p style={{ margin: '8px 0 0', fontSize: '0.72rem', color: '#FFFFFF', opacity: 0.5 }}>
                  Válido hasta {new Date(cupon.fecha_vencimiento).toLocaleDateString('es-CO', {
                    day: '2-digit', month: 'short', year: 'numeric',
                  })}
                </p>
              )}
            </div>

            <button
              onClick={onCerrar}
              style={{
                width: '100%', padding: '14px',
                background: 'var(--gold-gradient, linear-gradient(135deg, #CA8A04 0%, #F5C451 45%, #EAB308 100%))',
                color: '#241A04', border: 'none', borderRadius: 14,
                fontWeight: 800, fontSize: '1rem', cursor: 'pointer',
              }}
            >
              Listo
            </button>
          </>
        ) : (
          <>
            <div style={{ textAlign: 'center', marginBottom: 18 }}>
              <span style={{ fontSize: '2.4rem' }}>{ICONOS[recompensa.tipo] ?? ICONOS.default}</span>
              <h3 style={{ margin: '10px 0 4px', fontFamily: 'var(--font-display)', fontWeight: 800, color: '#FFFFFF' }}>
                {recompensa.nombre}
              </h3>
              {recompensa.descripcion && (
                <p style={{ margin: 0, color: 'var(--luxury-cream, #F5F5DC)', opacity: 0.65, fontSize: '0.85rem' }}>
                  {recompensa.descripcion}
                </p>
              )}
            </div>

            <div style={{
              background: 'var(--charcoal-mate, #1A1A1A)', borderRadius: 14,
              padding: '14px 16px', marginBottom: 14, textAlign: 'center',
              border: '1px solid rgba(212,175,55,0.25)',
            }}>
              <p style={{ margin: 0, fontSize: '0.78rem', color: '#FFFFFF', opacity: 0.65 }}>
                Se descontarán de tu saldo al confirmar en caja
              </p>
              <p style={{ margin: '4px 0 0', fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: '1.4rem', color: '#D4AF37' }}>
                -{recompensa.puntos_requeridos.toLocaleString('es-CO')} pts
              </p>
            </div>

            {errorMsg && (
              <p style={{ margin: '0 0 14px', fontSize: '0.78rem', color: '#E5484D', textAlign: 'center' }}>
                {errorMsg}
              </p>
            )}

            <button
              onClick={confirmarCanje}
              disabled={procesando}
              style={{
                width: '100%', padding: '14px',
                background: procesando
                  ? 'rgba(255,255,255,0.08)'
                  : 'var(--gold-gradient, linear-gradient(135deg, #CA8A04 0%, #F5C451 45%, #EAB308 100%))',
                color: procesando ? '#9A9A9A' : '#241A04',
                border: 'none', borderRadius: 14,
                fontWeight: 800, fontSize: '1rem',
                cursor: procesando ? 'not-allowed' : 'pointer',
                marginBottom: 10,
              }}
            >
              {procesando ? 'Generando código…' : '✅ Confirmar canje'}
            </button>
            <button
              onClick={onCerrar}
              style={{
                width: '100%', padding: '12px',
                background: 'transparent', border: '1px solid rgba(212,175,55,0.25)',
                borderRadius: 14, fontWeight: 600, fontSize: '0.9rem',
                cursor: 'pointer', color: '#FFFFFF',
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
