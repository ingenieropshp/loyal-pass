/**
 * CuentaScreen.jsx
 * ────────────────────────────────────────────────────────────────────────
 * Rediseño completo de la pantalla "Cuenta" (bistro-app), tema "Luxury
 * Charcoal & Gold". Reemplaza el stub anterior (avatar con iniciales +
 * correo/teléfono + cerrar sesión) por:
 *
 *   1. Header con avatar subible (Supabase Storage, bucket 'avatars') y
 *      Tarjeta de Membresía Premium con flip 3D → QR de la cédula.
 *   2. Formulario de datos personales sincronizado con `clientes` +
 *      Supabase Auth (correo). Cédula solo lectura. Fecha de nacimiento
 *      editable solo la primera vez.
 *   3. Seguridad (cambio de contraseña con verificación de la contraseña
 *      actual), toggles de notificación, y diagnóstico rápido de permisos
 *      (GPS + push) — mismos chequeos que CentroNotificaciones.jsx, ver
 *      utils/permisosDispositivo.js.
 *   4. Footer: Términos, Cerrar sesión, Eliminar mi cuenta (doble
 *      confirmación → RPC fn_cliente_elimina_su_cuenta, borrado lógico).
 *
 * BLINDAJE EN EL BACKEND (migración `rediseno_cuenta_avatar_notif_blindaje`):
 * aunque este componente NUNCA envía saldo_puntos/nivel/cedula/activo/etc.
 * en sus propios UPDATE a `clientes`, el trigger `trg_proteger_edicion_cliente`
 * los protege también a nivel de base de datos contra cualquier auto-edición
 * del cliente (RLS solo filtra por fila, no por columna) — así que ni un
 * payload manipulado contra la REST API podría tocarlos. La fecha de
 * nacimiento sigue el mismo blindaje: una vez tiene valor, el propio
 * backend la vuelve a fijar en su valor anterior si el cliente intenta
 * cambiarla, sin depender solo del `disabled` del input. "Eliminar mi
 * cuenta" pasa por fn_cliente_desvincula_restaurante() (RPC), el único
 * camino habilitado para apagar `activo` — un UPDATE directo nunca lo logra.
 * Esa misma RPC archiva el saldo a 0 vía el ledger (nunca con un UPDATE
 * directo sobre saldo_puntos) y borra el vínculo de dispositivo de este
 * restaurante para detener sus alertas de proximidad.
 *
 * Props:
 *   clienteId     → id de la fila en `clientes` para esta sede.
 *   restauranteId → UUID real del restaurante de esta sede (sedeActual.restaurante_id
 *                   en App.jsx). "Eliminar mi cuenta" es, por diseño, una baja
 *                   POR RESTAURANTE (ver el propio texto del modal más abajo:
 *                   "tu perfil de fidelización EN ESTE restaurante") — se envía
 *                   a fn_cliente_desvincula_restaurante(p_restaurante_id), la
 *                   misma RPC que usa "No seguir este restaurante" en
 *                   BuscadorRestaurantes.jsx. Un cliente inscrito en varios
 *                   restaurantes conserva sus otros vínculos intactos.
 *   nombreCliente → nombre ya conocido por App.jsx (fallback mientras carga).
 *   session       → session de Supabase Auth (App.jsx la mantiene via
 *                   onAuthStateChange) — se usa para auth.uid() (ruta del
 *                   avatar en Storage) y el correo actual (verificar
 *                   contraseña, detectar si el correo del formulario cambió).
 *   onLogout      → cierra sesión (ya existía; también se usa después de
 *                   eliminar la cuenta).
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { supabase } from '../services/supabaseClient';
import { chequearPermisoGPS, chequearPermisoPush, abrirConfiguracionSistema } from '../utils/permisosDispositivo';
import './CuentaScreen.css';

const CAMPOS_PERFIL =
  'id, nombre, telefono, email, cedula, fecha_nacimiento, nivel, saldo_puntos, avatar_url, notif_proximidad_activa, notif_promociones_activa';

const NIVEL_BADGE = {
  BRONCE:  { icono: '🥉', label: 'Bronce' },
  PLATA:   { icono: '🥈', label: 'Plata' },
  ORO:     { icono: '🥇', label: 'Oro' },
  PLATINO: { icono: '💎', label: 'Platino' },
  LEYENDA: { icono: '🖤', label: 'Leyenda' },
};

function obtenerIniciales(nombreCompleto) {
  const partes = (nombreCompleto || '').trim().split(/\s+/).filter(Boolean);
  if (partes.length === 0) return '👤';
  return partes.slice(0, 2).map(p => p[0].toUpperCase()).join('') || '👤';
}

// "+573001234567" -> "3001234567" (mismo criterio de edición sin indicativo
// que ya usa RegistrationForm.jsx — el +57 se antepone de nuevo al guardar).
function soloDigitosLocales(telefono) {
  if (!telefono) return '';
  const limpio = String(telefono).replace(/\D/g, '');
  return limpio.length > 10 ? limpio.slice(-10) : limpio;
}

const hoyISO = () => new Date().toISOString().slice(0, 10);

export function CuentaScreen({ clienteId, restauranteId, nombreCliente, session, onLogout }) {
  const authUserId = session?.user?.id || null;
  const authEmail  = session?.user?.email || '';

  const [cliente,  setCliente]  = useState(null);
  const [cargando, setCargando] = useState(true);

  // Formulario de datos personales
  const [nombre, setNombre] = useState('');
  const [telefonoLocal, setTelefonoLocal] = useState('');
  const [email, setEmail] = useState('');
  const [fechaNacimiento, setFechaNacimiento] = useState('');
  const [guardando, setGuardando] = useState(false);
  const [mensaje, setMensaje] = useState(null); // { tipo: 'ok'|'error', texto }

  // Avatar
  const [subiendoAvatar, setSubiendoAvatar] = useState(false);
  const inputAvatarRef = useRef(null);

  // Tarjeta de membresía (flip 3D)
  const [tarjetaVolteada, setTarjetaVolteada] = useState(false);

  // Modales
  const [modalPasswordAbierto, setModalPasswordAbierto] = useState(false);
  const [modalTerminosAbierto, setModalTerminosAbierto] = useState(false);
  const [modalEliminarAbierto, setModalEliminarAbierto] = useState(false);
  const [pasoEliminar, setPasoEliminar] = useState(1);
  const [eliminando, setEliminando] = useState(false);

  // Diagnóstico de permisos
  const [gpsEstado, setGpsEstado] = useState('desconocida');
  const [pushEstado, setPushEstado] = useState('desconocida');

  const cargarCliente = useCallback(async () => {
    if (!clienteId) { setCargando(false); return; }
    setCargando(true);
    const { data, error } = await supabase
      .from('clientes')
      .select(CAMPOS_PERFIL)
      .eq('id', clienteId)
      .maybeSingle();

    if (error) {
      console.warn('[CuentaScreen] No se pudo cargar el perfil:', error.message);
    } else if (data) {
      setCliente(data);
      setNombre(data.nombre || '');
      setTelefonoLocal(soloDigitosLocales(data.telefono));
      setEmail(data.email || authEmail || '');
      setFechaNacimiento(data.fecha_nacimiento || '');
    }
    setCargando(false);
  }, [clienteId, authEmail]);

  useEffect(() => { cargarCliente(); }, [cargarCliente]);

  useEffect(() => {
    let cancelado = false;
    chequearPermisoGPS().then((e) => { if (!cancelado) setGpsEstado(e); });
    chequearPermisoPush().then((e) => { if (!cancelado) setPushEstado(e); });
    return () => { cancelado = true; };
  }, []);

  const nivelInfo = NIVEL_BADGE[cliente?.nivel] || NIVEL_BADGE.BRONCE;
  const fechaNacimientoBloqueada = Boolean(cliente?.fecha_nacimiento);

  // ── Avatar: seleccionar y subir a Storage ────────────────────────────
  const handleSeleccionarAvatar = () => inputAvatarRef.current?.click();

  const handleArchivoAvatar = async (e) => {
    const archivo = e.target.files?.[0];
    e.target.value = ''; // permite volver a elegir el mismo archivo después
    if (!archivo || !authUserId || !clienteId) return;

    if (!archivo.type.startsWith('image/')) {
      setMensaje({ tipo: 'error', texto: 'Selecciona un archivo de imagen válido.' });
      return;
    }
    if (archivo.size > 5 * 1024 * 1024) {
      setMensaje({ tipo: 'error', texto: 'La imagen no puede pesar más de 5 MB.' });
      return;
    }

    setSubiendoAvatar(true);
    setMensaje(null);
    try {
      const extension = (archivo.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
      // Carpeta = auth.uid(): así lo exigen las policies de storage.objects
      // (avatars_cliente_sube_su_propia_foto, etc.) — ver migración. Nombre
      // fijo + upsert:true para no acumular fotos viejas huérfanas.
      const ruta = `${authUserId}/avatar.${extension}`;

      const { error: errorSubida } = await supabase.storage
        .from('avatars')
        .upload(ruta, archivo, { upsert: true, contentType: archivo.type });
      if (errorSubida) throw errorSubida;

      const { data: publico } = supabase.storage.from('avatars').getPublicUrl(ruta);
      // Cache-busting: la ruta es siempre la misma, así que sin este
      // parámetro el navegador seguiría mostrando la foto anterior desde su
      // caché aunque el archivo en Storage ya se haya sobrescrito.
      const urlConCacheBust = `${publico.publicUrl}?v=${Date.now()}`;

      const { error: errorUpdate } = await supabase
        .from('clientes')
        .update({ avatar_url: urlConCacheBust })
        .eq('id', clienteId);
      if (errorUpdate) throw errorUpdate;

      setCliente((prev) => (prev ? { ...prev, avatar_url: urlConCacheBust } : prev));
      setMensaje({ tipo: 'ok', texto: 'Foto de perfil actualizada.' });
    } catch (err) {
      console.error('[CuentaScreen] Error subiendo avatar:', err);
      setMensaje({ tipo: 'error', texto: 'No se pudo subir la foto. Intenta de nuevo.' });
    } finally {
      setSubiendoAvatar(false);
    }
  };

  // ── Guardar cambios del formulario ───────────────────────────────────
  const handleGuardar = async (e) => {
    e.preventDefault();
    if (guardando) return;
    setMensaje(null);

    if (!nombre.trim()) {
      setMensaje({ tipo: 'error', texto: 'El nombre no puede quedar vacío.' });
      return;
    }
    if (telefonoLocal && !/^\d{10}$/.test(telefonoLocal)) {
      setMensaje({ tipo: 'error', texto: 'El teléfono debe tener 10 dígitos.' });
      return;
    }

    setGuardando(true);
    try {
      const emailLimpio = email.trim().toLowerCase();
      const emailCambio = emailLimpio && emailLimpio !== (authEmail || '').toLowerCase();

      // 1) Correo: primero contra Supabase Auth. Si falla, no tocamos
      //    `clientes` — evita dejar una copia denormalizada desincronizada
      //    de un cambio de correo que nunca se aplicó de verdad.
      if (emailCambio) {
        const { error: errorAuth } = await supabase.auth.updateUser({ email: emailLimpio });
        if (errorAuth) {
          setMensaje({ tipo: 'error', texto: `No se pudo actualizar el correo: ${errorAuth.message}` });
          setGuardando(false);
          return;
        }
      }

      // 2) UPDATE a `clientes` — solo los campos que el cliente puede
      //    tocar desde su propio perfil. fecha_nacimiento solo se incluye
      //    si todavía no tenía valor (y aunque se incluyera por error, el
      //    trigger del backend la revertiría).
      const payload = {
        nombre: nombre.trim(),
        telefono: telefonoLocal ? `+57${telefonoLocal}` : null,
        email: emailLimpio || null,
      };
      if (!fechaNacimientoBloqueada && fechaNacimiento) {
        payload.fecha_nacimiento = fechaNacimiento;
      }

      const { data: actualizado, error: errorUpdate } = await supabase
        .from('clientes')
        .update(payload)
        .eq('id', clienteId)
        .select(CAMPOS_PERFIL)
        .maybeSingle();
      if (errorUpdate) throw errorUpdate;

      setCliente(actualizado);
      setMensaje({
        tipo: 'ok',
        texto: emailCambio
          ? 'Cambios guardados. Si tu proyecto requiere confirmación de correo, revisa tu bandeja para validarlo.'
          : 'Cambios guardados correctamente.',
      });
    } catch (err) {
      console.error('[CuentaScreen] Error guardando cambios:', err);
      setMensaje({ tipo: 'error', texto: 'Hubo un problema al guardar. Intenta de nuevo.' });
    } finally {
      setGuardando(false);
    }
  };

  // ── Preferencias de notificación (toggles dorados) ───────────────────
  const actualizarPreferencia = async (campo, valor) => {
    setCliente((prev) => (prev ? { ...prev, [campo]: valor } : prev)); // optimista
    const { error } = await supabase.from('clientes').update({ [campo]: valor }).eq('id', clienteId);
    if (error) {
      console.warn('[CuentaScreen] No se pudo guardar la preferencia:', error.message);
      setCliente((prev) => (prev ? { ...prev, [campo]: !valor } : prev)); // revertir
    }
  };

  // ── Cerrar sesión ─────────────────────────────────────────────────────
  const handleCerrarSesion = () => {
    if (window.confirm('¿Cerrar sesión? Podrás volver a ingresar con tu correo y contraseña.')) {
      onLogout?.();
    }
  };

  // ── Eliminar cuenta (doble confirmación → RPC) ───────────────────────
  const abrirModalEliminar = () => { setPasoEliminar(1); setModalEliminarAbierto(true); };
  const cerrarModalEliminar = () => { if (!eliminando) { setModalEliminarAbierto(false); setPasoEliminar(1); } };

  const confirmarEliminacion = async () => {
    if (pasoEliminar === 1) { setPasoEliminar(2); return; }

    if (!restauranteId) {
      setMensaje({ tipo: 'error', texto: 'No pudimos identificar la sede. Recarga la página e intenta de nuevo.' });
      return;
    }

    setEliminando(true);
    try {
      // FIX: antes llamaba a fn_cliente_elimina_su_cuenta() (sin restaurante),
      // que desactivaba TODAS las filas del cliente a la vez con un
      // `RETURNING ... INTO` escalar — cualquier cliente inscrito en 2+
      // restaurantes hacía que ese UPDATE multi-fila lanzara un error de
      // Postgres en vez de eliminar nada. Este botón, por su propio texto
      // ("tu perfil de fidelización EN ESTE restaurante"), siempre fue una
      // baja por sede — ahora usa la RPC scoped a p_restaurante_id, la misma
      // que "No seguir este restaurante" en BuscadorRestaurantes.jsx.
      const { data, error } = await supabase.rpc('fn_cliente_desvincula_restaurante', {
        p_restaurante_id: restauranteId,
      });
      if (error) throw error;
      if (!data?.ok) {
        setMensaje({ tipo: 'error', texto: 'No se pudo eliminar tu cuenta. Intenta de nuevo.' });
        setEliminando(false);
        return;
      }
      setModalEliminarAbierto(false);
      onLogout?.();
    } catch (err) {
      console.error('[CuentaScreen] Error eliminando cuenta:', err);
      setMensaje({ tipo: 'error', texto: 'Hubo un problema al eliminar tu cuenta. Intenta de nuevo.' });
      setEliminando(false);
    }
  };

  if (cargando) {
    return <div className="cuenta-loading">Cargando tu perfil…</div>;
  }

  const nombreMostrado = nombre || cliente?.nombre || nombreCliente || '';

  return (
    <div style={{ width: '100%', paddingTop: '1.5rem' }}>
      {/* ── 1. Header: avatar + tarjeta de membresía con flip a QR ── */}
      <div className="cuenta-header">
        <div className="cuenta-avatar-wrap" onClick={handleSeleccionarAvatar} role="button" tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleSeleccionarAvatar(); }}
          aria-label="Cambiar foto de perfil">
          {cliente?.avatar_url ? (
            <img src={cliente.avatar_url} alt="Foto de perfil" className="cuenta-avatar-img" />
          ) : (
            <div className="cuenta-avatar-iniciales">{obtenerIniciales(nombreMostrado)}</div>
          )}
          <div className="cuenta-avatar-editar">{subiendoAvatar ? '…' : '📷'}</div>
        </div>
        <input
          ref={inputAvatarRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={handleArchivoAvatar}
        />
        <p className="cuenta-nombre-header">{nombreMostrado || '—'}</p>
      </div>

      <div className="cuenta-tarjeta-wrap">
        <div
          className={`cuenta-tarjeta-flip ${tarjetaVolteada ? 'volteada' : ''}`}
          onClick={() => setTarjetaVolteada((v) => !v)}
          role="button"
          tabIndex={0}
          aria-label="Voltear tarjeta de membresía para ver tu código QR"
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setTarjetaVolteada((v) => !v); }}
        >
          <div className="cuenta-tarjeta-cara cuenta-tarjeta-frente">
            <div className="cuenta-tarjeta-filete" />
            <div className="cuenta-tarjeta-top">
              <span className="cuenta-tarjeta-marca">LoyalPass</span>
              <span className="cuenta-tarjeta-nivel">{nivelInfo.icono} {nivelInfo.label}</span>
            </div>
            <p className="cuenta-tarjeta-nombre">{nombreMostrado || '—'}</p>
            <div className="cuenta-tarjeta-bottom">
              <div>
                <span className="cuenta-tarjeta-label">Saldo</span>
                <span className="cuenta-tarjeta-saldo">{(cliente?.saldo_puntos ?? 0).toLocaleString('es-CO')} pts</span>
              </div>
              <span className="cuenta-tarjeta-toca">Toca para ver tu QR ↻</span>
            </div>
          </div>

          <div className="cuenta-tarjeta-cara cuenta-tarjeta-reverso">
            {cliente?.cedula ? (
              <>
                <QRCodeSVG value={String(cliente.cedula)} size={148} bgColor="#F5F5DC" fgColor="#121212" level="H" includeMargin />
                <p className="cuenta-tarjeta-cedula">CC {cliente.cedula}</p>
              </>
            ) : (
              <p className="cuenta-tarjeta-sin-cedula">Cédula no registrada — contacta al restaurante.</p>
            )}
            <span className="cuenta-tarjeta-toca">Toca para volver ↻</span>
          </div>
        </div>
      </div>

      {/* ── 2. Formulario de datos personales ── */}
      <form className="cuenta-card" onSubmit={handleGuardar}>
        <h3 className="cuenta-card-titulo">Datos personales</h3>

        {mensaje && <div className={`cuenta-alerta ${mensaje.tipo}`}>{mensaje.texto}</div>}

        <div className="cuenta-field">
          <label className="cuenta-label" htmlFor="cuentaNombre">Nombre completo</label>
          <input
            id="cuentaNombre"
            className="cuenta-input"
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            autoComplete="name"
          />
        </div>

        <div className="cuenta-field">
          <label className="cuenta-label" htmlFor="cuentaTelefono">Teléfono</label>
          <div className="cuenta-phone-row">
            <span className="cuenta-phone-prefix">+57</span>
            <input
              id="cuentaTelefono"
              className="cuenta-phone-input"
              type="tel"
              inputMode="numeric"
              maxLength={10}
              value={telefonoLocal}
              onChange={(e) => setTelefonoLocal(e.target.value.replace(/\D/g, '').slice(0, 10))}
              autoComplete="tel-national"
            />
          </div>
        </div>

        <div className="cuenta-field">
          <label className="cuenta-label" htmlFor="cuentaEmail">Correo electrónico</label>
          <input
            id="cuentaEmail"
            type="email"
            className="cuenta-input"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
          />
        </div>

        <div className="cuenta-field">
          <label className="cuenta-label" htmlFor="cuentaCedula">Cédula / Documento</label>
          <input
            id="cuentaCedula"
            className="cuenta-input cuenta-input-disabled"
            value={cliente?.cedula || '—'}
            disabled
            readOnly
          />
        </div>

        <div className="cuenta-field">
          <label className="cuenta-label" htmlFor="cuentaNacimiento">Fecha de nacimiento</label>
          <input
            id="cuentaNacimiento"
            type="date"
            className={`cuenta-input ${fechaNacimientoBloqueada ? 'cuenta-input-disabled' : ''}`}
            value={fechaNacimiento}
            onChange={(e) => setFechaNacimiento(e.target.value)}
            disabled={fechaNacimientoBloqueada}
            readOnly={fechaNacimientoBloqueada}
            max={hoyISO()}
          />
          {fechaNacimientoBloqueada && (
            <p className="cuenta-nota-bloqueo">Para modificar tu fecha de nacimiento, contacta al administrador.</p>
          )}
        </div>

        <button type="submit" className="cuenta-btn-guardar" disabled={guardando}>
          {guardando ? 'Guardando…' : 'Guardar cambios'}
        </button>
      </form>

      {/* ── 3. Seguridad, notificaciones y diagnóstico ── */}
      <div className="cuenta-card">
        <h3 className="cuenta-card-titulo">Seguridad y notificaciones</h3>

        <button type="button" className="cuenta-btn-secundario" onClick={() => setModalPasswordAbierto(true)}>
          🔒 Cambiar contraseña
        </button>

        <div className="cuenta-toggle-row">
          <div>
            <p className="cuenta-toggle-label">Notificaciones de proximidad (GPS)</p>
            <p className="cuenta-toggle-sub">Avísame cuando gane puntos por estar cerca del local</p>
          </div>
          <label className="cuenta-switch">
            <input
              type="checkbox"
              checked={cliente?.notif_proximidad_activa ?? true}
              onChange={(e) => actualizarPreferencia('notif_proximidad_activa', e.target.checked)}
            />
            <span className="cuenta-switch-slider" />
          </label>
        </div>

        <div className="cuenta-toggle-row">
          <div>
            <p className="cuenta-toggle-label">Promociones</p>
            <p className="cuenta-toggle-sub">Novedades y ofertas del restaurante</p>
          </div>
          <label className="cuenta-switch">
            <input
              type="checkbox"
              checked={cliente?.notif_promociones_activa ?? true}
              onChange={(e) => actualizarPreferencia('notif_promociones_activa', e.target.checked)}
            />
            <span className="cuenta-switch-slider" />
          </label>
        </div>

        <div className="cuenta-diagnostico">
          <p className="cuenta-diagnostico-titulo">Diagnóstico rápido</p>
          <DiagnosticoLinea icono="📍" etiqueta="Permisos de Ubicación (GPS)" estado={gpsEstado} />
          <DiagnosticoLinea icono="🔔" etiqueta="Notificaciones Push" estado={pushEstado} />
        </div>
      </div>

      {/* ── 4. Footer ── */}
      <div className="cuenta-footer">
        <p className="cuenta-link-terminos" onClick={() => setModalTerminosAbierto(true)}>
          Términos de Servicio &amp; Políticas de Privacidad
        </p>
        <button type="button" className="cuenta-btn-logout" onClick={handleCerrarSesion}>
          Cerrar sesión
        </button>
        <button type="button" className="cuenta-btn-eliminar" onClick={abrirModalEliminar}>
          Eliminar mi cuenta
        </button>
      </div>

      <ModalCambiarContrasena
        abierto={modalPasswordAbierto}
        onClose={() => setModalPasswordAbierto(false)}
        emailActual={authEmail}
      />
      <ModalTerminos abierto={modalTerminosAbierto} onClose={() => setModalTerminosAbierto(false)} />
      <ModalEliminarCuenta
        abierto={modalEliminarAbierto}
        paso={pasoEliminar}
        eliminando={eliminando}
        onCancelar={cerrarModalEliminar}
        onConfirmar={confirmarEliminacion}
      />
    </div>
  );
}

