import { useState } from 'react';
import { registrarClienteEnRestaurante } from '../services/supabaseClient';
import { getDeviceId } from '../utils/deviceId';

/**
 * RegistrationForm — "Crea tu perfil", el paso 2 (registro LOCAL) del flujo
 * de dos etapas. Solo se muestra cuando ya existe una sesión global de
 * Supabase Auth (paso 1, ver AuthScreen) y App.jsx ya verificó que ese
 * usuario todavía NO tiene una fila en `clientes` para este restaurante.
 *
 * No crea cuentas ni pide correo/contraseña — eso ya ocurrió a nivel
 * global. Aquí solo se piden los datos propios de la relación con ESTE
 * restaurante (nombre para el mesero, teléfono/WhatsApp, fecha de
 * nacimiento) y, al confirmar, se vincula el `auth_id` de la sesión con el
 * `restaurante_id` actual.
 *
 * Props:
 *   user          → session.user de Supabase Auth (ya autenticado).
 *   restaurantId  → id del restaurante en el que se está inscribiendo.
 *   referidoPor   → nombre de quien lo invitó (query param ?ref=), si aplica.
 *   onSuccess(id, nombre, puntos, esReingreso) → App.jsx lo usa para pasar a
 *                                   la pantalla de bienvenida con los puntos.
 *                                   esReingreso=true cuando la fila era una
 *                                   desvinculación anterior que se reactivó
 *                                   (ver fn_cliente_reingresa_restaurante) —
 *                                   puntos siempre es 0 en ese caso.
 */
