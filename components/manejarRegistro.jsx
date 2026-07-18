import { useEffect } from 'react';
import { supabase }  from '../services/supabaseClient';

/**
 * SuccessCard — pantalla mostrada justo después de un registro exitoso.
 * Props:
 *   restauranteId, nombreRestaurante, nombreCliente,
 *   clienteId, puntosActuales, onClose
 */
export const SuccessCard = ({
  restauranteId,
  nombreRestaurante,
  nombreCliente,
  clienteId,
  puntosActuales = 2,
  onClose,
}) => {
  // Notificación de bienvenida (best-effort)
  useEffect(() => {
    const enviarNotificacion = async () => {
      if (!('Notification' in window)) return;
      if (Notification.permission !== 'granted') return;
      try {
        const reg = await navigator.serviceWorker.ready;
        reg.showNotification(`¡Bienvenido a ${nombreRestaurante}! 🎉`, {
          body:    `Has ganado tus primeros ${puntosActuales} puntos. ¡Sigue visitándonos!`,
          icon:    '/icon-192.png',
          badge:   '/icon-72.png',
          vibrate: [100, 50, 100],
        });
      } catch {}
    };
    enviarNotificacion();
  }, [nombreRestaurante, puntosActuales]);

  // Registrar referido si aplica
  useEffect(() => {
    const registrarReferido = async () => {
      if (!restauranteId || !clienteId) return;
      try {
        const { data: cliente } = await supabase
          .from('clientes').select('referidopor').eq('id', clienteId).maybeSingle();
        if (!cliente?.referidopor || cliente.referidopor === 'Directo (QR local)') return;

        const { data: referidor } = await supabase
          .from('clientes')
          .select('id, puntos, nombre')
          .eq('nombre', cliente.referidopor)
          .eq('restaurante_id', restauranteId)
          .maybeSingle();

        if (referidor) {
          await supabase
            .from('clientes')
            .update({ puntos: (referidor.puntos || 0) + 1 })
            .eq('id', referidor.id);
        }
      } catch {}
    };
    registrarReferido();
  }, [restauranteId, clienteId]);

  const compartirWhatsApp = () => {
    const url = `${window.location.origin}/?r=${restauranteId}&ref=${encodeURIComponent(nombreCliente)}`;
    const msg =
      `🎉 ¡Me acabo de unir al club de *${nombreRestaurante}*!\n\n` +
      `Visítalos y acumula puntos para ganar premios. Usa mi enlace:\n${url}`;
    window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, '_blank');
  };

  return (
    <div style={styles.wrapper}>
      <div style={styles.card}>
        {/* Icono */}
        <div style={styles.iconWrap}>
          <span style={styles.icon}>🎉</span>
        </div>

        <h2 style={styles.heading}>
          ¡Bienvenido,<br />{nombreCliente?.split(' ')[0]}!
        </h2>
        <p style={styles.sub}>
          Ya eres parte del club <strong>{nombreRestaurante}</strong>.
        </p>

        {/* Puntos ganados */}
        <div style={styles.pointsBadge}>
          <span style={styles.pointsNum}>+{puntosActuales}</span>
          <span style={styles.pointsLabel}>puntos de bienvenida</span>
        </div>

        {/* Cómo funciona */}
        <div style={styles.stepsCard}>
          <p style={styles.stepsTitle}>¿Cómo funciona?</p>
          {[
            { icon: '📍', text: 'Visítanos y confirma tu llegada con GPS' },
            { icon: '🔐', text: 'Ingresa el PIN del mesero para sumar puntos' },
            { icon: '🎁', text: 'Con 20 puntos ganas un premio exclusivo' },
          ].map(({ icon, text }) => (
            <div key={text} style={styles.stepRow}>
              <span style={styles.stepIcon}>{icon}</span>
              <span style={styles.stepText}>{text}</span>
            </div>
          ))}
        </div>

        {/* CTAs */}
        <button onClick={compartirWhatsApp} style={styles.btnWhatsapp}>
          📢 Compartir e invitar amigos
        </button>
        <button onClick={onClose} style={styles.btnSecondary}>
          Ver mi perfil →
        </button>
      </div>
    </div>
  );
};

const styles = {
  wrapper: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '100vh',
    padding: '1.5rem 1rem',
    background: 'var(--bg-subtle)',
  },
  card: {
    background: 'var(--bg-card)',
    borderRadius: 'var(--r-xl)',
    border: '1px solid var(--border)',
    boxShadow: 'var(--shadow-card)',
    padding: '2rem 1.75rem',
    width: '100%',
    maxWidth: 420,
    textAlign: 'center',
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
  },
  iconWrap: {
    width: 72, height: 72,
    background: 'var(--coral-light)',
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    margin: '0 auto',
  },
  icon:  { fontSize: '2rem' },
  heading: {
    fontFamily: 'var(--font-display)',
    fontSize: '1.6rem',
    fontWeight: 800,
    color: 'var(--text-h)',
    letterSpacing: '-0.02em',
    lineHeight: 1.15,
    margin: 0,
  },
  sub: { fontSize: '0.9rem', color: 'var(--text)', margin: 0 },
  pointsBadge: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    background: 'var(--coral-light)',
    border: '1px solid var(--coral-border)',
    borderRadius: 'var(--r-lg)',
    padding: '1rem',
    gap: 4,
  },
  pointsNum: {
    fontFamily: 'var(--font-display)',
    fontSize: '2.5rem',
    fontWeight: 800,
    color: 'var(--coral)',
    lineHeight: 1,
  },
  pointsLabel: { fontSize: '0.8rem', color: 'var(--text)', fontWeight: 500 },
  stepsCard: {
    background: 'var(--bg-subtle)',
    borderRadius: 'var(--r-lg)',
    padding: '1rem 1.25rem',
    textAlign: 'left',
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
  },
  stepsTitle: {
    fontSize: '10px',
    fontWeight: 700,
    letterSpacing: '0.1em',
    textTransform: 'uppercase',
    color: 'var(--text)',
    opacity: 0.5,
    margin: 0,
  },
  stepRow: { display: 'flex', alignItems: 'flex-start', gap: '10px' },
  stepIcon: { fontSize: '1rem', lineHeight: 1.4, flexShrink: 0 },
  stepText: { fontSize: '0.875rem', color: 'var(--text)', lineHeight: 1.45 },
  btnWhatsapp: {
    width: '100%',
    padding: '13px',
    background: '#25D366',
    color: 'white',
    border: 'none',
    borderRadius: 'var(--r-md)',
    fontFamily: 'var(--font-display)',
    fontWeight: 700,
    fontSize: '0.875rem',
    letterSpacing: '0.04em',
    cursor: 'pointer',
    textTransform: 'uppercase',
  },
  btnSecondary: {
    width: '100%',
    padding: '11px',
    background: 'var(--bg-subtle)',
    color: 'var(--text-h)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--r-md)',
    fontFamily: 'var(--font-body)',
    fontWeight: 600,
    fontSize: '0.875rem',
    cursor: 'pointer',
  },
};
