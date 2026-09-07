/**
 * HistorialPuntos.jsx
 * Historial de transacciones de puntos del cliente.
 * Lee de la tabla `historial_puntos` de Supabase.
 */

import { useState, useEffect } from 'react';
import { supabase } from '../services/supabaseClient';

const CONFIG_TIPO = {
  visita: { icono: '📍', color: 'var(--green)',   bg: 'var(--green-light)',  signo: '+' },
  canje:  { icono: '🎁', color: 'var(--coral)',   bg: 'var(--coral-light)',  signo: '-' },
  bono:   { icono: '⭐', color: '#F59E0B',         bg: '#FFFBEB',             signo: '+' },
  ajuste: { icono: '🔧', color: 'var(--text)',    bg: 'var(--bg-subtle)',    signo:  '' },
};

function formatearFecha(iso) {
  if (!iso) return '';
  const d    = new Date(iso);
  const hoy  = new Date();
  const ayer = new Date(); ayer.setDate(ayer.getDate() - 1);

  if (d.toDateString() === hoy.toDateString())  return 'hoy';
  if (d.toDateString() === ayer.toDateString()) return 'ayer';

  return d.toLocaleDateString('es-CO', { day: 'numeric', month: 'short' });
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
      .from('historial_puntos')
      .select('*')
      .eq('cliente_id', clienteId)
      .order('created_at', { ascending: false })
      .limit(20);

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

      {/* Lista */}
      <div style={{
        background:   'var(--bg-card)',
        borderRadius: 16,
        border:       '1px solid var(--border)',
        overflow:     'hidden',
      }}>
        {visibles.map((item, i) => {
          const cfg   = CONFIG_TIPO[item.tipo] ?? CONFIG_TIPO.ajuste;
          const signo = item.puntos > 0 ? '+' : '';

          return (
            <div
              key={item.id}
              style={{
                display:    'flex',
                alignItems: 'center',
                gap:        12,
                padding:    '13px 14px',
                borderBottom: i < visibles.length - 1 ? '1px solid var(--border)' : 'none',
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
                  {item.descripcion || 'Transacción'}
                </p>
                <p style={{ margin: '2px 0 0', fontSize: '0.72rem', color: 'var(--text)', opacity: 0.55 }}>
                  {formatearFecha(item.created_at)}
                </p>
              </div>

              {/* Puntos */}
              <span style={{
                fontFamily: 'var(--font-display)',
                fontWeight: 800, fontSize: '0.95rem',
                color:      item.puntos >= 0 ? 'var(--green)' : 'var(--coral)',
                flexShrink: 0,
              }}>
                {signo}{item.puntos}
              </span>
            </div>
          );
        })}
      </div>

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
