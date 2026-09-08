/**
 * HistorialPuntos.jsx
 * Historial de transacciones de puntos del cliente.
 * Lee de la tabla `transacciones_puntos` de Supabase.
 *
 * FIX (rediseño "Luxury Charcoal & Gold"): este componente mostraba
 * SIEMPRE "Movimiento" con el ícono genérico 🔧, sin importar el tipo real
 * de transacción. La causa no era de estilos — era que leía columnas que
 * no existen en la tabla real: `item.tipo_transaccion` (la columna real se
 * llama `tipo`), `item.detalles` y `item.monto_factura` (no existen; el
 * equivalente real es `referencia` (jsonb) y `monto_cop`). Como esas
 * columnas siempre venían `undefined`, el lookup en el diccionario de
 * abajo fallaba siempre y todo caía al valor por defecto. Verificado
 * contra el esquema real de `transacciones_puntos` en Supabase: id,
 * cliente_id, restaurante_id, tipo, canal, monto_cop, puntos,
 * puntos_restantes, fecha_vencimiento, vencido, referencia, creado_en.
 *
 * Los valores reales de `tipo` que escriben las funciones de la base de
 * datos (fn_bono_bienvenida, fn_evento_geocerca, fn_registrar_consumo,
 * fn_aplicar_redencion, fn_premiacion_anual, y algunas variantes/legado
 * que pueden seguir existiendo en filas antiguas del ledger) son en
 * minúsculas con guion bajo — el diccionario de abajo usa esas claves
 * reales, normalizando a minúsculas por robustez.
 */

import { useState, useEffect } from 'react';
import { supabase } from '../services/supabaseClient';

// Icono + etiqueta comercial por tipo real de transacción (columna `tipo`,
// normalizada a minúsculas). El signo +/- del monto NO sale de aquí, sino
// del signo real de `puntos` — el frontend no lo asume por tipo.
const CONFIG_TIPO = {
  // Bono de bienvenida al registrarse (trg_bono_bienvenida / variantes)
  bono_bienvenida:   { icono: '🎁', bg: 'rgba(212,175,55,0.14)', etiqueta: 'Bono de Bienvenida' },
  bienvenida:        { icono: '🎁', bg: 'rgba(212,175,55,0.14)', etiqueta: 'Bono de Bienvenida' },
  // Bono automático al entrar en el radio de geocerca (+200 pts)
  geocerca_entrada:  { icono: '📍', bg: 'rgba(212,175,55,0.14)', etiqueta: 'Bono de Proximidad' },
  proximidad:        { icono: '📍', bg: 'rgba(212,175,55,0.14)', etiqueta: 'Bono de Proximidad' },
  // Bono fijo por ordenar/pagar en caja (+300 pts)
  llegada:           { icono: '🍽️', bg: 'rgba(212,175,55,0.14)', etiqueta: 'Bono por Visitar' },
  orden_sitio:       { icono: '🍽️', bg: 'rgba(212,175,55,0.14)', etiqueta: 'Bono por Visitar' },
  // Acumulación por consumo — se distingue domicilio vs presencial por la
  // columna `canal`, ver getConfigTransaccion() más abajo.
  consumo:           { icono: '🧾', bg: 'rgba(245,245,220,0.08)', etiqueta: 'Acumulación por Compra' },
  // Redención de puntos en caja
  redencion:         { icono: '🎟️', bg: 'rgba(196,123,74,0.16)', etiqueta: 'Redención de Puntos' },
  // Top-3 anual del 5 de diciembre
  premiacion_anual:  { icono: '🏆', bg: 'rgba(212,175,55,0.14)', etiqueta: 'Premio de Fin de Año' },
  // Bono por referir a un amigo
  bono:              { icono: '⭐', bg: 'rgba(212,175,55,0.14)', etiqueta: 'Bono por Referido' },
  referido:          { icono: '⭐', bg: 'rgba(212,175,55,0.14)', etiqueta: 'Bono por Referido' },
};
const CONFIG_DEFAULT = { icono: '✨', bg: 'rgba(245,245,220,0.06)', etiqueta: 'Movimiento' };

// Resuelve ícono + etiqueta para una fila del historial. Normaliza `tipo` a
// minúsculas (por si algún origen antiguo lo guardó distinto) y solo para
// 'consumo' distingue domicilio de presencial usando la columna real
// `canal` — un pedido a domicilio no debería verse igual que un consumo en
// el local, aunque ambos comparten `tipo = 'consumo'`.
function getConfigTransaccion(item) {
  const tipoNormalizado = String(item?.tipo || '').trim().toLowerCase();

  if (tipoNormalizado === 'consumo' && item?.canal === 'domicilio') {
    return { icono: '🛵', bg: 'rgba(245,245,220,0.08)', etiqueta: 'Pedido a Domicilio' };
  }

  return CONFIG_TIPO[tipoNormalizado] ?? CONFIG_DEFAULT;
}

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

    // Columnas explícitas (en vez de '*'): documenta cuáles usa realmente
    // este componente y evita que un futuro cambio de esquema vuelva a
    // pasar desapercibido como pasó con tipo_transaccion/detalles/
    // monto_factura (columnas que nunca existieron — ver comentario arriba).
    let query = supabase
      .from('transacciones_puntos')
      .select('id, tipo, canal, puntos, monto_cop, creado_en')
      .eq('cliente_id', clienteId)
      .order('creado_en', { ascending: false })
      .limit(50);

    if (restauranteId) query = query.eq('restaurante_id', restauranteId);

    // FIX: igual que en CatalogoRecompensas.jsx — faltaba leer `error` del
    // resultado y faltaba un `.catch()` detrás del `.then()`. Sin esto, un
    // rechazo de la promesa (red caída, sesión venciendo, etc.) quedaba sin
    // manejar y aparecía en consola como "Uncaught (in promise) ▶ Object".
    query
      .then(({ data, error }) => {
        if (error) {
          console.error('[HistorialPuntos] No se pudo cargar el historial:', error.message);
          setHistorial([]);
        } else {
          setHistorial(data || []);
        }
        setCargando(false);
      })
      .catch((err) => {
        console.error('[HistorialPuntos] Error inesperado cargando el historial:', err?.message || err);
        setHistorial([]);
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
              const cfg        = getConfigTransaccion(item);
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

                  {/* Descripción — nombre comercial resuelto por getConfigTransaccion(),
                      no hay columna de texto libre en el esquema real (solo
                      `referencia` jsonb, no pensada para mostrarse tal cual). */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ margin: 0, fontWeight: 600, fontSize: '0.85rem', color: 'var(--luxury-cream, #F5F5DC)' }}>
                      {cfg.etiqueta}
                    </p>
                    <p style={{ margin: '2px 0 0', fontSize: '0.72rem', color: 'var(--text)', opacity: 0.55 }}>
                      {formatearDetalleFecha(item.creado_en, etiquetaGrupo)}
                      {item.monto_cop > 0 ? ` · Compra de ${formatearMonto(item.monto_cop)}` : ''}
                    </p>
                  </div>

                  {/* Puntos — colores pedidos explícitamente para este bloque:
                      verde oliva suave para positivos, bronce/dorado tenue
                      para negativos (distinto del --green/--coral globales,
                      que siguen usándose en el resto de la app). */}
                  <span style={{
                    fontFamily: 'var(--font-display)',
                    fontWeight: 800, fontSize: '0.95rem',
                    color:      esIngreso ? '#A3C585' : '#C97B4A',
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
