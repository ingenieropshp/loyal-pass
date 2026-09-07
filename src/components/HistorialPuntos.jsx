/**
 * HistorialPuntos.jsx
 * Historial de transacciones de puntos del cliente.
 * Lee de la tabla `transacciones_puntos` de Supabase (tipo_transaccion,
 * puntos, monto_factura, detalles, creado_en) — reemplaza a la antigua
 * `historial_puntos`, que no tenía una estructura real detrás.
 */

import { useState, useEffect } from 'react';
import { supabase } from '../services/supabaseClient';

// Icono + color de fondo por tipo de transacción. El signo +/- del monto
// NO sale de aquí, sino del signo real de `puntos` (columna `chk_signo_puntos`
// en la base de datos ya lo garantiza, pero conviene que el frontend sea
// robusto por sí mismo y no asuma el signo por tipo).
const CONFIG_TIPO = {
  BIENVENIDA:  { icono: '🎁', bg: 'var(--green-light)', etiqueta: 'Bono de bienvenida' },
  PROXIMIDAD:  { icono: '📍', bg: 'var(--green-light)', etiqueta: 'Bono por cercanía' },
  COMPRA_CAJA: { icono: '💳', bg: 'var(--green-light)', etiqueta: 'Bono por compra en caja' },
  CONSUMO:     { icono: '🧾', bg: 'var(--green-light)', etiqueta: 'Puntos por consumo' },
  REDENCION:   { icono: '💸', bg: 'var(--coral-light)', etiqueta: 'Redención de puntos' },
  VENCIMIENTO: { icono: '⏰', bg: 'var(--coral-light)', etiqueta: 'Puntos vencidos' },
};
const CONFIG_DEFAULT = { icono: '🔧', bg: 'var(--bg-subtle)', etiqueta: 'Movimiento' };

function formatearMonto(valor) {
  return `$${Math.round(valor).toLocaleString('es-CO')}`;
}

// Clave de agrupación cronológica: "Hoy", "Ayer", o el nombre del mes
// (con año solo si es distinto al actual, para no saturar el año en curso).
function obtenerGrupoFecha(iso) {
  const d    = new Date(iso);
  const hoy  = new Date();
  const ayer = new Date();
  ayer.setDate(hoy.getDate() - 1);

  const mismoDia = (a, b) => a.toDateString() === b.toDateString();
  if (mismoDia(d, hoy))  return 'Hoy';
  if (mismoDia(d, ayer)) return 'Ayer';

  const opciones = { month: 'long', ...(d.getFullYear() !== hoy.getFullYear() ? { year: 'numeric' } : {}) };
  const mes = d.toLocaleDateString('es-CO', opciones);
  return mes.charAt(0).toUpperCase() + mes.slice(1);
}

// Dentro de "Hoy"/"Ayer" el encabezado del grupo ya dice el día, así que la
// línea secundaria de cada fila muestra la hora; en grupos por mes muestra
// el día exacto.
function formatearDetalleFecha(iso, grupo) {
  const d = new Date(iso);
  if (grupo === 'Hoy' || grupo === 'Ayer') {
    return d.toLocaleTimeString('es-CO', { hour: 'numeric', minute: '2-digit' });
  }
  return d.toLocaleDateString('es-CO', { day: 'numeric', month: 'short' });
}

// Agrupa una lista YA ordenada (desc por fecha) preservando el orden de
// aparición — no reordena, solo junta filas consecutivas bajo un encabezado.
function agruparPorFecha(lista) {
  const grupos = new Map();
  for (const item of lista) {
    const clave = obtenerGrupoFecha(item.creado_en);
    if (!grupos.has(clave)) grupos.set(clave, []);
    grupos.get(clave).push(item);
  }
  return Array.from(grupos.entries());
}

