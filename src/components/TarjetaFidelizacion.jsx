/**
 * TarjetaFidelizacion.jsx
 * Tarjeta visual tipo "wallet card" con nivel (Bronce/Plata/Oro),
 * puntos disponibles, barra de progreso al siguiente nivel y QR.
 *
 * FIX: el saldo vuelve a llegar como prop (`puntosTotales`) calculado en
 * UserDashboard.jsx, en vez de que este componente consulte por su cuenta
 * la vista `saldo_usuario`. Antes se hacía esa consulta aquí filtrando por
 * `restaurante_id`, pero ese filtro se rompía cuando el valor recibido en
 * la URL era el NOMBRE del restaurante en vez de su UUID, y además la prop
 * `puntosTotales` que ya llegaba desde el padre ni siquiera se estaba
 * leyendo — por eso la tarjeta siempre mostraba 0.
 */

import { useMemo } from 'react';

// ── Definición de niveles ────────────────────────────────────────────────────
const NIVELES = [
  { nombre: 'Bronce', icono: '🥉', min: 0,    max: 200,  color: '#CD7F32', bg: 'linear-gradient(135deg, #b5651d 0%, #8B4513 100%)' },
  { nombre: 'Plata',  icono: '🥈', min: 200,  max: 500,  color: '#C0C0C0', bg: 'linear-gradient(135deg, #9E9E9E 0%, #616161 100%)' },
  { nombre: 'Oro',    icono: '🥇', min: 500,  max: 1000, color: '#FFD700', bg: 'linear-gradient(135deg, #F9A825 0%, #F57F17 100%)' },
  { nombre: 'Platino',icono: '💎', min: 1000, max: null,  color: '#B2EBF2', bg: 'linear-gradient(135deg, #00BCD4 0%, #006064 100%)' },
];

function getNivel(puntosTotales) {
  return NIVELES.findLast(n => puntosTotales >= n.min) ?? NIVELES[0];
}

function getSiguienteNivel(puntosTotales) {
  return NIVELES.find(n => n.min > puntosTotales) ?? null;
}

export function TarjetaFidelizacion({
  cliente,
  nombreRestaurante,
  puntosTotales = 0,   // saldo vigente ya resuelto por UserDashboard.jsx
  cargandoPuntos: cargando = false,
}) {
  const nivel          = useMemo(() => getNivel(puntosTotales), [puntosTotales]);
  const siguienteNivel = useMemo(() => getSiguienteNivel(puntosTotales), [puntosTotales]);

  const progresoNivel = siguienteNivel
    ? Math.min((puntosTotales - nivel.min) / (siguienteNivel.min - nivel.min), 1)
    : 1;

  const puntosParaSiguiente = siguienteNivel
    ? siguienteNivel.min - puntosTotales
    : 0;

  return (
    <div style={{
      background:   nivel.bg,
      borderRadius: 20,
      padding:      '20px 20px 16px',
      color:        'white',
      marginBottom: 16,
      position:     'relative',
      overflow:     'hidden',
      boxShadow:    '0 8px 32px rgba(0,0,0,0.18)',
    }}>
      {/* Decoración de fondo */}
      <div style={{
        position:     'absolute', top: -30, right: -30,
        width:         120, height: 120,
        borderRadius:  '50%',
        background:    'rgba(255,255,255,0.07)',
        pointerEvents: 'none',
      }} />
      <div style={{
        position:     'absolute', bottom: -20, left: -20,
        width:         80, height: 80,
        borderRadius:  '50%',
        background:    'rgba(255,255,255,0.05)',
        pointerEvents: 'none',
      }} />

      {/* Cabecera: nombre del programa + nivel */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
        <div>
          <p style={{ margin: 0, fontSize: '0.65rem', fontWeight: 700, opacity: 0.85, letterSpacing: '0.12em', textTransform: 'uppercase' }}>
            LoyalPass
          </p>
          <p style={{ margin: '2px 0 0', fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: '1.1rem' }}>
            {nombreRestaurante}
          </p>
        </div>
        <div style={{
          background:   'rgba(255,255,255,0.18)',
          borderRadius:  10,
          padding:       '5px 12px',
          fontSize:      '0.78rem',
          fontWeight:    700,
          display:       'flex',
          alignItems:    'center',
          gap:           5,
          backdropFilter:'blur(8px)',
        }}>
          {nivel.icono} {nivel.nombre}
        </div>
      </div>

      {/* Nombre del cliente */}
      <p style={{ margin: '0 0 4px', fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: '1.3rem', letterSpacing: '-0.01em' }}>
        {cliente?.nombre || '—'}
      </p>
      <p style={{ margin: '0 0 16px', fontSize: '0.8rem', opacity: 0.7 }}>
        {cliente?.telefono || ''}
      </p>

      {/* Puntos grandes */}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, marginBottom: 12 }}>
        <span style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: '2.6rem', lineHeight: 1 }}>
          {cargando ? '—' : puntosTotales.toLocaleString()}
        </span>
        <span style={{ fontSize: '0.85rem', opacity: 0.75, marginBottom: 6 }}>
          {cargando ? 'cargando…' : 'puntos vigentes'}
        </span>
      </div>

      {/* Barra de progreso al siguiente nivel */}
      {!cargando && siguienteNivel && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
            <span style={{ fontSize: '0.7rem', opacity: 0.75 }}>
              Progreso a {siguienteNivel.nombre}
            </span>
            <span style={{ fontSize: '0.7rem', fontWeight: 700 }}>
              {puntosTotales}/{siguienteNivel.min}
            </span>
          </div>
          <div style={{ height: 5, background: 'rgba(255,255,255,0.2)', borderRadius: 99, overflow: 'hidden' }}>
            <div style={{
              height:     '100%',
              width:      `${progresoNivel * 100}%`,
              background: 'rgba(255,255,255,0.85)',
              borderRadius: 99,
              transition: 'width 0.6s ease',
            }} />
          </div>
          <p style={{ margin: '6px 0 0', fontSize: '0.68rem', opacity: 0.7 }}>
            Te faltan {puntosParaSiguiente.toLocaleString()} pts para {siguienteNivel.icono} {siguienteNivel.nombre}
          </p>
        </div>
      )}

      {!cargando && !siguienteNivel && (
        <p style={{ margin: '4px 0 0', fontSize: '0.75rem', opacity: 0.85, fontWeight: 600 }}>
          💎 Nivel máximo alcanzado · Eres un cliente élite
        </p>
      )}
    </div>
  );
}
