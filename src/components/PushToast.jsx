/**
 * PushToast.jsx — LoyalPass (bistro-app)
 * ────────────────────────────────────────────────────────────────────────
 * Toast flotante, elegante y NO invasivo para notificaciones push (FCM)
 * que llegan con la app YA ABIERTA. Android, por diseño, no muestra un push
 * de tipo `notification` automáticamente cuando la app está en primer
 * plano — solo dispara el evento JS `pushNotificationReceived` y espera
 * que la app decida qué hacer. Antes de este componente ese evento no
 * tenía ningún listener: el push llegaba y no pasaba NADA visible mientras
 * el usuario tenía la app abierta.
 *
 * Se auto-monta una sola vez fuera de <App/> (mismo patrón que
 * `GuiaPermisosModal`/`BatteryOptimizationGuide`: se controla por completo
 * vía su propio evento de `window`, sin depender de ningún estado de
 * App.jsx) y `usePushNotifications.js` lo alimenta llamando a
 * `dispararToastPush()` desde el listener `pushNotificationReceived`.
 */
import { useState, useEffect, useRef } from 'react';

const EVENTO_PUSH_RECIBIDO = 'loyalpass_push_recibido';
const DURACION_MS = 4500;

/** Dispara el toast desde cualquier parte de la app (usado por usePushNotifications.js). */
export function dispararToastPush({ titulo, cuerpo }) {
  try {
    window.dispatchEvent(new CustomEvent(EVENTO_PUSH_RECIBIDO, { detail: { titulo, cuerpo } }));
  } catch {
    // entorno sin `window` (SSR/tests) — no-op
  }
}

export function PushToast() {
  const [toast, setToast] = useState(null);
  const timeoutRef = useRef(null);

  useEffect(() => {
    const handler = (e) => {
      setToast(e.detail);
      clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => setToast(null), DURACION_MS);
    };
    window.addEventListener(EVENTO_PUSH_RECIBIDO, handler);
    return () => {
      window.removeEventListener(EVENTO_PUSH_RECIBIDO, handler);
      clearTimeout(timeoutRef.current);
    };
  }, []);

  if (!toast) return null;

  return (
    <div
      style={estilos.wrapper}
      role="status"
      aria-live="polite"
      onClick={() => setToast(null)}
    >
      <span style={estilos.icono}>🔔</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        {toast.titulo && <div style={estilos.titulo}>{toast.titulo}</div>}
        {toast.cuerpo && <div style={estilos.cuerpo}>{toast.cuerpo}</div>}
      </div>
    </div>
  );
}

/* ── Estilos — tema "Luxury Charcoal & Gold", mismos tokens que
   GuiaPermisosModal.jsx / BuscadorRestaurantes.jsx ── */
const estilos = {
  wrapper: {
    position: 'fixed',
    top: 'calc(env(safe-area-inset-top, 0px) + 12px)',
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: 3000,
    width: 'calc(100% - 24px)',
    maxWidth: 420,
    display: 'flex',
    alignItems: 'flex-start',
    gap: 10,
    background: 'var(--luxury-dark, #121212)',
    border: '1px solid var(--luxury-gold, #D4AF37)',
    borderRadius: 'var(--r-lg, 16px)',
    padding: '12px 14px',
    boxShadow: '0 12px 34px rgba(0,0,0,0.55)',
    cursor: 'pointer',
  },
  icono: { fontSize: '1.2rem', flexShrink: 0, lineHeight: 1.3 },
  titulo: {
    fontFamily: 'var(--font-display)',
    fontWeight: 800,
    fontSize: '0.88rem',
    color: 'var(--text-h, #FBF8EE)',
  },
  cuerpo: {
    fontSize: '0.78rem',
    color: 'var(--text, rgba(245,245,220,0.75))',
    marginTop: 2,
    lineHeight: 1.4,
  },
};
