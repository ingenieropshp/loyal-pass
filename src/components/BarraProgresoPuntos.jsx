/**
 * BarraProgresoPuntos.jsx
 * Tarjeta "Mis Puntos" de la pantalla principal: barra de progreso hacia el
 * mínimo de redención (15.000 pts), con dos estados visuales.
 *
 * NOTA sobre las cifras del tip de "Gana Puntos Rápido": el bono por llegar
 * al local (`puntos_llegada`) es dinámico y se configura por restaurante en
 * la tabla `conexion` (con default de 2 pts si el admin no lo configuró) —
 * se lee del contexto de geofencing real, no se inventa. No hay en este
 * cliente ninguna tasa fija de "puntos por consumo" ni un bono de "ordenar
 * en mesa", así que ese tip se deja genérico a propósito en vez de mostrar
 * una cifra falsa. Si tu backend sí tiene esa tasa, pásala por la prop
 * `puntosPorConsumo` (opcional) y se mostrará automáticamente.
 */

const MINIMO_REDENCION = 15000; // debe coincidir con el resto del sistema (backend de redención y de alertas de vencimiento)

export function BarraProgresoPuntos({
  puntosActual = 0,
  cargando = false,
  puntosLlegada = null,      // bono real de check-in por geocerca (useGeofencingContext)
  puntosPorConsumo = null,   // opcional: { puntos, montoCOP } si tu backend define una tasa fija
  onPagarConPuntos,          // abre el modal de redención existente
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
                {puntosLlegada != null && (
                  <> <b>(+{puntosLlegada} pts por check-in de llegada)</b></>
                )}
              </span>
            </div>
            <div className="tip-item">
              <span className="tip-icono">🧾</span>
              <span>
                Por tus consumos
                {puntosPorConsumo?.puntos && puntosPorConsumo?.montoCOP ? (
                  <> <b>(+{puntosPorConsumo.puntos} pts por cada ${puntosPorConsumo.montoCOP.toLocaleString('es-CO')} COP)</b></>
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