export const RegistrationForm = ({ onSuccess, user, restaurantId, referidoPor, esCerca = false }) => {
  const [formData, setFormData] = useState({ nombre: '', telefono: '', fechaNacimiento: '', cedula: '' });
  const [loading,  setLoading]  = useState(false);
  const [mostrarTerminos, setMostrarTerminos] = useState(false);
  // Aceptación explícita de Términos y Condiciones — antes el enlace solo
  // abría el modal informativo y el formulario se podía enviar sin haberlo
  // siquiera abierto. Ahora es un checkbox obligatorio (validado en dos
  // capas, igual que teléfono/cédula: `required` nativo + chequeo en
  // handleSubmit) que debe estar marcado para poder unirse al club.
  const [terminosAceptados, setTerminosAceptados] = useState(false);

  const hoy = new Date();
  const fechaMaxima = hoy.toISOString().split('T')[0];
  const hace90     = new Date(); hace90.setFullYear(hoy.getFullYear() - 90);
  const fechaMinima = hace90.toISOString().split('T')[0];

  const handleChange = (e) => {
    const { id, value } = e.target;
    if (id === 'whatsapp') {
      // Solo dígitos, máximo 10 (el +57 se antepone al guardar, no se escribe aquí)
      const soloDigitos = value.replace(/\D/g, '').slice(0, 10);
      setFormData(prev => ({ ...prev, telefono: soloDigitos }));
      return;
    }
    if (id === 'cedula') {
      // Solo dígitos, máximo 10 — cubre los formatos de cédula de ciudadanía
      // colombiana (no lleva puntos ni guiones en la base de datos).
      const soloDigitos = value.replace(/\D/g, '').slice(0, 10);
      setFormData(prev => ({ ...prev, cedula: soloDigitos }));
      return;
    }
    const key = id === 'nacimiento' ? 'fechaNacimiento' : id;
    setFormData(prev => ({ ...prev, [key]: value }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (loading) return;
    if (!user?.id) {
      alert('Tu sesión no es válida. Vuelve a iniciar sesión e intenta de nuevo.');
      return;
    }
    if (!formData.nombre.trim() || !formData.telefono.trim() || !formData.fechaNacimiento || !formData.cedula.trim()) {
      alert('Por favor, completa todos los campos. El teléfono y la cédula son obligatorios.');
      return;
    }
    if (!/^\d{10}$/.test(formData.telefono.trim())) {
      alert('El teléfono debe tener 10 dígitos, ej: 3000000000.');
      return;
    }
    if (!/^\d{6,10}$/.test(formData.cedula.trim())) {
      alert('La cédula debe tener entre 6 y 10 dígitos, sin puntos ni espacios.');
      return;
    }
    if (!terminosAceptados) {
      alert('Debes aceptar los Términos y Condiciones para unirte al club.');
      return;
    }
    setLoading(true);
    try {
      // Guardamos el teléfono con el indicativo de Colombia (+57) para que
      // quede en formato internacional en la base de datos, aunque el
      // usuario solo digite los 10 dígitos locales.
      const telefonoConIndicativo = `+57${formData.telefono.trim()}`;

      // deviceId: se resuelve ANTES de registrar (no depende del resultado)
      // porque registrarClienteEnRestaurante lo necesita para vincular este
      // dispositivo al cliente recién creado en `dispositivos_clientes` —
      // sin ese vínculo, el sistema de proximidad (geocercas nativas +
      // geofence-webhook) nunca sabría a quién acreditarle puntos en este
      // restaurante. getDeviceId() cachea internamente, así que llamarlo
      // acá no repite trabajo si GeofencingProvider ya lo resolvió antes.
      const deviceId = await getDeviceId();

      // Une la cuenta global (auth_id) ya autenticada con este restaurante
      // en particular. El usuario decide explícitamente unirse al hacer
      // clic en "Unirme al club" — nunca ocurre de forma automática.
      const cliente = await registrarClienteEnRestaurante({
        user,
        restauranteId:   restaurantId,
        nombre:          formData.nombre.trim(),
        telefono:        telefonoConIndicativo,
        fechaNacimiento: formData.fechaNacimiento,
        cedula:          formData.cedula.trim(),
        referidoPor,
        // OJO: esto NO otorga el bono de proximidad — es solo un dato
        // informativo (ver el comentario largo en supabaseClient.js). El
        // bono real de +200 (si aplica) lo intenta SuccessCard por
        // separado, con una lectura de GPS propia, después de esta pantalla.
        registradoEnGeocerca: esCerca,
        deviceId,
      });

      onSuccess?.(cliente.id, cliente.nombre, cliente.saldo_puntos, cliente.esReingreso === true);
    } catch (error) {
      console.error('Error en registro:', error);
      if (error?.code === '23505') {
        alert(
          'Este teléfono ya está registrado en otro restaurante y la base de ' +
          'datos aún no permite registros independientes por sede. ' +
          'Contacta al administrador para actualizar la restricción UNIQUE en la tabla "clientes".'
        );
      } else {
        alert('Hubo un problema al procesar los datos. Intenta de nuevo.');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <form onSubmit={handleSubmit} style={styles.card}>
        {/* Header */}
        <div style={styles.header}>
          <h2 style={styles.title}>Crea tu perfil</h2>
          <p style={styles.subtitle}>Regístrate hoy y gana tus primeros puntos de bienvenida</p>
        </div>

        {/* Fields */}
        <div style={styles.field}>
          <label style={styles.label} htmlFor="nombre">Nombre completo</label>
          <input id="nombre" type="text" required placeholder=" "
            style={styles.input} value={formData.nombre} onChange={handleChange}
            autoComplete="off" autoCorrect="off" autoCapitalize="words" spellCheck="false" />
        </div>

        <div style={styles.field}>
          <label style={styles.label} htmlFor="whatsapp">Teléfono / WhatsApp <span style={styles.requiredMark}>*</span></label>
          <div style={styles.phoneRow}>
            <span style={styles.phonePrefix}>+57</span>
            <input id="whatsapp" type="tel" required inputMode="numeric" pattern="[0-9]{10}"
              maxLength={10} placeholder="3000000000" style={styles.phoneInput}
              value={formData.telefono} onChange={handleChange}
              autoComplete="off" autoCorrect="off" spellCheck="false" />
          </div>
        </div>

        <div style={styles.field}>
          <label style={styles.label} htmlFor="cedula">Cédula <span style={styles.requiredMark}>*</span></label>
          <input id="cedula" type="text" required inputMode="numeric" pattern="[0-9]{6,10}"
            maxLength={10} placeholder="Ej: 1017123456" style={styles.input}
            value={formData.cedula} onChange={handleChange}
            autoComplete="off" autoCorrect="off" spellCheck="false" />
        </div>

        <div style={{ ...styles.field, marginBottom: '1.25rem' }}>
          <label style={styles.label} htmlFor="nacimiento">Fecha de nacimiento</label>
          <input id="nacimiento" type="date" required min={fechaMinima} max={fechaMaxima}
            style={styles.input} value={formData.fechaNacimiento} onChange={handleChange}
            autoComplete="off" />
        </div>

        {/* Aceptación obligatoria de Términos y Condiciones — checkbox real,
            no solo un enlace informativo. El formulario no se puede enviar
            (ni nativa ni vía handleSubmit) sin marcarlo. */}
        <label style={styles.checkboxRow} htmlFor="aceptaTerminos">
          <input
            id="aceptaTerminos"
            type="checkbox"
            required
            checked={terminosAceptados}
            onChange={(e) => setTerminosAceptados(e.target.checked)}
            style={styles.checkbox}
          />
          <span style={styles.checkboxLabel}>
            Acepto los{' '}
            <span
              style={styles.termsInlineLink}
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); setMostrarTerminos(true); }}
            >
              Términos y Condiciones
            </span>
          </span>
        </label>

        {/* Submit */}
        <button type="submit" disabled={loading || !terminosAceptados} style={{
          ...styles.btnJoin,
          opacity: (loading || !terminosAceptados) ? 0.5 : 1,
          cursor:  (loading || !terminosAceptados) ? 'not-allowed' : 'pointer',
        }}>
          {loading ? (
            <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
              <span style={styles.spinner} /> Procesando…
            </span>
          ) : 'Unirme al club →'}
        </button>

        <p style={styles.secureNote}>🔒 Tus datos están protegidos</p>
      </form>

      {/* Modal de términos */}
      {mostrarTerminos && (
        <div style={styles.overlay}>
          <div style={styles.modal}>
            <h3 style={{ fontFamily: 'var(--font-display)', fontSize: '1.1rem', marginBottom: '1rem', color: 'var(--text-h)' }}>
              Términos y Condiciones
            </h3>
            <div style={{ fontSize: '0.85rem', color: 'var(--text)', lineHeight: 1.7 }}>
              <p><strong>1. Puntos:</strong> Ganas puntos automáticamente por registrarte, por estar cerca del local (geocerca) y por cada consumo — sin necesidad de que el mesero confirme nada con un PIN.</p>
              <p style={{ marginTop: 10 }}><strong>2. Redención:</strong> Al alcanzar el mínimo de puntos configurado por el restaurante, puedes pagar tu cuenta con ellos (1 punto = $1 COP), total o parcialmente.</p>
              <p style={{ marginTop: 10 }}><strong>3. Vencimiento:</strong> Los puntos se consolidan al cierre de cada mes y vencen según la política de vigencia del restaurante (por defecto, 90 días desde su consolidación).</p>
              <p style={{ marginTop: 10 }}><strong>4. Datos:</strong> Autorizas el uso de tus datos solo para este programa de fidelización.</p>
            </div>
            <button type="button" onClick={() => setMostrarTerminos(false)} style={styles.btnJoin}>
              Entendido
            </button>
          </div>
        </div>
      )}
    </>
  );
};

/* ── Inline styles (evita dependencia de CSS externo para este componente) ── */
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
  phoneRow: {
    display: 'flex',
    alignItems: 'stretch',
    border: '1.5px solid var(--border)',
    borderRadius: 'var(--r-md)',
    background: 'var(--bg-subtle)',
    overflow: 'hidden',
  },
  phonePrefix: {
    display: 'flex',
    alignItems: 'center',
    padding: '0 10px',
    fontSize: 16,
    fontWeight: 600,
    color: 'var(--text-h)',
    background: 'var(--border)',
    flexShrink: 0,
  },
  phoneInput: {
    flex: 1,
    minWidth: 0,
    padding: '11px 14px',
    fontSize: 16, /* evita zoom en iPhone */
    fontFamily: 'var(--font-body)',
    fontWeight: 400,
    background: 'transparent',
    border: 'none',
    color: 'var(--text-h)',
    outline: 'none',
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
  spinner: {
    display: 'inline-block',
    width: 16, height: 16,
    border: '2px solid rgba(255,255,255,0.35)',
    borderTopColor: 'white',
    borderRadius: '50%',
    animation: 'spin 0.7s linear infinite',
  },
  benefitsRow: { display: 'flex', gap: 6, marginTop: 14 },
  benefitPill: {
    flex: 1,
    background: 'var(--bg-subtle)',
    borderRadius: 'var(--r-sm)',
    padding: '8px 4px',
    textAlign: 'center',
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
  },
  benefitNum: {
    fontFamily: 'var(--font-display)',
    fontWeight: 800,
    fontSize: '1.15rem',
    color: 'var(--coral)',
    lineHeight: 1,
  },
  benefitLabel: { fontSize: '10px', color: 'var(--text)', fontWeight: 500 },
  termsLink: {
    marginTop: 12,
    fontSize: '0.7rem',
    color: 'var(--coral)',
    textDecoration: 'underline',
    cursor: 'pointer',
    textAlign: 'center',
    fontStyle: 'italic',
  },
  requiredMark: { color: 'var(--coral)' },
  checkboxRow: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 8,
    margin: '4px 0 14px',
    cursor: 'pointer',
  },
  checkbox: {
    marginTop: 2,
    width: 16,
    height: 16,
    flexShrink: 0,
    accentColor: 'var(--coral)',
    cursor: 'pointer',
  },
  checkboxLabel: {
    fontSize: '0.78rem',
    color: 'var(--text)',
    lineHeight: 1.4,
  },
  termsInlineLink: {
    color: 'var(--coral)',
    textDecoration: 'underline',
    cursor: 'pointer',
  },
  secureNote: {
    marginTop: 8,
    fontSize: '0.7rem',
    textAlign: 'center',
    opacity: 0.4,
    color: 'var(--text)',
  },
  overlay: {
    position: 'fixed', inset: 0,
    background: 'rgba(0,0,0,0.45)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 1000, padding: '1.5rem',
  },
  modal: {
    background: 'var(--bg-card)',
    borderRadius: 'var(--r-xl)',
    padding: '1.5rem',
    width: '100%',
    maxWidth: 420,
    maxHeight: '80vh',
    overflowY: 'auto',
    boxShadow: '0 20px 60px rgba(0,0,0,0.2)',
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
  },
};
