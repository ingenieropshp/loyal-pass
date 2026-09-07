/**
 * AppHeader.jsx
 * Header superior fijo de la app: avatar con iniciales del cliente,
 * saludo con su primer nombre, y campana de notificaciones.
 *
 * Solo visual por ahora: el botón de notificaciones no abre nada todavía
 * (no hay bandeja de notificaciones implementada); el puntito rojo es un
 * indicador estático de "hay novedades", no un contador real.
 */

function obtenerIniciales(nombreCompleto) {
  const partes = (nombreCompleto || '').trim().split(/\s+/).filter(Boolean);
  if (partes.length === 0) return '👤';
  const iniciales = partes.slice(0, 2).map(p => p[0].toUpperCase()).join('');
  return iniciales || '👤';
}

function obtenerPrimerNombre(nombreCompleto) {
  const partes = (nombreCompleto || '').trim().split(/\s+/).filter(Boolean);
  if (partes.length === 0) return '';
  // Capitalizamos solo la primera letra; el resto puede venir en mayúsculas
  // desde la BD (algunos clientes se guardaron con .toUpperCase()).
  const primero = partes[0].toLowerCase();
  return primero.charAt(0).toUpperCase() + primero.slice(1);
}

export function AppHeader({ nombreCliente, onBellClick }) {
  const iniciales   = obtenerIniciales(nombreCliente);
  const primerNombre = obtenerPrimerNombre(nombreCliente);

  return (
    <header className="app-header">
      <div className="app-header-inner">
        <div className="app-header-avatar" aria-hidden="true">
          {iniciales}
        </div>

        <div className="app-header-greeting">
          {primerNombre ? `¡Hola, ${primerNombre}!` : '¡Hola!'}
        </div>

        <button
          type="button"
          className="app-header-bell"
          onClick={onBellClick}
          aria-label="Notificaciones"
        >
          <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path
              d="M12 3.5c-3.04 0-5.5 2.46-5.5 5.5v3.1c0 .58-.2 1.14-.57 1.59L4.9 15.03c-.7.85-.09 2.12 1.01 2.12h12.18c1.1 0 1.71-1.27 1.01-2.12l-1.03-1.34a2.5 2.5 0 0 1-.57-1.59V9c0-3.04-2.46-5.5-5.5-5.5Z"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M9.5 19a2.5 2.5 0 0 0 5 0"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span className="app-header-bell-dot" />
        </button>
      </div>
    </header>
  );
}
