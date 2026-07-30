import { useState } from 'react';
import { supabase } from '../services/supabaseClient';

/**
 * ResetPassword — paso final del flujo de "Olvidé mi contraseña".
 *
 * Se muestra ÚNICAMENTE cuando App.jsx detecta el evento PASSWORD_RECOVERY
 * de supabase.auth.onAuthStateChange (el usuario volvió del link que le
 * llegó por correo). En ese momento ya existe una sesión TEMPORAL de
 * recuperación creada automáticamente por Supabase (gracias a
 * `detectSessionInUrl: true` en supabaseClient.js), así que updateUser()
 * puede cambiar la contraseña sin pedir la anterior.
 *
 * Props:
 *   onDone → se llama cuando la contraseña quedó guardada. App.jsx la usa
 *            para apagar `passwordRecovery` y devolver el control al flujo
 *            normal — como la sesión de recuperación YA es una sesión
 *            válida, el usuario queda con la sesión iniciada, sin pasos
 *            adicionales.
 */
export const ResetPassword = ({ onDone }) => {
  const [password, setPassword]   = useState('');
  const [password2, setPassword2] = useState('');
  const [loading, setLoading]     = useState(false);
  const [mensaje, setMensaje]     = useState(null); // { tipo: 'ok'|'error', texto }

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (loading) return;
    setMensaje(null);

    if (password.length < 6) {
      setMensaje({ tipo: 'error', texto: 'La contraseña debe tener al menos 6 caracteres.' });
      return;
    }
    if (password !== password2) {
      setMensaje({ tipo: 'error', texto: 'Las contraseñas no coinciden.' });
      return;
    }

    setLoading(true);
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) {
        setMensaje({ tipo: 'error', texto: error.message });
        return;
      }
      setMensaje({ tipo: 'ok', texto: 'Contraseña actualizada. ¡Ya puedes continuar!' });
      // Pequeña pausa para que el usuario alcance a leer el mensaje de éxito
      // antes de volver al flujo normal de la app.
      setTimeout(() => onDone?.(), 900);
    } catch (err) {
      console.error('[ResetPassword] Error al actualizar contraseña:', err);
      setMensaje({ tipo: 'error', texto: 'Hubo un problema al actualizar tu contraseña. Intenta de nuevo.' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={styles.card}>
      <div style={styles.header}>
        <h2 style={styles.title}>Restablecer contraseña en LoyalPass</h2>
        <p style={styles.subtitle}>Elige una nueva contraseña para tu cuenta</p>
      </div>

      {mensaje && (
        <div style={mensaje.tipo === 'error' ? styles.alertError : styles.alertOk}>
          {mensaje.texto}
        </div>
      )}

      <form onSubmit={handleSubmit}>
        <div style={styles.field}>
          <label style={styles.label} htmlFor="newPassword">Nueva contraseña</label>
          <input
            id="newPassword"
            type="password"
            required
            minLength={6}
            placeholder="Mínimo 6 caracteres"
            autoComplete="new-password"
            style={styles.input}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <div style={{ ...styles.field, marginBottom: '1.25rem' }}>
          <label style={styles.label} htmlFor="newPassword2">Confirmar contraseña</label>
          <input
            id="newPassword2"
            type="password"
            required
            minLength={6}
            placeholder="Repite la contraseña"
            autoComplete="new-password"
            style={styles.input}
            value={password2}
            onChange={(e) => setPassword2(e.target.value)}
          />
        </div>
        <button
          type="submit"
          disabled={loading}
          style={{ ...styles.btnJoin, opacity: loading ? 0.75 : 1 }}
        >
          {loading ? 'Guardando…' : 'Guardar contraseña'}
        </button>
      </form>
    </div>
  );
};

/* ── Inline styles (mismo patrón que AuthScreen.jsx / RegistrationForm.jsx) ── */
const styles = {
  card: {
    background: 'var(--bg-card)',
    padding: '1.75rem',
    borderRadius: 'var(--r-xl)',
    border: '1px solid var(--border)',
    boxShadow: 'var(--shadow-card)',
    width: '100%',
  },
  header: { marginBottom: '1.25rem' },
  title: {
    fontFamily: 'var(--font-display)',
    fontSize: '1.3rem',
    fontWeight: 700,
    color: 'var(--text-h)',
    marginBottom: 4,
  },
  subtitle: { fontSize: '0.85rem', color: 'var(--text)', opacity: 0.8 },
  field: { marginBottom: '1rem' },
  label: {
    display: 'block',
    fontSize: '10px',
    fontWeight: 600,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: 'var(--text)',
    opacity: 0.7,
    marginBottom: 5,
  },
  input: {
    width: '100%',
    padding: '11px 14px',
    fontSize: 16, /* evita zoom en iPhone */
    fontFamily: 'var(--font-body)',
    fontWeight: 400,
    background: 'var(--bg-subtle)',
    border: '1.5px solid var(--border)',
    borderRadius: 'var(--r-md)',
    color: 'var(--text-h)',
    outline: 'none',
    transition: 'border-color 0.2s, box-shadow 0.2s',
  },
  btnJoin: {
    display: 'block',
    width: '100%',
    padding: '13px',
    marginTop: '4px',
    background: 'var(--coral)',
    color: 'white',
    border: 'none',
    borderRadius: 'var(--r-md)',
    fontFamily: 'var(--font-display)',
    fontWeight: 700,
    fontSize: '0.9rem',
    letterSpacing: '0.05em',
    textTransform: 'uppercase',
    cursor: 'pointer',
    boxShadow: 'var(--shadow-btn)',
    transition: 'background 0.2s, transform 0.1s',
  },
  alertError: {
    background: 'rgba(220,80,50,0.1)',
    color: 'var(--coral, #e04a2f)',
    border: '1px solid rgba(220,80,50,0.25)',
    borderRadius: 'var(--r-md)',
    padding: '10px 12px',
    fontSize: '0.8rem',
    marginBottom: '1rem',
    lineHeight: 1.4,
  },
  alertOk: {
    background: 'rgba(60,160,90,0.1)',
    color: '#2f8a52',
    border: '1px solid rgba(60,160,90,0.25)',
    borderRadius: 'var(--r-md)',
    padding: '10px 12px',
    fontSize: '0.8rem',
    marginBottom: '1rem',
    lineHeight: 1.4,
  },
};
