import { useState } from 'react';
import { supabase } from '../services/supabaseClient';

const MIN_PUNTOS = 15000;

/**
 * RedimirPuntosModal
 * ────────────────────────────────────────────────────────────────────────
 * Permite al cliente SOLICITAR la redención de un MONTO LIBRE de puntos
 * (no un premio fijo del catálogo) para pagar parcial o totalmente su
 * cuenta en caja.
 *
 * Usa la función RPC `fn_solicitar_redencion`, que solo crea una fila
 * 'pendiente' en la tabla `redenciones` — NO descuenta puntos todavía.
 * El Panel Admin escucha esa tabla por Supabase Realtime y muestra una
 * alerta con el código de validación; el cajero confirma con el cliente
 * y presiona "Aplicar", lo que dispara `fn_aplicar_redencion` en el
 * servidor y ahí sí se descuentan los puntos. Este flujo de dos pasos
 * evita que el saldo se toque a ciegas desde el navegador.
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
  const [codigoValidacion, setCodigoValidacion] = useState(null);

  if (!isOpen) return null;

  const saldoActual = cliente?.puntos || 0;

  const handleRedencion = async (e) => {
    e.preventDefault();
    setError(null);
    const puntosRedimir = parseInt(montoARedimir, 10);

    // ── Validaciones en cliente (la fuente de verdad real es el servidor) ─
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
      // ── Solicitar la redención — queda 'pendiente', sin tocar el saldo.
      //     El Panel Admin recibe la alerta en vivo vía Realtime sobre la
      //     tabla `redenciones` (no hace falta broadcast aparte). ──────────
      const { data, error: rpcError } = await supabase.rpc('fn_solicitar_redencion', {
        p_restaurante_id: restauranteId,
        p_cliente_id:     cliente.id,
        p_monto_cop:      puntosRedimir,
      });
      if (rpcError) throw rpcError;

      if (!data?.ok) {
        const legibles = {
          cliente_no_encontrado:         'No se pudo identificar tu cuenta en esta sede.',
          monto_bajo_minimo_redimible:   `El monto mínimo por transacción es de ${MIN_PUNTOS.toLocaleString()} puntos.`,
          saldo_bajo_minimo_activacion:  'Tu saldo actual es inferior al mínimo requerido para redimir.',
          saldo_insuficiente:            'No tienes suficientes puntos para ese monto.',
        };
        setError(legibles[data?.motivo] || 'Ocurrió un error al procesar la redención. Inténtalo de nuevo.');
        setLoading(false);
        return;
      }

      // ── Éxito: guardamos el código para mostrárselo al cliente.
      //     OJO: el saldo NO cambia todavía — solo cambia cuando el
      //     cajero aplique la redención desde el Panel Admin. ───────────
      setCodigoValidacion(data.codigo_validacion);
      onRedencionExitosa?.(saldoActual); // el saldo sigue igual por ahora
    } catch (err) {
      console.error('[RedimirPuntosModal]', err);
      setError('Ocurrió un error al procesar la redención. Inténtalo de nuevo.');
    } finally {
      setLoading(false);
    }
  };

  const cerrarYReiniciar = () => {
    setCodigoValidacion(null);
    setMontoARedimir('');
    setError(null);
    onClose?.();
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      background: 'rgba(0,0,0,0.55)',
      display: 'flex', alignItems: 'flex-end',
    }} onClick={(e) => e.target === e.currentTarget && cerrarYReiniciar()}>
      <div style={{
        width: '100%', background: 'var(--bg-card)',
        borderRadius: '20px 20px 0 0', padding: '24px 20px 32px',
      }}>
        <div style={{ width: 36, height: 4, background: 'var(--border)', borderRadius: 2, margin: '0 auto 20px' }} />

        {!codigoValidacion ? (
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
                  onClick={cerrarYReiniciar}
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
                  {loading ? 'Enviando…' : 'Solicitar redención'}
                </button>
              </div>
            </form>
          </>
        ) : (
          <div style={{ textAlign: 'center', padding: '8px 0' }}>
            <span style={{ fontSize: '3rem' }}>⏳</span>
            <h2 style={{ margin: '10px 0 4px', fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: '1.3rem' }}>
              Solicitud enviada
            </h2>
            <p style={{ margin: '0 0 16px', fontSize: '0.85rem', color: 'var(--text)', opacity: 0.7 }}>
              Muéstrale este código al cajero para que confirme el pago de <strong>${parseInt(montoARedimir, 10).toLocaleString()} COP</strong> con tus puntos.
            </p>

            <div style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)', borderRadius: 14, padding: 16, marginBottom: 18 }}>
              <span style={{ fontSize: '0.7rem', color: 'var(--text)', opacity: 0.55, textTransform: 'uppercase' }}>
                Código de validación
              </span>
              <div style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: '2.2rem', letterSpacing: '0.1em', color: 'var(--text-h)' }}>
                {codigoValidacion}
              </div>
            </div>

            <div style={{ textAlign: 'left', fontSize: '0.75rem', background: 'var(--coral-light)', border: '1px solid var(--coral-border)', padding: 14, borderRadius: 14, color: 'var(--coral)', marginBottom: 18 }}>
              <p style={{ margin: '0 0 6px', fontWeight: 700 }}>💡 ¿Qué debes hacer ahora?</p>
              <p style={{ margin: '0 0 4px' }}>1. Dile al cajero que vas a pagar con puntos.</p>
              <p style={{ margin: '0 0 4px' }}>2. Muéstrale este código — le va a aparecer también en su pantalla.</p>
              <p style={{ margin: 0 }}>3. Tus puntos se descuentan solo cuando el cajero confirme.</p>
            </div>
            <p style={{ fontSize: '0.68rem', color: 'var(--text)', opacity: 0.5, marginBottom: 16 }}>
              * Tu saldo aún no ha cambiado — se actualizará cuando el cajero confirme el código.
            </p>

            <button
              onClick={cerrarYReiniciar}
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
