import { useState } from 'react';
import { supabase, establecerPreferenciaSesion, vincularClienteConRestaurante } from '../services/supabaseClient';

/**
 * AuthScreen — reemplaza al antiguo RegistrationForm como puerta de entrada
 * a la app. Maneja 3 flujos (más un 4to interno de recuperación):
 *
 *   'login'    → Correo + Contraseña (autenticación directa contra Supabase Auth).
 *   'register' → Nombre + Teléfono (obligatorio) + Email + Contraseña (crea una
 *                cuenta real en Supabase Auth y la vincula a este restaurante).
 *   'reset'    → Recuperar contraseña por email (supabase.auth.resetPasswordForEmail).
 *
 * Props:
 *   restaurantId   → id del restaurante actual (para vincular al cliente).
 *   referidoPor    → nombre de quien lo invitó (query param ?ref=), si aplica.
 *   onSuccess(id, nombre, puntos) → mismo contrato que el RegistrationForm
 *                                   original: App.jsx lo usa para pasar a
 *                                   la pantalla de bienvenida.
 *   recoveryMode   → true cuando App.jsx detecta el evento PASSWORD_RECOVERY
 *                    (el usuario volvió del link de "recuperar contraseña"
 *                    en su correo). Muestra directamente el formulario de
 *                    "nueva contraseña", sin pasar por login/registro.
 *   onRecoveryDone → se llama cuando la contraseña nueva quedó guardada.
 */