// ── Subcomponentes internos ────────────────────────────────────────────

function DiagnosticoLinea({ icono, etiqueta, estado }) {
  const texto = estado === 'activa' ? 'Activo' : estado === 'inactiva' ? 'Inactivo' : '—';
  return (
    <div className="cuenta-diag-item">
      <span className="cuenta-diag-etiqueta">{icono} {etiqueta}</span>
      <span className={`cuenta-diag-estado ${estado}`}>{texto}</span>
      {estado === 'inactiva' && (
        <button type="button" className="cuenta-diag-btn" onClick={abrirConfiguracionSistema}>Ajustar</button>
      )}
    </div>
  );
}

function ModalCambiarContrasena({ abierto, onClose, emailActual }) {
  const [actual, setActual] = useState('');
  const [nueva, setNueva] = useState('');
  const [confirmar, setConfirmar] = useState('');
  const [loading, setLoading] = useState(false);
  const [mensaje, setMensaje] = useState(null);

  useEffect(() => {
    if (!abierto) {
      setActual('');
      setNueva('');
      setConfirmar('');
      setMensaje(null);
      setLoading(false);
    }
  }, [abierto]);

  if (!abierto) return null;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (loading) return;
    setMensaje(null);

    if (!actual) {
      setMensaje({ tipo: 'error', texto: 'Ingresa tu contraseña actual.' });
      return;
    }
    if (nueva.length < 6) {
      setMensaje({ tipo: 'error', texto: 'La nueva contraseña debe tener al menos 6 caracteres.' });
      return;
    }
    if (nueva !== confirmar) {
      setMensaje({ tipo: 'error', texto: 'Las contraseñas no coinciden.' });
      return;
    }

    setLoading(true);
    try {
      // supabase.auth.updateUser() NO pide la contraseña anterior — usa la
      // autoridad de la sesión activa. Para que "Contraseña actual" sea una
      // verificación real (y no solo un campo decorativo), la re-validamos
      // re-autenticando contra Supabase Auth antes de aplicar el cambio.
      const { error: errorVerificacion } = await supabase.auth.signInWithPassword({
        email: emailActual,
        password: actual,
      });
      if (errorVerificacion) {
        setMensaje({ tipo: 'error', texto: 'La contraseña actual no es correcta.' });
        setLoading(false);
        return;
      }

      const { error: errorUpdate } = await supabase.auth.updateUser({ password: nueva });
      if (errorUpdate) {
        setMensaje({ tipo: 'error', texto: errorUpdate.message });
        setLoading(false);
        return;
      }

      setMensaje({ tipo: 'ok', texto: 'Contraseña actualizada correctamente.' });
      setTimeout(onClose, 1100);
    } catch (err) {
      console.error('[CuentaScreen] Error cambiando contraseña:', err);
      setMensaje({ tipo: 'error', texto: 'Hubo un problema. Intenta de nuevo.' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="cuenta-modal-overlay" onClick={onClose}>
      <div className="cuenta-modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="cuenta-modal-titulo">Cambiar contraseña</h3>
        {mensaje && <div className={`cuenta-alerta ${mensaje.tipo}`}>{mensaje.texto}</div>}
        <form onSubmit={handleSubmit}>
          <div className="cuenta-field">
            <label className="cuenta-label" htmlFor="passActual">Contraseña actual</label>
            <input
              id="passActual" type="password" className="cuenta-input"
              value={actual} onChange={(e) => setActual(e.target.value)}
              autoComplete="current-password"
            />
          </div>
          <div className="cuenta-field">
            <label className="cuenta-label" htmlFor="passNueva">Nueva contraseña</label>
            <input
              id="passNueva" type="password" className="cuenta-input" minLength={6}
              value={nueva} onChange={(e) => setNueva(e.target.value)}
              autoComplete="new-password"
            />
          </div>
          <div className="cuenta-field">
            <label className="cuenta-label" htmlFor="passConfirmar">Confirmar nueva contraseña</label>
            <input
              id="passConfirmar" type="password" className="cuenta-input" minLength={6}
              value={confirmar} onChange={(e) => setConfirmar(e.target.value)}
              autoComplete="new-password"
            />
          </div>
          <div className="cuenta-modal-acciones">
            <button type="button" className="cuenta-btn-secundario" onClick={onClose}>Cancelar</button>
            <button type="submit" className="cuenta-btn-guardar" disabled={loading}>
              {loading ? 'Guardando…' : 'Guardar'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function ModalTerminos({ abierto, onClose }) {
  if (!abierto) return null;
  return (
    <div className="cuenta-modal-overlay" onClick={onClose}>
      <div className="cuenta-modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="cuenta-modal-titulo">Términos de Servicio &amp; Políticas de Privacidad</h3>
        <div className="cuenta-modal-texto">
          <p><strong>1. Puntos:</strong> Ganas puntos automáticamente por registrarte, por estar cerca del local (geocerca) y por cada consumo.</p>
          <p><strong>2. Redención:</strong> Al alcanzar el mínimo de puntos configurado por el restaurante, puedes pagar tu cuenta con ellos (1 punto = $1 COP), total o parcialmente.</p>
          <p><strong>3. Vencimiento:</strong> Los puntos se consolidan al cierre de cada mes y vencen a los 90 días desde su consolidación.</p>
          <p><strong>4. Datos:</strong> Autorizas el uso de tus datos solo para este programa de fidelización. Tu foto de perfil se guarda en un bucket seguro de Supabase Storage, accesible únicamente por ti para escritura.</p>
          <p><strong>5. Tu cuenta:</strong> Puedes solicitar la eliminación de tu perfil de fidelización en este restaurante en cualquier momento, desde esta misma pantalla.</p>
        </div>
        <button type="button" className="cuenta-btn-guardar" onClick={onClose}>Entendido</button>
      </div>
    </div>
  );
}

function ModalEliminarCuenta({ abierto, paso, eliminando, onCancelar, onConfirmar }) {
  if (!abierto) return null;
  return (
    <div className="cuenta-modal-overlay" onClick={onCancelar}>
      <div className="cuenta-modal cuenta-modal-peligro" onClick={(e) => e.stopPropagation()}>
        <h3 className="cuenta-modal-titulo">⚠️ Eliminar mi cuenta</h3>
        {paso === 1 ? (
          <p className="cuenta-modal-texto">
            Esto desactivará tu perfil de fidelización en este restaurante: perderás acceso a tu
            saldo de puntos, tu nivel y tu historial de recompensas aquí. Esta acción no se puede
            deshacer desde la app.
          </p>
        ) : (
          <p className="cuenta-modal-texto">
            <strong>Última confirmación:</strong> ¿de verdad quieres eliminar tu cuenta en este
            restaurante? Tu sesión se cerrará automáticamente después.
          </p>
        )}
        <div className="cuenta-modal-acciones">
          <button type="button" className="cuenta-btn-secundario" onClick={onCancelar} disabled={eliminando}>
            Cancelar
          </button>
          <button type="button" className="cuenta-btn-eliminar-confirmar" onClick={onConfirmar} disabled={eliminando}>
            {eliminando ? 'Eliminando…' : paso === 1 ? 'Sí, continuar' : 'Sí, eliminar definitivamente'}
          </button>
        </div>
      </div>
    </div>
  );
}
