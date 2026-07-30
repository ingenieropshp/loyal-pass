/**
 * BrandLogo.jsx — LoyalPass
 * ────────────────────────────────────────────────────────────────────────
 * Wordmark temporal en SVG mientras no haya archivos de logo oficiales.
 * Diseñado para ser fácil de reemplazar: en cuanto tengas el logo real
 * (SVG o PNG), sustituye el contenido de este componente por
 * `<img src={logoLoyalPass} alt="LoyalPass" className={className} />`
 * y el resto de la app (AuthScreen, App.jsx, AdminPanel, IOSInstallBanner)
 * lo recoge automáticamente sin tocar nada más — todos importan desde aquí.
 */
export const BrandLogo = ({ size = 40, showWordmark = true, className = '' }) => (
  <div
    className={className}
    style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}
  >
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="LoyalPass"
    >
      <rect width="40" height="40" rx="11" fill="var(--coral, #E8563A)" />
      <path
        d="M13 27V13h4.2c3.1 0 5 1.7 5 4.5s-1.9 4.5-5 4.5h-1.2V27H13Zm3-8h1c1.4 0 2.2-.7 2.2-2s-.8-2-2.2-2h-1v4Z"
        fill="#fff"
      />
      <circle cx="27.2" cy="14.5" r="2.3" fill="#fff" />
    </svg>
    {showWordmark && (
      <span
        style={{
          fontFamily: 'var(--font-display, inherit)',
          fontWeight: 800,
          fontSize: size * 0.5,
          letterSpacing: '-0.01em',
          color: 'var(--text-h, #1a1a1a)',
          lineHeight: 1,
        }}
      >
        LoyalPass
      </span>
    )}
  </div>
);