export function HistorialPuntos({ clienteId, restauranteId, mostrarVacio = false }) {
  const [historial, setHistorial] = useState([]);
  const [cargando,  setCargando]  = useState(true);
  const [expandido, setExpandido] = useState(false);

  useEffect(() => {
    if (!clienteId) {
      // Sin cliente (aún no registrado en esta sede): no hay nada que
      // consultar. Antes esto dejaba `cargando` en true para siempre —
      // inofensivo cuando el componente se auto-oculta (mostrarVacio=false),
      // pero visible como spinner eterno cuando se usa como pantalla propia.
      setHistorial([]);
      setCargando(false);
      return;
    }

    let query = supabase
      .from('transacciones_puntos')
      .select('*')
      .eq('cliente_id', clienteId)
      .order('creado_en', { ascending: false })
      .limit(50);

    if (restauranteId) query = query.eq('restaurante_id', restauranteId);

    query.then(({ data }) => {
      setHistorial(data || []);
      setCargando(false);
    });
  }, [clienteId, restauranteId]);

  // Uso embebido en el dashboard (mostrarVacio=false, comportamiento
  // original): se oculta por completo mientras carga o si no hay
  // movimientos, para no ocupar espacio innecesario.
  if (!mostrarVacio && (cargando || historial.length === 0)) return null;

  // Uso como pantalla propia (pestaña "Pagos"): siempre mostramos algo,
  // aunque sea un mensaje de carga o de "todavía no hay movimientos".
  if (mostrarVacio && cargando) {
    return (
      <p style={{ textAlign: 'center', fontSize: '0.85rem', color: 'var(--text)', opacity: 0.6, padding: '2rem 0' }}>
        Cargando tu historial…
      </p>
    );
  }

  if (mostrarVacio && historial.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '2.5rem 1rem' }}>
        <p style={{ fontSize: '2rem', margin: '0 0 10px' }}>🧾</p>
        <p style={{ margin: 0, fontSize: '0.9rem', fontWeight: 600, color: 'var(--text-h)' }}>
          Aún no tienes movimientos
        </p>
        <p style={{ margin: '4px 0 0', fontSize: '0.8rem', color: 'var(--text)', opacity: 0.6 }}>
          {clienteId
            ? 'Cuando ganes o uses puntos, los verás aquí.'
            : 'Regístrate en el local para empezar a ganar puntos.'}
        </p>
      </div>
    );
  }

  const visibles = expandido ? historial : historial.slice(0, 5);
  const grupos   = agruparPorFecha(visibles);

  return (
    <div style={{ marginBottom: 20 }}>
      {/* Cabecera */}
      <p style={{
        margin: '0 0 12px',
        fontFamily: 'var(--font-display)',
        fontWeight: 700, fontSize: '1rem',
        color: 'var(--text-h)',
      }}>
        Historial
      </p>

      {/* Grupos cronológicos: Hoy / Ayer / mes */}
      {grupos.map(([etiquetaGrupo, items], gi) => (
        <div key={etiquetaGrupo} style={{ marginBottom: gi < grupos.length - 1 ? 16 : 0 }}>
          <p style={{
            margin: '0 0 6px 2px',
            fontSize: '0.72rem', fontWeight: 700,
            textTransform: 'uppercase', letterSpacing: '0.04em',
            color: 'var(--text)', opacity: 0.5,
          }}>
            {etiquetaGrupo}
          </p>

          <div style={{
            background:   'var(--bg-card)',
            borderRadius: 16,
            border:       '1px solid var(--border)',
            overflow:     'hidden',
          }}>
            {items.map((item, i) => {
              const cfg        = CONFIG_TIPO[item.tipo_transaccion] ?? CONFIG_DEFAULT;
              const esIngreso  = item.puntos >= 0;
              const signo      = esIngreso ? '+' : '-';

              return (
                <div
                  key={item.id}
                  style={{
                    display:    'flex',
                    alignItems: 'center',
                    gap:        12,
                    padding:    '13px 14px',
                    borderBottom: i < items.length - 1 ? '1px solid var(--border)' : 'none',
                  }}
                >
                  {/* Ícono */}
                  <div style={{
                    width:        38, height: 38, borderRadius: '50%',
                    background:   cfg.bg, flexShrink: 0,
                    display:      'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize:     '1rem',
                  }}>
                    {cfg.icono}
                  </div>

                  {/* Descripción */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ margin: 0, fontWeight: 600, fontSize: '0.85rem', color: 'var(--text-h)' }}>
                      {item.detalles?.trim() || cfg.etiqueta}
                    </p>
                    <p style={{ margin: '2px 0 0', fontSize: '0.72rem', color: 'var(--text)', opacity: 0.55 }}>
                      {formatearDetalleFecha(item.creado_en, etiquetaGrupo)}
                      {item.monto_factura ? ` · Compra de ${formatearMonto(item.monto_factura)}` : ''}
                    </p>
                  </div>

                  {/* Puntos */}
                  <span style={{
                    fontFamily: 'var(--font-display)',
                    fontWeight: 800, fontSize: '0.95rem',
                    color:      esIngreso ? 'var(--green)' : 'var(--coral)',
                    flexShrink: 0,
                  }}>
                    {signo}{Math.abs(item.puntos).toLocaleString('es-CO')} pts
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {/* Ver más / menos */}
      {historial.length > 5 && (
        <button
          onClick={() => setExpandido(v => !v)}
          style={{
            width: '100%', marginTop: 8, padding: '10px',
            background: 'transparent', border: '1px solid var(--border)',
            borderRadius: 12, fontSize: '0.82rem', fontWeight: 600,
            cursor: 'pointer', color: 'var(--text)',
          }}
        >
          {expandido ? 'Ver menos ▲' : `Ver los ${historial.length - 5} anteriores ▼`}
        </button>
      )}
    </div>
  );
}
