/**
 * AppHeader.jsx
 * Header superior fijo de la app: avatar con iniciales del cliente,
 * saludo con su primer nombre, y campana de notificaciones.
 *
 * Centro de Notificaciones: la campana ahora abre el drawer real
 * (CentroNotificaciones.jsx, montado en App.jsx) y el puntito dorado es un
 * contador real de no leídas —viene del hook useNotificaciones, instanciado
 * una sola vez en App.jsx y pasado aquí por la prop `unreadCount`— en vez
 * del indicador estático que había antes de implementar la bandeja.
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

export function AppHeader({ nombreCliente, avatarUrl, unreadCount = 0, onBellClick }) {
  const iniciales   = obtenerIniciales(nombreCliente);
  const primerNombre = obtenerPrimerNombre(nombreCliente);
  const hayNoLeidas = unreadCount > 0;

  return (
    <header className="app-header">
      <div className="app-header-inner">
        {/* Foto de perfil (clientes.avatar_url, subida desde CuentaScreen.jsx)
            con borde dorado; si el cliente no tiene foto todavía, se
            mantienen las iniciales de siempre — mismo tamaño/posición, sin
            layout shift al llegar la foto. */}
        {avatarUrl ? (
          <img
            src={avatarUrl}
            alt={nombreCliente || 'Perfil'}
            className="app-header-avatar-img"
          />
        ) : (
          <div className="app-header-avatar" aria-hidden="true">
            {iniciales}
          </div>
        )}

        <div className="app-header-greeting">
          {primerNombre ? `¡Hola, ${primerNombre}!` : '¡Hola!'}
        </div>

        <button
          type="button"
          className="app-header-bell"
          onClick={onBellClick}
          aria-label={hayNoLeidas ? `Notificaciones (${unreadCount} sin leer)` : 'Notificaciones'}
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
          {hayNoLeidas && <span className="app-header-bell-dot" />}
        </button>
      </div>
    </header>
  );
}
