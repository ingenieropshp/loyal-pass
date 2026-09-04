import { useState } from 'react';
import { supabase } from '../services/supabaseClient';

const MIN_PUNTOS = 15000;

/**
 * RedimirPuntosModal
 * ────────────────────────────────────────────────────────────────────────
 * Permite al cliente redimir un MONTO LIBRE de puntos (no un premio fijo
 * del catálogo) para pagar parcial o totalmente su cuenta en caja.
 *
 * Usa la función RPC `fn_redimir_puntos_libre` (ver sql/fn_redimir_puntos_libre.sql)
 * para que la verificación de saldo y el descuento corran de forma atómica
 * en el servidor — igual que `fn_redimir_puntos` para el catálogo. Así el
 * monto redimido nunca se confía a ciegas desde el navegador.
 */
export default function RedimirPuntosModal({
  isOpen,
  onClose,
  cliente,        // objeto cliente ya cargado: { id, restaurante_id, nombre, puntos, cedula }
  restauranteId,  // sede activa — necesario para no tocar otras sedes del mismo cliente
  onRedencionExitosa,
}) {
  const [montoARedimir, setMontoARedimir] = useState('');
  const [loading, setLoading]             = useState(false);
  const [error, setError]                 = useState(null);
  const [exito, setExito]                 = useState(false);

  if (!isOpen) return null;

  const saldoActual = cliente?.puntos || 0;

  const handleRedencion = async (e) => {
    e.preventDefault();
    setError(null);
    const puntosRedimir = parseInt(montoARedimir, 10);

    // ── Validaciones ────────────────────────────────────────────────────
    if (isNaN(puntosRedimir)) {
      setError('Por favor, ingresa un número válido.');
      return;
    }
    if (saldoActual < MIN_PUNTOS) {
      setError(`Tu saldo actual (${saldoActual.toLocaleString()} pts) es inferior al mínimo de ${MIN_PUNTOS.toLocaleString()} pts requerido para redimir.`);
      return;
    }
    if (puntosRedimir < MIN_PUNTOS) {
      setError(`El monto mínimo por transacción es de ${MIN_PUNTOS.toLocaleString()} puntos ($${MIN_PUNTOS.toLocaleString()} COP).`);
      return;
    }
    if (puntosRedimir > saldoActual) {
      setError(`No tienes suficientes puntos. Tu saldo actual es de ${saldoActual.toLocaleString()} pts.`);
      return;
    }

    setLoading(true);
    try {
      // ── 1-4. Todo corre atómico y validado en el servidor vía RPC:
      //       verifica saldo, descuenta, inserta historial y redención.
      //       Ver sql/fn_redimir_puntos_libre.sql — así el monto nunca se
      //       confía a ciegas desde el cliente (DevTools no puede alterarlo). ──
      const { data, error: rpcError } = await supabase.rpc('fn_redimir_puntos_libre', {
        p_cliente_id:     cliente.id,
        p_restaurante_id: restauranteId,
        p_puntos_redimir: puntosRedimir,
      });
      if (rpcError) throw rpcError;

      const fila = Array.isArray(data) ? data[0] : data;
      const nuevoSaldo   = fila.nuevo_saldo;
      const codigoUnico  = fila.codigo_cupon;

      // ── 5. Notificación en tiempo real a la caja — se espera la
      //       confirmación de suscripción antes de enviar, y se incluye
      //       restaurante_id para que cada sede filtre solo lo suyo si
      //       varios restaurantes comparten el mismo proyecto Supabase ──
      const canalCaja = supabase.channel(`notificaciones_caja_${restauranteId}`);
      await new Promise((resolve) => {
        canalCaja.subscribe((status) => {
          if (status === 'SUBSCRIBED') {
            canalCaja.send({
              type: 'broadcast',
              event: 'nueva_redencion',
              payload: {
                cliente_id:       cliente.id,
                restaurante_id:   restauranteId,
                nombre:           cliente.nombre,
                cedula:           cliente.cedula,
                puntos_redimidos: puntosRedimir,
                codigo:           codigoUnico,
                valor_cop:        puntosRedimir,
                fecha:            new Date().toISOString(),
              },
            }).then(() => {
              supabase.removeChannel(canalCaja);
              resolve();
            });
          }
        });
      });

      // ── 6. Exclusión de acumulación hoy ─────────────────────────────────
      localStorage.setItem('lp_redimido_hoy', new Date().toISOString().slice(0, 10));

      setExito(true);
      onRedencionExitosa?.(nuevoSaldo);
    } catch (err) {
      console.error('[RedimirPuntosModal]', err);
      const legibles = {
        MONTO_MINIMO_NO_ALCANZADO: `El monto mínimo por transacción es de ${MIN_PUNTOS.toLocaleString()} puntos.`,
        SALDO_INSUFICIENTE_MINIMO: 'Tu saldo bajó del mínimo requerido para redimir.',
        PUNTOS_INSUFICIENTES:      'No tienes suficientes puntos para ese monto.',
        CLIENTE_NO_ENCONTRADO:     'No se pudo identificar tu cuenta en esta sede.',
      };
      setError(legibles[err.message] || 'Ocurrió un error al procesar la redención. Inténtalo de nuevo.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      background: 'rgba(0,0,0,0.55)',
      display: 'flex', alignItems: 'flex-end',
    }} onClick={(e) => e.target === e.currentTarget && onClose?.()}>
      <div style={{
        width: '100%', background: 'var(--bg-card)',
        borderRadius: '20px 20px 0 0', padding: '24px 20px 32px',
      }}>
        <div style={{ width: 36, height: 4, background: 'var(--border)', borderRadius: 2, margin: '0 auto 20px' }} />

        {!exito ? (
          <>
            <h2 style={{ margin: '0 0 6px', fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: '1.2rem', color: 'var(--text-h)' }}>
              Redimir puntos para pagar
            </h2>
            <p style={{ margin: '0 0 16px', fontSize: '0.85rem', color: 'var(--text)', opacity: 0.7 }}>
              Cada punto equivale a $1 COP. Puedes pagar el total o una parte de tu cuenta.
            </p>

            <div style={{ background: 'var(--coral-light)', border: '1px solid var(--coral-border)', borderRadius: 14, padding: 14, marginBottom: 16 }}>
              <span style={{ fontSize: '0.7rem', color: 'var(--coral)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                Tu saldo disponible
              </span>
              <div style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: '1.6rem', color: 'var(--coral)' }}>
                {saldoActual.toLocaleString()} pts
              </div>
              <span style={{ fontSize: '0.78rem', color: 'var(--coral)', opacity: 0.8 }}>
                (= ${saldoActual.toLocaleString()} COP)
              </span>
            </div>

            <form onSubmit={handleRedencion}>
              <label style={{ display: 'block', fontSize: '0.82rem', fontWeight: 600, marginBottom: 6, color: 'var(--text-h)' }}>
                ¿Cuántos puntos deseas usar hoy?
              </label>
              <input
                type="number"
                value={montoARedimir}
                onChange={(e) => setMontoARedimir(e.target.value)}
                placeholder={`Mínimo ${MIN_PUNTOS.toLocaleString()}`}
                disabled={loading}
                style={{
                  width: '100%', padding: '12px 14px', borderRadius: 12,
                  border: '1px solid var(--border-mid)', fontSize: '1rem', marginBottom: 4,
                }}
              />
              <p style={{ margin: '0 0 14px', fontSize: '0.72rem', color: 'var(--text)', opacity: 0.55 }}>
                Regla: mínimo {MIN_PUNTOS.toLocaleString()} puntos por transacción.
              </p>

              {error && (
                <div style={{ background: '#FEF2F2', color: '#B91C1C', fontSize: '0.78rem', padding: '10px 12px', borderRadius: 12, marginBottom: 14, border: '1px solid #FECACA' }}>
                  ⚠️ {error}
                </div>
              )}

              <div style={{ display: 'flex', gap: 10 }}>
                <button
                  type="button"
                  onClick={onClose}
                  disabled={loading}
                  style={{ flex: 1, padding: '13px', background: 'var(--bg-subtle)', color: 'var(--text)', border: 'none', borderRadius: 14, fontWeight: 700, cursor: 'pointer' }}
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={loading}
                  style={{ flex: 1, padding: '13px', background: loading ? 'var(--bg-subtle)' : 'var(--coral)', color: loading ? 'var(--text)' : 'white', border: 'none', borderRadius: 14, fontWeight: 800, cursor: loading ? 'not-allowed' : 'pointer' }}
                >
                  {loading ? 'Procesando…' : 'Redimir ahora'}
                </button>
              </div>
            </form>
          </>
        ) : (
          <div style={{ textAlign: 'center', padding: '8px 0' }}>
            <span style={{ fontSize: '3rem' }}>✅</span>
            <h2 style={{ margin: '10px 0 4px', fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: '1.3rem' }}>
              ¡Redención exitosa!
            </h2>
            <p style={{ margin: '0 0 16px', fontSize: '0.85rem', color: 'var(--text)', opacity: 0.7 }}>
              Se descontaron <strong>{parseInt(montoARedimir, 10).toLocaleString()} puntos</strong> de tu cuenta.
            </p>

            <div style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)', borderRadius: 14, padding: 16, marginBottom: 18 }}>
              <span style={{ fontSize: '0.7rem', color: 'var(--text)', opacity: 0.55, textTransform: 'uppercase' }}>
                Descuento autorizado en caja
              </span>
              <div style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: '1.8rem', color: 'var(--text-h)' }}>
                ${parseInt(montoARedimir, 10).toLocaleString()} COP
              </div>
            </div>

            <div style={{ textAlign: 'left', fontSize: '0.75rem', background: 'var(--coral-light)', border: '1px solid var(--coral-border)', padding: 14, borderRadius: 14, color: 'var(--coral)', marginBottom: 18 }}>
              <p style={{ margin: '0 0 6px', fontWeight: 700 }}>💡 ¿Qué debes hacer ahora?</p>
              <p style={{ margin: '0 0 4px' }}>1. Informa al cajero que pagarás con puntos.</p>
              <p style={{ margin: '0 0 4px' }}>2. El cajero verá la confirmación en su pantalla automáticamente.</p>
              <p style={{ margin: 0 }}>3. Paga el saldo restante en efectivo, transferencia u otro medio.</p>
            </div>
            <p style={{ fontSize: '0.68rem', color: 'var(--text)', opacity: 0.5, marginBottom: 16 }}>
              * No acumularás puntos nuevos por consumos de hoy.
            </p>

            <button
              onClick={onClose}
              style={{ width: '100%', padding: '13px', background: 'var(--dark)', color: 'white', border: 'none', borderRadius: 14, fontWeight: 800, cursor: 'pointer' }}
            >
              Entendido
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
