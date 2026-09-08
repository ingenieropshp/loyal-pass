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
 *
 * REDISEÑO "Luxury Charcoal & Gold" (100% visual — ninguna cifra ni regla
 * de negocio cambia aquí, solo cómo se dibuja): el fondo pasa de un
 * degradado de color por nivel a negro/charcoal con borde dorado, y el
 * saldo de puntos ahora se muestra dentro de un dial circular dorado
 * metálico animado (SVG, stroke-dashoffset) en vez del número plano de
 * antes. El progreso del dial es el mismo `progresoNivel` que ya se
 * calculaba (0 a 1) — solo cambió cómo se dibuja, no cómo se calcula. Los
 * 4 niveles (Bronce/Plata/Oro/Platino) siguen exactamente iguales en sus
 * umbrales de puntos (NIVELES, sin tocar).
 */

import { useId, useMemo } from 'react';

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

  // ── Dial circular dorado ──────────────────────────────────────────────
  // SVG con un círculo de fondo (surco) y un círculo de progreso encima,
  // dibujado con stroke-dasharray/-dashoffset (el truco clásico para un
  // "donut" de progreso). `progresoNivel` (0 a 1) es el MISMO valor que ya
  // se usaba para la barra horizontal anterior — no se recalculó nada.
  const idGradiente = useId(); // evita colisión de <linearGradient id> si hay 2 tarjetas en la misma página
  const RADIO = 54;
  const CIRCUNFERENCIA = 2 * Math.PI * RADIO;
  const offsetDial = cargando ? CIRCUNFERENCIA : CIRCUNFERENCIA * (1 - progresoNivel);

  return (
    <div style={{
      background:   'linear-gradient(160deg, #1b1712 0%, #0c0a08 100%)',
      border:       '1px solid rgba(212,175,55,0.35)',
      borderRadius: 20,
      padding:      '20px 20px 18px',
      color:        'var(--luxury-cream, #F5F5DC)',
      marginBottom: 16,
      position:     'relative',
      overflow:     'hidden',
      boxShadow:    '0 10px 32px rgba(0,0,0,0.55), 0 0 0 1px rgba(212,175,55,0.06)',
    }}>
      {/* Filete dorado superior */}
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0, height: 3,
        background: 'linear-gradient(135deg, #CA8A04 0%, #F5C451 45%, #EAB308 100%)',
      }} />
      {/* Decoración de fondo — resplandor dorado sutil, no color de nivel */}
      <div style={{
        position:     'absolute', top: -40, right: -40,
        width:         160, height: 160,
        borderRadius:  '50%',
        background:    'radial-gradient(circle, rgba(212,175,55,0.14) 0%, rgba(212,175,55,0) 70%)',
        pointerEvents: 'none',
      }} />

      {/* Cabecera: nombre del programa + nivel */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
        <div>
          <p style={{ margin: 0, fontSize: '0.65rem', fontWeight: 700, opacity: 0.7, letterSpacing: '0.12em', textTransform: 'uppercase', color: '#D4AF37' }}>
            LoyalPass
          </p>
          <p style={{ margin: '2px 0 0', fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: '1.1rem' }}>
            {nombreRestaurante}
          </p>
        </div>
        <div style={{
          background:    nivel.bg,
          borderRadius:  10,
          padding:       '5px 12px',
          fontSize:      '0.78rem',
          fontWeight:    700,
          display:       'flex',
          alignItems:    'center',
          gap:           5,
          color:         '#1A1204',
          boxShadow:     '0 2px 8px rgba(0,0,0,0.35)',
        }}>
          {nivel.icono} {nivel.nombre}
        </div>
      </div>

      {/* Nombre del cliente */}
      <p style={{ margin: '0 0 4px', fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: '1.15rem', letterSpacing: '-0.01em' }}>
        {cliente?.nombre || '—'}
      </p>
      <p style={{ margin: '0 0 16px', fontSize: '0.8rem', opacity: 0.55 }}>
        {cliente?.telefono || ''}
      </p>

      {/* ── Dial circular dorado con el saldo en el centro ────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 18, marginBottom: siguienteNivel ? 4 : 0 }}>
        <div style={{ position: 'relative', width: 128, height: 128, flexShrink: 0 }}>
          <svg
            width="128" height="128" viewBox="0 0 128 128"
            style={{ transform: 'rotate(-90deg)', filter: 'drop-shadow(0 0 6px rgba(212,175,55,0.35))' }}
          >
            <defs>
              <linearGradient id={`dial-oro-${idGradiente}`} x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%"  stopColor="#CA8A04" />
                <stop offset="45%" stopColor="#F5C451" />
                <stop offset="100%" stopColor="#EAB308" />
              </linearGradient>
            </defs>
            {/* Surco de fondo */}
            <circle cx="64" cy="64" r={RADIO} fill="none" stroke="rgba(212,175,55,0.14)" strokeWidth="10" />
            {/* Progreso dorado animado */}
            <circle
              cx="64" cy="64" r={RADIO} fill="none"
              stroke={`url(#dial-oro-${idGradiente})`}
              strokeWidth="10"
              strokeLinecap="round"
              strokeDasharray={CIRCUNFERENCIA}
              strokeDashoffset={offsetDial}
              className="lp-dial-progreso"
            />
          </svg>
          {/* Saldo, centrado sobre el dial */}
          <div style={{
            position: 'absolute', inset: 0,
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          }}>
            <span style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: '1.5rem', lineHeight: 1, color: '#FBF8EE' }}>
              {cargando ? '—' : puntosTotales.toLocaleString()}
            </span>
            <span style={{ fontSize: '0.6rem', letterSpacing: '0.06em', textTransform: 'uppercase', opacity: 0.6, marginTop: 3 }}>
              {cargando ? 'cargando…' : 'puntos'}
            </span>
          </div>
        </div>

        {/* Progreso al siguiente nivel, al lado del dial */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {!cargando && siguienteNivel && (
            <>
              <p style={{ margin: '0 0 4px', fontSize: '0.72rem', color: '#D4AF37', fontWeight: 700 }}>
                Progreso a {siguienteNivel.icono} {siguienteNivel.nombre}
              </p>
              <p style={{ margin: 0, fontSize: '0.78rem', opacity: 0.8 }}>
                {puntosTotales.toLocaleString()} / {siguienteNivel.min.toLocaleString()} pts
              </p>
              <p style={{ margin: '6px 0 0', fontSize: '0.7rem', opacity: 0.6 }}>
                Te faltan {puntosParaSiguiente.toLocaleString()} pts
              </p>
            </>
          )}
          {!cargando && !siguienteNivel && (
            <p style={{ margin: 0, fontSize: '0.78rem', color: '#D4AF37', fontWeight: 700 }}>
              💎 Nivel máximo alcanzado<br />
              <span style={{ color: 'inherit', opacity: 0.75, fontWeight: 500 }}>Eres un cliente élite</span>
            </p>
          )}
        </div>
      </div>

      {/* Anima el dial dorado de 0 al valor real cada vez que cambia el saldo/nivel */}
      <style>{`
        .lp-dial-progreso {
          transition: stroke-dashoffset 0.9s cubic-bezier(0.22, 1, 0.36, 1);
        }
      `}</style>
    </div>
  );
}
