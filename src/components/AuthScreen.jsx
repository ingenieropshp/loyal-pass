import { useState } from 'react';
import { supabase, establecerPreferenciaSesion } from '../services/supabaseClient';

/**
 * AuthScreen — puerta de entrada GLOBAL a la app (Etapa 1 del flujo).
 * Maneja únicamente la cuenta única de Supabase Auth, identificada por
 * correo electrónico — nunca pide ni guarda datos propios de un
 * restaurante (nombre para el mesero, teléfono, fecha de nacimiento).
 * Esos se piden después, por separado, en RegistrationForm ("Crea tu
 * perfil"), la primera vez que el usuario elige unirse a un restaurante
 * en concreto.
 *
 * Maneja 3 flujos:
 *   'login'    → Correo + Contraseña (autenticación directa contra Supabase Auth).
 *   'register' → Correo + Contraseña (crea la cuenta única y global).
 *   'reset'    → Recuperar contraseña por email (supabase.auth.resetPasswordForEmail).
 *
 * El 4to paso ("nueva contraseña", cuando el usuario vuelve del link del
 * correo) vive por separado en ResetPassword.jsx — App.jsx lo muestra
 * directamente en cuanto detecta el evento PASSWORD_RECOVERY, sin pasar
 * por este componente.
 *
 * Props:
 *   restaurantId → id del restaurante desde el que se abrió el link (si
 *                  aplica). No se usa para inscribir a nadie aquí — solo
 *                  se conserva por si se necesita contexto de sede.
 *
 * NOTA: no necesita un onSuccess para login/registro — en cuanto Supabase
 * crea la sesión, App.jsx la detecta solo vía onAuthStateChange y decide
 * a dónde navegar (buscador de restaurantes, o el formulario/dashboard de
 * la sede si venía de un link ?r=).
 */
