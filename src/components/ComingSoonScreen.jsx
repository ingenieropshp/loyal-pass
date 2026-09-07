/**
 * ComingSoonScreen.jsx
 * Placeholder visual para las pestañas Recompensas, Pagos y Cuenta
 * mientras no tienen contenido funcional propio.
 */

const ICONOS = {
  recompensas: '🎁',
  cuenta:      '👤',
};

export function ComingSoonScreen({ tab, titulo }) {
  return (
    <div className="coming-soon">
      <div className="coming-soon-icon">{ICONOS[tab] || '✨'}</div>
      <h2 className="coming-soon-title">{titulo}</h2>
      <p className="coming-soon-text">
        Estamos preparando esta sección. ¡Muy pronto vas a poder usarla desde aquí!
      </p>
    </div>
  );
}
