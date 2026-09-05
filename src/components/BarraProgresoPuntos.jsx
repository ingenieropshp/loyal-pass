/**
 * BarraProgresoPuntos.jsx
 * Tarjeta "Mis Puntos" de la pantalla principal: barra de progreso hacia el
 * mínimo de redención (15.000 pts), con dos estados visuales.
 *
 * El tip "Asiste al local" combina los dos bonos reales de llegada:
 * `puntos_geocerca` (automático, al entrar al radio) + `puntos_llegada`
 * (fijo, al pagar en caja con cédula — ya no hay check-in manual GPS/PIN).
 * Ambos configurados por restaurante en `conexion`/`configuracion`.
 * El tip "Por tus consumos" usa `mensajeIncentivoConsumo`, un texto libre
 * editable desde el panel admin (campo "Mensaje de incentivo por consumo").
 * Si el admin no lo configuró, se muestra un texto genérico sin cifras en
 * vez de inventar una tasa que no existe.
 */

const MINIMO_REDENCION = 15000; // debe coincidir con el resto del sistema (backend de redención y de alertas de vencimiento)

export function BarraProgresoPuntos({
  puntosActual = 0,
  cargando = false,
  puntosLlegada = null,           // bono fijo al pagar en caja (useGeofencingContext)
  puntosGeocerca = null,          // bono automático al entrar al radio de geocerca
  mensajeIncentivoConsumo = null, // texto editable desde el panel admin (config.mensajeIncentivoConsumo)
  onPagarConPuntos,                // abre el modal de redención existente
}) {
  const metaAlcanzada = puntosActual >= MINIMO_REDENCION;
  const proporcion    = Math.min(puntosActual / MINIMO_REDENCION, 1);
  const faltantes     = Math.max(MINIMO_REDENCION - puntosActual, 0);

  return (
    <div className={`mis-puntos-card ${metaAlcanzada ? 'meta-alcanzada' : 'acumulando'}`}>
      <div className="mis-puntos-header">
        <span className="mis-puntos-title">Mis Puntos</span>
        <span className="mis-puntos-fraccion">
          {cargando ? '—' : puntosActual.toLocaleString('es-CO')} / {MINIMO_REDENCION.toLocaleString('es-CO')} pts
        </span>
      </div>

      <div className="mis-puntos-track">
        <div
          className="mis-puntos-fill"
          style={{ width: cargando ? '0%' : `${proporcion * 100}%` }}
        />
      </div>

      {cargando ? (
        <p className="mis-puntos-mensaje">Cargando tu saldo…</p>
      ) : metaAlcanzada ? (
        <>
          <p className="mis-puntos-mensaje exito">✨ ¡Meta Alcanzada! ✨</p>
          <div className="monto-disponible-box">
            <p className="monto-disponible-cifra">
              Tienes ${puntosActual.toLocaleString('es-CO')} COP disponibles
            </p>
            <p className="monto-disponible-equivalencia">(1 punto = $1 COP)</p>
          </div>
          <button className="btn-pagar-con-puntos" onClick={onPagarConPuntos}>
            💳 Pagar con mis Puntos
          </button>
        </>
      ) : (
        <>
          <p className="mis-puntos-mensaje">Te faltan {faltantes.toLocaleString('es-CO')} puntos</p>
          <div className="tips-box">
            <p className="tips-title">¡Gana Puntos Rápido!</p>
            <div className="tip-item">
              <span className="tip-icono">📍</span>
              <span>
                Asiste al local
                {(puntosGeocerca != null || puntosLlegada != null) && (
                  <> <b>(
                    {puntosGeocerca != null && `+${puntosGeocerca} pts por cercanía`}
                    {puntosGeocerca != null && puntosLlegada != null && ' + '}
                    {puntosLlegada != null && `${puntosGeocerca == null ? '+' : ''}${puntosLlegada} pts por ordenar en caja`}
                  )</b></>
                )}
              </span>
            </div>
            <div className="tip-item">
              <span className="tip-icono">🧾</span>
              <span>
                Por tus consumos
                {mensajeIncentivoConsumo?.trim() ? (
                  <> — <b>{mensajeIncentivoConsumo.trim()}</b></>
                ) : (
                  <> — acumula puntos con cada compra en el restaurante</>
                )}
              </span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