export const AuthScreen = ({ restaurantId }) => {
  // 'login' | 'register' | 'reset'
  const [modo, setModo] = useState('login');

  const [loading, setLoading] = useState(false);
  const [mensaje, setMensaje] = useState(null); // { tipo: 'ok'|'error', texto }

  // Campos compartidos entre los distintos formularios
  const [email,    setEmail]    = useState('');
  const [password, setPassword] = useState('');
  const [mantenerSesion, setMantenerSesion] = useState(true); // checkbox "Mantener sesión iniciada"

  const limpiarMensaje = () => setMensaje(null);

  // ── LOGIN: Correo + Contraseña ─────────────────────────────────────────
  const handleLogin = async (e) => {
    e.preventDefault();
    if (loading) return;
    limpiarMensaje();

    if (!email.trim() || !password) {
      setMensaje({ tipo: 'error', texto: 'Completa tu correo y contraseña.' });
      return;
    }

    setLoading(true);
    try {
      // Antes de autenticar, guardamos la preferencia de "mantener sesión":
      // el storage adapter de supabaseClient.js la lee justo cuando Supabase
      // guarda el token nuevo, y decide entre localStorage o sessionStorage.
      establecerPreferenciaSesion(mantenerSesion);

      const { error } = await supabase.auth.signInWithPassword({
        email: email.trim().toLowerCase(),
        password,
      });
      if (error) {
        setMensaje({ tipo: 'error', texto: 'Correo o contraseña incorrectos. Intenta de nuevo.' });
        return;
      }
      // No hace falta hacer nada más aquí: App.jsx escucha
      // supabase.auth.onAuthStateChange y toma el control automáticamente
      // en cuanto detecta la sesión nueva (verifica si ya está inscrito en
      // esta sede y muestra el dashboard, o "Crea tu perfil" si no).
    } catch (err) {
      console.error('[AuthScreen] Error en login:', err);
      setMensaje({ tipo: 'error', texto: 'Hubo un problema al iniciar sesión. Intenta de nuevo.' });
    } finally {
      setLoading(false);
    }
  };

  // ── REGISTRO GLOBAL: solo Correo + Contraseña ──────────────────────────
  // Esta cuenta es única para toda la app — NO pertenece a ningún
  // restaurante todavía. Los datos propios de cada sede (nombre para el
  // mesero, teléfono, fecha de nacimiento) se piden después, por
  // separado, en RegistrationForm ("Crea tu perfil"), cuando el usuario
  // decide unirse a un restaurante puntual.
  const handleRegister = async (e) => {
    e.preventDefault();
    if (loading) return;
    limpiarMensaje();

    if (!email.trim() || !password) {
      setMensaje({ tipo: 'error', texto: 'Completa tu correo y contraseña.' });
      return;
    }
    if (password.length < 6) {
      setMensaje({ tipo: 'error', texto: 'La contraseña debe tener al menos 6 caracteres.' });
      return;
    }

    setLoading(true);
    try {
      establecerPreferenciaSesion(mantenerSesion);

      // Crear la cuenta global en Supabase Auth. Ya no guardamos nombre ni
      // teléfono en user_metadata: esos son datos LOCALES de cada
      // restaurante y se capturan más adelante, por sede, en
      // RegistrationForm.
      const { data, error } = await supabase.auth.signUp({
        email: email.trim().toLowerCase(),
        password,
      });
      if (error) {
        if (error.message?.toLowerCase().includes('already registered') ||
            error.message?.toLowerCase().includes('already been registered')) {
          setMensaje({ tipo: 'error', texto: 'Ya existe una cuenta con ese email. Intenta iniciar sesión.' });
        } else {
          setMensaje({ tipo: 'error', texto: error.message });
        }
        return;
      }

      // Si el proyecto de Supabase tiene "Confirmar email" activado,
      // signUp() NO devuelve sesión todavía (data.session es null) y el
      // usuario debe hacer clic en el correo de confirmación primero.
      if (!data.session) {
        setMensaje({
          tipo: 'ok',
          texto: 'Cuenta creada. Revisa tu correo para confirmar tu cuenta y luego inicia sesión.',
        });
        setModo('login');
        return;
      }

      // Si NO hay confirmación de email requerida, ya tenemos sesión.
      // No hace falta hacer nada más aquí: App.jsx escucha
      // supabase.auth.onAuthStateChange y navega solo — al buscador de
      // restaurantes, o al formulario "Crea tu perfil" de la sede si el
      // usuario venía de un link/QR (?r=) — sin inscribirlo en ningún
      // restaurante todavía.
    } catch (err) {
      console.error('[AuthScreen] Error en registro:', err);
      setMensaje({ tipo: 'error', texto: 'Hubo un problema al crear tu cuenta. Intenta de nuevo.' });
    } finally {
      setLoading(false);
    }
  };

  // ── RECUPERAR CONTRASEÑA: envío del correo ─────────────────────────────
  const handleReset = async (e) => {
    e.preventDefault();
    if (loading) return;
    limpiarMensaje();

    if (!email.trim()) {
      setMensaje({ tipo: 'error', texto: 'Escribe tu correo electrónico.' });
      return;
    }

    setLoading(true);
    try {
      // redirectTo: la URL a la que Supabase regresa al usuario después de
      // hacer clic en el link del correo. Usamos la misma página actual
      // (incluye ?r= del restaurante) para que, al volver, App.jsx detecte
      // el evento PASSWORD_RECOVERY y muestre el formulario de "nueva
      // contraseña" sin perder el contexto del restaurante.
      const { error } = await supabase.auth.resetPasswordForEmail(email.trim().toLowerCase(), {
        redirectTo: window.location.href,
      });
      if (error) {
        setMensaje({ tipo: 'error', texto: error.message });
        return;
      }
      setMensaje({
        tipo: 'ok',
        texto: 'Te enviamos un correo con el link para restablecer tu contraseña.',
      });
    } catch (err) {
      console.error('[AuthScreen] Error en reset:', err);
      setMensaje({ tipo: 'error', texto: 'Hubo un problema al enviar el correo. Intenta de nuevo.' });
    } finally {
      setLoading(false);
    }
  };

  const cambiarModo = (nuevoModo) => {
    setModo(nuevoModo);
    limpiarMensaje();
    setPassword('');
  };

  return (
    <div style={styles.card}>
      {/* Header dinámico según el modo */}
      <div style={styles.header}>
        <h2 style={styles.title}>
          {modo === 'login'    && 'Inicia sesión'}
          {modo === 'register' && 'Crea tu cuenta'}
          {modo === 'reset'    && 'Recuperar contraseña'}
        </h2>
        <p style={styles.subtitle}>
          {modo === 'login'    && '¿Ya tienes cuenta? Ingresa con tu correo.'}
          {modo === 'register' && 'Crea tu cuenta única para descubrir y unirte a restaurantes'}
          {modo === 'reset'    && 'Te enviaremos un link a tu correo'}
        </p>
      </div>

      {/* Mensajes de estado */}
      {mensaje && (
        <div style={mensaje.tipo === 'error' ? styles.alertError : styles.alertOk}>
          {mensaje.texto}
        </div>
      )}

      {/* ── LOGIN ── */}
      {modo === 'login' && (
        <form onSubmit={handleLogin}>
          <div style={styles.field}>
            <label style={styles.label} htmlFor="loginEmail">Correo electrónico</label>
            <input id="loginEmail" type="email" required autoComplete="email" placeholder="ejemplo@correo.com"
              style={styles.input} value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div style={{ ...styles.field, marginBottom: '0.85rem' }}>
            <label style={styles.label} htmlFor="loginPassword">Contraseña</label>
            <input id="loginPassword" type="password" required autoComplete="current-password" placeholder="••••••••"
              style={styles.input} value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <label style={styles.checkboxRow}>
            <input type="checkbox" checked={mantenerSesion}
              onChange={(e) => setMantenerSesion(e.target.checked)} style={styles.checkbox} />
            Mantener sesión iniciada
          </label>
          <button type="submit" disabled={loading} style={{ ...styles.btnJoin, opacity: loading ? 0.75 : 1, marginTop: 16 }}>
            {loading ? 'Ingresando…' : 'Ingresar →'}
          </button>
          <p style={styles.linkRow}>
            <span style={styles.linkText} onClick={() => cambiarModo('reset')}>Olvidé mi contraseña</span>
            <span style={styles.linkText} onClick={() => cambiarModo('register')}>Crear cuenta nueva</span>
          </p>
        </form>
      )}

      {/* ── REGISTRO ── */}
      {modo === 'register' && (
        <form onSubmit={handleRegister}>
          <div style={styles.field}>
            <label style={styles.label} htmlFor="regEmail">Correo electrónico</label>
            <input id="regEmail" type="email" required autoComplete="email" placeholder="ejemplo@correo.com"
              style={styles.input} value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div style={{ ...styles.field, marginBottom: '0.85rem' }}>
            <label style={styles.label} htmlFor="regPassword">Contraseña</label>
            <input id="regPassword" type="password" required minLength={6} autoComplete="new-password" placeholder="Mínimo 6 caracteres"
              style={styles.input} value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <label style={styles.checkboxRow}>
            <input type="checkbox" checked={mantenerSesion}
              onChange={(e) => setMantenerSesion(e.target.checked)} style={styles.checkbox} />
            Mantener sesión iniciada
          </label>
          <button type="submit" disabled={loading} style={{ ...styles.btnJoin, opacity: loading ? 0.75 : 1, marginTop: 16 }}>
            {loading ? 'Procesando…' : 'Unirme al club →'}
          </button>
          <p style={styles.linkRow}>
            <span style={styles.linkText} onClick={() => cambiarModo('login')}>Ya tengo cuenta</span>
          </p>
        </form>
      )}

      {/* ── RECUPERAR CONTRASEÑA (envío de correo) ── */}
      {modo === 'reset' && (
        <form onSubmit={handleReset}>
          <div style={{ ...styles.field, marginBottom: '1.25rem' }}>
            <label style={styles.label} htmlFor="resetEmail">Correo electrónico</label>
            <input id="resetEmail" type="email" required placeholder="tucorreo@ejemplo.com"
              style={styles.input} value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <button type="submit" disabled={loading} style={{ ...styles.btnJoin, opacity: loading ? 0.75 : 1 }}>
            {loading ? 'Enviando…' : 'Enviar link de recuperación'}
          </button>
          <p style={styles.linkRow}>
            <span style={styles.linkText} onClick={() => cambiarModo('login')}>← Volver a iniciar sesión</span>
          </p>
        </form>
      )}
    </div>
  );
};

/* ── Inline styles (mismo patrón que RegistrationForm.jsx) ── */
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
  field:  { marginBottom: '1rem' },
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
  linkRow: {
    display: 'flex',
    justifyContent: 'space-between',
    marginTop: 14,
    flexWrap: 'wrap',
    gap: 8,
  },
  linkText: {
    fontSize: '0.75rem',
    color: 'var(--coral)',
    textDecoration: 'underline',
    cursor: 'pointer',
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
