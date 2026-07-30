import { useIOS } from '../hooks/useIOS';
import { BrandLogo } from './BrandLogo';

/**
 * IOSInstallBanner.jsx
 * ─────────────────────────────────────────────────────────────────
 * Se muestra SOLO cuando: el dispositivo es iOS Y la app todavía
 * NO está instalada (abierta en pestaña normal de Safari).
 *
 * Por qué existe: en iPhone, las notificaciones push no funcionan
 * hasta que el usuario agrega la app a su pantalla de inicio. Sin
 * este aviso, el botón de "Activar notificaciones" simplemente no
 * hace nada visible en Safari y el usuario no entiende por qué.
 */
export function IOSInstallBanner() {
  const { isIOS, isStandalone } = useIOS();

  if (!isIOS || isStandalone) return null;

  return (
    <div
      style={{
        margin: '1rem 0',
        padding: '14px 16px',
        borderRadius: 14,
        background: 'var(--surface, #f5f5f0)',
        border: '1px solid rgba(0,0,0,0.08)',
        fontSize: '0.85rem',
        lineHeight: 1.5,
        color: 'var(--text, #1a1a1a)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '6px' }}>
        <BrandLogo size={28} showWordmark={false} />
        <strong>📲 Instala LoyalPass en tu iPhone</strong>
      </div>
      <p style={{ margin: '0 0 6px', opacity: 0.8 }}>
        Para recibir notificaciones y guardar tu progreso:
      </p>
      <ol style={{ margin: '8px 0 0', paddingLeft: '1.2rem' }}>
        <li>
          Toca el ícono de compartir{' '}
          <span aria-label="compartir" style={{ fontWeight: 700 }}>⬆️</span>{' '}
          en la barra inferior de Safari
        </li>
        <li>Selecciona <strong>"Agregar a inicio"</strong></li>
        <li>Abre la app desde el ícono que aparece en tu pantalla de inicio</li>
      </ol>
    </div>
  );
}