export const AuthScreen = ({ restaurantId, referidoPor, onSuccess, recoveryMode = false, onRecoveryDone }) => {
  // 'login' | 'register' | 'reset' | 'recovery'
  const [modo, setModo] = useState(recoveryMode ? 'recovery' : 'login');

  const [loading, setLoading] = useState(false);
  const [mensaje, setMensaje] = useState(null); // { tipo: 'ok'|'error', texto }

  // Campos compartidos entre los distintos formularios
  const [nombre,   setNombre]   = useState('');
  const [telefono, setTelefono] = useState('');
  const [email,    setEmail]    = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState(''); // confirmación (registro y recovery)
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
      // en cuanto detecta la sesión nueva (vincula/crea el cliente en este
      // restaurante y muestra el dashboard o la bienvenida).
    } catch (err) {
      console.error('[AuthScreen] Error en login:', err);
      setMensaje({ tipo: 'error', texto: 'Hubo un problema al iniciar sesión. Intenta de nuevo.' });
    } finally {
      setLoading(false);
    }
  };

  // ── REGISTRO: Nombre + Correo + Contraseña ─────────────────────────────
  const handleRegister = async (e) => {
    e.preventDefault();
    if (loading) return;
    limpiarMensaje();

    if (!nombre.trim() || !telefono.trim() || !email.trim() || !password) {
      setMensaje({ tipo: 'error', texto: 'Completa todos los campos.' });
      return;
    }
    if (!/^\d{10}$/.test(telefono.trim())) {
      setMensaje({ tipo: 'error', texto: 'El teléfono debe tener 10 dígitos, ej: 3206587850.' });
      return;
    }
    if (password.length < 6) {
      setMensaje({ tipo: 'error', texto: 'La contraseña debe tener al menos 6 caracteres.' });
      return;
    }

    setLoading(true);
    try {
      establecerPreferenciaSesion(mantenerSesion);

      // 1) Crear la cuenta en Supabase Auth. Guardamos nombre y teléfono en
      //    los metadatos del usuario (user_metadata) para poder usarlos
      //    después al crear su fila en `clientes`, sin volver a pedirlos.
      //    El teléfono es obligatorio: es el dato con el que el restaurante
      //    (mesero/admin) identifica al cliente en caja.
      const { data, error } = await supabase.auth.signUp({
        email: email.trim().toLowerCase(),
        password,
        options: {
          data: { nombre: nombre.trim(), telefono: telefono.trim() },
        },
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

      // 2) Si el proyecto de Supabase tiene "Confirmar email" activado,
      //    signUp() NO devuelve sesión todavía (data.session es null) y el
      //    usuario debe hacer clic en el correo de confirmación primero.
      //    En ese caso avisamos y no creamos su fila en `clientes` aún:
      //    App.jsx la creará automáticamente la primera vez que inicie
      //    sesión (ver onAuthStateChange en App.jsx).
      if (!data.session) {
        setMensaje({
          tipo: 'ok',
          texto: 'Cuenta creada. Revisa tu correo para confirmar tu cuenta y luego inicia sesión.',
        });
        setModo('login');
        return;
      }

      // 3) Si NO hay confirmación de email requerida, ya tenemos sesión.
      //    Si esta pantalla tiene un `restaurantId` (el usuario entró por el
      //    link/QR de una sede específica), lo inscribimos de una vez ahí y
      //    avisamos a App.jsx (misma firma que usaba RegistrationForm) para
      //    que muestre la bienvenida con los puntos ganados.
      //    Si NO hay restaurantId (alta desde el gate global, antes del
      //    buscador), no hay nada más que hacer: la cuenta ya quedó creada
      //    y App.jsx detecta la sesión nueva solo, vía onAuthStateChange,
      //    y navega al buscador de restaurantes.
      if (restaurantId) {
        const { cliente } = await vincularClienteConRestaurante({
          user: data.user,
          restauranteId: restaurantId,
          referidoPor,
        });
        onSuccess?.(cliente.id, cliente.nombre, cliente.puntos);
      }
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

  // ── RECOVERY: guardar la nueva contraseña (paso final tras el link) ────
  const handleSetNewPassword = async (e) => {
    e.preventDefault();
    if (loading) return;
    limpiarMensaje();

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
      // En este punto ya existe una sesión temporal de "recuperación" creada
      // automáticamente por detectSessionInUrl al volver del correo, así que
      // updateUser() cambia la contraseña de ESE usuario sin pedir la vieja.
      const { error } = await supabase.auth.updateUser({ password });
      if (error) {
        setMensaje({ tipo: 'error', texto: error.message });
        return;
      }
      setMensaje({ tipo: 'ok', texto: 'Contraseña actualizada. ¡Ya puedes continuar!' });
      onRecoveryDone?.();
    } catch (err) {
      console.error('[AuthScreen] Error al actualizar contraseña:', err);
      setMensaje({ tipo: 'error', texto: 'Hubo un problema al actualizar tu contraseña.' });
    } finally {
      setLoading(false);
    }
  };

  const cambiarModo = (nuevoModo) => {
    setModo(nuevoModo);
    limpiarMensaje();
    setTelefono('');
    setPassword('');
    setPassword2('');
  };

  return (
    <div style={styles.card}>
      {/* Header dinámico según el modo */}
      <div style={styles.header}>
        <h2 style={styles.title}>
          {modo === 'login'    && 'Inicia sesión'}
          {modo === 'register' && 'Crea tu perfil'}
          {modo === 'reset'    && 'Recuperar contraseña'}
          {modo === 'recovery' && 'Nueva contraseña'}
        </h2>
        <p style={styles.subtitle}>
          {modo === 'login'    && '¿Ya tienes cuenta? Ingresa con tu correo.'}
          {modo === 'register' && (restaurantId
            ? 'Regístrate hoy y gana tus primeros 2 puntos'
            : 'Crea tu cuenta única para todos los restaurantes')}
          {modo === 'reset'    && 'Te enviaremos un link a tu correo'}
          {modo === 'recovery' && 'Elige una nueva contraseña para tu cuenta'}
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
            <label style={styles.label} htmlFor="regNombre">Nombre completo</label>
            <input id="regNombre" type="text" required placeholder="Ej: Juan Pérez"
              style={styles.input} value={nombre} onChange={(e) => setNombre(e.target.value)} />
          </div>
          <div style={styles.field}>
            <label style={styles.label} htmlFor="regTelefono">Teléfono / WhatsApp</label>
            <input id="regTelefono" type="tel" required pattern="[0-9]{10}" placeholder="Ej: 3206587850"
              style={styles.input} value={telefono} onChange={(e) => setTelefono(e.target.value)} />
          </div>
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

      {/* ── NUEVA CONTRASEÑA (después de hacer clic en el correo) ── */}
      {modo === 'recovery' && (
        <form onSubmit={handleSetNewPassword}>
          <div style={styles.field}>
            <label style={styles.label} htmlFor="newPassword">Nueva contraseña</label>
            <input id="newPassword" type="password" required minLength={6} placeholder="Mínimo 6 caracteres"
              style={styles.input} value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <div style={{ ...styles.field, marginBottom: '1.25rem' }}>
            <label style={styles.label} htmlFor="newPassword2">Confirmar contraseña</label>
            <input id="newPassword2" type="password" required minLength={6} placeholder="Repite la contraseña"
              style={styles.input} value={password2} onChange={(e) => setPassword2(e.target.value)} />
          </div>
          <button type="submit" disabled={loading} style={{ ...styles.btnJoin, opacity: loading ? 0.75 : 1 }}>
            {loading ? 'Guardando…' : 'Guardar contraseña'}
          </button>
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
