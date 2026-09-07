/**
 * BottomNav.jsx
 * Barra de navegación inferior fija con 4 pestañas: Inicio, Recompensas,
 * Pagos y Cuenta. Solo "Inicio" tiene contenido real por ahora — las otras
 * tres muestran una pantalla de "Próximamente" (ver ComingSoonScreen.jsx).
 */

const ICONOS = {
  inicio: (
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M4 11.5 12 4l8 7.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M6 10v8.5a1 1 0 0 0 1 1h3.2v-5.2h3.6v5.2H17a1 1 0 0 0 1-1V10" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  recompensas: (
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="4" y="9.5" width="16" height="10" rx="1.2" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      <path d="M4 12.5h16" stroke="currentColor" strokeWidth="1.7" />
      <path d="M12 9.5v10" stroke="currentColor" strokeWidth="1.7" />
      <path d="M12 9.5H9.2a2 2 0 1 1 0-4c1.8 0 2.8 2 2.8 4Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      <path d="M12 9.5h2.8a2 2 0 1 0 0-4c-1.8 0-2.8 2-2.8 4Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
    </svg>
  ),
  pagos: (
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="3.5" y="6" width="17" height="12.5" rx="1.8" stroke="currentColor" strokeWidth="1.7" />
      <path d="M3.5 10h17" stroke="currentColor" strokeWidth="1.7" />
      <path d="M6.5 14.3h4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  ),
  cuenta: (
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="12" cy="8.3" r="3.3" stroke="currentColor" strokeWidth="1.7" />
      <path d="M5 19c0-3.2 3.1-5.5 7-5.5s7 2.3 7 5.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  ),
};

const TABS = [
  { id: 'inicio',      label: 'Inicio' },
  { id: 'recompensas', label: 'Recompensas' },
  { id: 'pagos',       label: 'Pagos' },
  { id: 'cuenta',      label: 'Cuenta' },
];

export function BottomNav({ active, onChange }) {
  return (
    <nav className="bottom-nav">
      <div className="bottom-nav-inner">
        {TABS.map(tab => (
          <button
            key={tab.id}
            type="button"
            className={`bottom-nav-item${active === tab.id ? ' active' : ''}`}
            onClick={() => onChange(tab.id)}
            aria-current={active === tab.id ? 'page' : undefined}
          >
            {ICONOS[tab.id]}
            <span>{tab.label}</span>
          </button>
        ))}
      </div>
    </nav>
  );
}
