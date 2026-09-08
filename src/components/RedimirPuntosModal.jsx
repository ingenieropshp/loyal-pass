import { useState } from 'react';
import { supabase } from '../services/supabaseClient';



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
  montoMinimoRedencion = 15000, // configuracion_restaurantes.monto_minimo_redencion
  onRedencionExitosa,
}) {
  const [montoARedimir, setMontoARedimir] = useState('');
  const [loading, setLoading]             = useState(false);
  const [error, setError]                 = useState(null);
  const [codigoValidacion, setCodigoValidacion] = useState(null);

  if (!isOpen) return null;

  const saldoActual = cliente?.saldo_puntos || 0;

  const handleRedencion = async (e) => {
    e.preventDefault();
    setError(null);
    const puntosRedimir = parseInt(montoARedimir, 10);

    // ── Validaciones en cliente (la fuente de verdad real es el servidor) ─
    if (isNaN(puntosRedimir)) {
      setError('Por favor, ingresa un número válido.');
      return;
    }
    if (saldoActual < montoMinimoRedencion) {
      setError(`Tu saldo actual (${saldoActual.toLocaleString()} pts) es inferior al mínimo de ${montoMinimoRedencion.toLocaleString()} pts requerido para redimir.`);
      return;
    }
    if (puntosRedimir < montoMinimoRedencion) {
      setError(`El monto mínimo por transacción es de ${montoMinimoRedencion.toLocaleString()} puntos ($${montoMinimoRedencion.toLocaleString()} COP).`);
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
          monto_bajo_minimo_redimible:   `El monto mínimo por transacción es de ${montoMinimoRedencion.toLocaleString()} puntos.`,
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
                placeholder={`Mínimo ${montoMinimoRedencion.toLocaleString()}`}
                disabled={loading}
                style={{
                  width: '100%', padding: '12px 14px', borderRadius: 12,
                  border: '1px solid var(--border-mid)', fontSize: '1rem', marginBottom: 4,
                }}
              />
              <p style={{ margin: '0 0 14px', fontSize: '0.72rem', color: 'var(--text)', opacity: 0.55 }}>
                Regla: mínimo {montoMinimoRedencion.toLocaleString()} puntos por transacción.
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

            {/* Paso 2 del flujo de redención: código de 6 dígitos — diseño
                "Luxury Charcoal & Gold" pedido explícitamente en negro
                profundo con el código brillando en dorado, distinto del
                resto de la tarjeta (que usa var(--bg-card), ya dorado/
                charcoal por el tema, pero este bloque debe verse aún más
                premium/oscuro que el resto del modal). */}
            <div style={{
              background: '#000000',
              border: '1px solid rgba(212,175,55,0.4)',
              borderRadius: 14, padding: '20px 16px', marginBottom: 18,
              boxShadow: 'inset 0 0 0 1px rgba(212,175,55,0.08), 0 0 30px rgba(212,175,55,0.08)',
            }}>
              <span style={{ fontSize: '0.7rem', color: '#D4AF37', opacity: 0.85, textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 700 }}>
                Código de validación
              </span>
              <div style={{
                fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: '2.4rem',
                letterSpacing: '0.14em', color: '#F5D26B',
                textShadow: '0 0 18px rgba(212,175,55,0.55), 0 0 2px rgba(212,175,55,0.8)',
                marginTop: 4,
              }}>
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
