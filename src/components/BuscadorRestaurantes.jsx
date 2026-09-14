import { useState, useEffect } from 'react';
import { supabase } from '../services/supabaseClient';
import { SelectorNotificaciones } from './SelectorNotificaciones';

// Escala oficial del sistema de niveles gamificado (misma en TODA la app:
// TarjetaFidelizacion.jsx aquí en bistro-app, calcularNivel() en
// useAdminLogic.js en bistro-admin, y fn_calcular_nivel_desde_puntos() en
// Supabase). El llamador pasa el saldo de puntos (`datos.puntos`).
//   BRONCE 0–4.999 · PLATA 5.000–24.999 · ORO 25.000–74.999
//   PLATINO 75.000–199.999 · LEYENDA 200.000+
const calcularNivel = (puntos = 0) => {
  if (puntos >= 200000) return { label: 'Leyenda', emoji: '🖤' };
  if (puntos >= 75000)  return { label: 'Platino', emoji: '💎' };
  if (puntos >= 25000)  return { label: 'Oro',      emoji: '🥇' };
  if (puntos >= 5000)   return { label: 'Plata',    emoji: '🥈' };
  return                       { label: 'Bronce',   emoji: '🥉' };
};

/**
 * BuscadorRestaurantes — pantalla "home" después del login global.
 *
 * Muestra ÚNICAMENTE los restaurantes donde el cliente ya está inscrito
 * (activo=true en `clientes`). Ya no existe una sección de "Descubre
 * restaurantes" ni forma alguna de buscar/listar/unirse a un restaurante
 * nuevo desde dentro de la app — la única forma de unirse a uno nuevo es
 * el link/QR físico con `?restaurante_id=`, que App.jsx maneja por fuera
 * de este componente (vía `sedeActual` + RegistrationForm).
 *
 * Props:
 *   session   → sesión activa de Supabase Auth (App.jsx garantiza que
 *               este componente solo se monta cuando ya existe sesión).
 *   onLogout  → cierra sesión (mismo handler que usa UserDashboard).
 */
export const BuscadorRestaurantes = ({ session, onLogout }) => {
  // Restaurantes donde el cliente ya está inscrito: [{ id, nombre }].
  // Se llena en cargarMisRestaurantes() — ya no se deriva de una lista
  // pública de restaurantes (esa lista, y la query que la traía, se
  // eliminaron por completo).
  const [misRestaurantes, setMisRestaurantes] = useState([]);
  // datos enriquecidos del cliente por sede: { [restauranteId]: { puntos, ciclos, nombre, clienteId } }
  const [datosPorSede, setDatosPorSede] = useState({});
  const [cargando, setCargando] = useState(true);
  const [mostrarPerfil, setMostrarPerfil] = useState(false);
  // Buscador LOCAL dentro de "Mis restaurantes" — filtra en memoria el
  // array `misRestaurantes` que ya está cargado, nunca dispara una
  // consulta nueva a la base de datos.
  const [busquedaMisRestaurantes, setBusquedaMisRestaurantes] = useState('');

  // Desvinculación voluntaria de un restaurante puntual ("No seguir este
  // restaurante") — ver fn_cliente_desvincula_restaurante en Supabase.
  const [restauranteADesvincular, setRestauranteADesvincular] = useState(null); // { id, nombre } | null
  const [desvinculando, setDesvinculando] = useState(false);
  const [errorDesvinculo, setErrorDesvinculo] = useState('');

  // ── Restaurantes donde el usuario YA está inscrito ──────────────────────
  // Antes esto se leía de localStorage (loyalpass_multisede), lo que
  // significaba que si el usuario borraba la app o cambiaba de dispositivo,
  // perdía la vista de "Mis restaurantes" aunque sus puntos seguían
  // intactos en la base de datos. Ahora se consulta directamente por
  // `auth_user_id`, que es la cuenta global — así esta lista es la misma
  // sin importar desde dónde entre.
  //
  // Antes, el NOMBRE de cada restaurante salía de una lista pública aparte
  // (cargarRestaurantes(), que traía TODA la tabla `configuracion` sin
  // filtro — esa función ya no existe). Ahora esta función pide los
  // nombres directamente con `.in(...)`, pero SOLO de los restaurantes
  // donde el cliente ya está inscrito — nunca la tabla completa.
  const cargarMisRestaurantes = async (esReintento = false) => {
    try {
      const { data: clientesData, error: errCli } = await supabase
        .from('clientes')
        .select('id, nombre, saldo_puntos, ciclos_completados, restaurante_id')
        .eq('auth_user_id', session.user.id)
        // FIX: sin este filtro, un restaurante del que el usuario se
        // desvinculó voluntariamente (fn_cliente_desvincula_restaurante →
        // activo=false) volvía a aparecer en "Mis restaurantes" en cada
        // recarga — la fila de `clientes` sigue existiendo (ahora en 0
        // pts), solo queda desactivada. "activo=true" es lo que realmente
        // define pertenencia vigente a la sede.
        .eq('activo', true);
      if (errCli) throw errCli;

      const filas = clientesData || [];

      // Sin restaurantes inscritos todavía: no hay nada que pedirle a
      // `configuracion`, y la pantalla debe mostrar el estado vacío.
      if (filas.length === 0) {
        setDatosPorSede({});
        setMisRestaurantes([]);
        setCargando(false);
        return;
      }

      // Nombres de las sedes inscritas — pedidos con `.in(id, [...])` para
      // traer SOLO esos restaurantes puntuales, nunca la tabla completa.
      const idsRestaurantes = [...new Set(filas.map(c => c.restaurante_id))];
      const { data: sedesData, error: errSedes } = await supabase
        .from('configuracion')
        .select('id, nombre')
        .in('id', idsRestaurantes);
      if (errSedes) throw errSedes;

      const nombrePorId = {};
      (sedesData || []).forEach(s => { nombrePorId[s.id] = s.nombre; });

      const mapa = {};
      filas.forEach(c => {
        mapa[c.restaurante_id] = {
          puntos:    c.saldo_puntos || 0,
          ciclos:    c.ciclos_completados || 0,
          nombre:    c.nombre,
          // id real de la fila de `clientes` para esta sede — necesario
          // para asociar la suscripción push (push_subscriptions) con este
          // cliente y poder personalizar sus notificaciones.
          clienteId: c.id,
        };
      });

      setDatosPorSede(mapa);
      setMisRestaurantes(
        idsRestaurantes.map(id => ({ id, nombre: nombrePorId[id] || '' }))
      );
      setCargando(false);
    } catch (e) {
      if (!esReintento) {
        // Un solo reintento, medio segundo después y sin avisarle nada al
        // usuario — cubre el caso de una petición autenticada disparada
        // demasiado pronto después de un login recién hecho (el token
        // nuevo aún no terminó de propagarse).
        setTimeout(() => cargarMisRestaurantes(true), 600);
        return;
      }
      // Ya reintentado y sigue fallando: se deja pasar en silencio (con
      // log) en vez de tumbarle la pantalla completa por un problema de
      // red puntual — el usuario verá el estado vacío hasta la próxima
      // recarga.
      console.warn('[BuscadorRestaurantes] No se pudo cargar "mis restaurantes":', e?.message || e);
      setCargando(false);
    }
  };

  useEffect(() => {
    if (session?.user?.id) {
      cargarMisRestaurantes();
    } else {
      // Defensivo: App.jsx solo monta este componente con sesión activa,
      // pero si por algún motivo no la hay, no dejamos el spinner de
      // carga girando para siempre.
      setCargando(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user?.id]);

  // Navega a la vista de la sede. App.jsx verifica ahí si el usuario ya
  // tiene una fila en `clientes` para ese restaurante (misma sesión
  // global, distinta sede):
  //   - Si ya está inscrito → entra directo a su tarjeta de fidelización.
  //   - Si NO está inscrito → NO se le crea nada automáticamente; se le
  //     muestra primero "Crea tu perfil" para que decida, con control
  //     total, si quiere unirse a este restaurante.
  const irA = (nombre) => { window.location.href = `/?r=${encodeURIComponent(nombre)}`; };

  // ── Desvincular voluntariamente de un restaurante ("No seguir este
  // restaurante") ──────────────────────────────────────────────────────────
  const abrirModalDesvincular = (e, restaurante) => {
    e.stopPropagation(); // no navegar a la sede: la tarjeta completa es clicable
    e.preventDefault();
    setErrorDesvinculo('');
    setRestauranteADesvincular(restaurante);
  };

  const cerrarModalDesvincular = () => {
    if (desvinculando) return; // evita cerrarlo a mitad de la operación
    setRestauranteADesvincular(null);
    setErrorDesvinculo('');
  };

  const confirmarDesvincular = async () => {
    if (!restauranteADesvincular) return;
    setDesvinculando(true);
    setErrorDesvinculo('');
    try {
      const { data, error } = await supabase.rpc('fn_cliente_desvincula_restaurante', {
        p_restaurante_id: restauranteADesvincular.id,
      });
      if (error) throw error;
      if (!data?.ok) {
        setErrorDesvinculo('No pudimos desvincularte de este restaurante. Intenta de nuevo.');
        setDesvinculando(false);
        return;
      }
      // Lo quita de "Mis restaurantes" de inmediato — sin esto seguiría
      // viéndose hasta la próxima recarga completa.
      setDatosPorSede((prev) => {
        const copia = { ...prev };
        delete copia[restauranteADesvincular.id];
        return copia;
      });
      setMisRestaurantes((prev) => prev.filter(r => r.id !== restauranteADesvincular.id));
      setRestauranteADesvincular(null);
    } catch (err) {
      console.error('[BuscadorRestaurantes] Error al desvincular restaurante:', err);
      setErrorDesvinculo('Hubo un problema al desvincularte. Intenta de nuevo.');
    } finally {
      setDesvinculando(false);
    }
  };

  // Igual que `misRestaurantes`, pero con el clienteId de cada sede
  // "pegado" — lo necesita SelectorNotificaciones para poder mandar el
  // cliente_id al guardar la suscripción push (ver push_subscriptions).
  const misRestaurantesConCliente = misRestaurantes.map(r => ({
    ...r,
    clienteId: datosPorSede[r.id]?.clienteId ?? null,
  }));

  // Filtro local (en memoria) por nombre — no dispara ninguna consulta
  // nueva. El input que lo alimenta solo se muestra si hay más de 3
  // restaurantes inscritos (ver JSX más abajo).
  const misRestaurantesFiltrados = misRestaurantes.filter(r =>
    r.nombre?.toLowerCase().includes(busquedaMisRestaurantes.trim().toLowerCase())
  );

  return (
    <div style={styles.wrapper}>
      <header style={styles.header}>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          {onLogout && (
            <button
              onClick={() => setMostrarPerfil(v => !v)}
              aria-label="Perfil y configuración"
              style={styles.profileBtn}
            >
              ⚙️
            </button>
          )}
        </div>
        <h1 style={styles.title}>LoyalPass<span style={styles.dot}>.</span></h1>
        <p style={styles.subtitle}>Tus restaurantes</p>
      </header>

      {mostrarPerfil && onLogout && (
        <div style={styles.profilePanel}>
          <span style={{ fontSize: '0.8rem', color: 'var(--text)', opacity: 0.75 }}>
            {session?.user?.email}
          </span>
          <button
            onClick={() => {
              if (window.confirm('¿Cerrar sesión?')) onLogout();
            }}
            style={styles.logoutBtn}
          >
            Cerrar sesión
          </button>
        </div>
      )}

      {/* Mis restaurantes — única sección de la pantalla. Ya no existe
          "Descubre restaurantes": la única forma de unirse a un
          restaurante nuevo es el link/QR físico (?restaurante_id=), que
          App.jsx maneja por fuera de este componente. */}
      {cargando ? (
        <div style={styles.loadingRow}>
          <div className="loader-spinner" style={{ width: 16, height: 16, borderWidth: 2 }} />
          <span>Cargando tus restaurantes…</span>
        </div>
      ) : misRestaurantes.length === 0 ? (
        <p style={styles.empty}>
          Aún no estás inscrito en ningún restaurante. Escanea el código QR en tu restaurante favorito para unirte.
        </p>
      ) : (
        <section style={styles.section}>
          <p style={styles.sectionTitle}>Mis restaurantes</p>

          {/* Selector de notificaciones por restaurante */}
          <SelectorNotificaciones restaurantes={misRestaurantesConCliente} />

          {/* Buscador local: solo aparece si vale la pena (más de 3
              restaurantes inscritos). Reutiliza los mismos estilos del
              buscador que existía en "Descubre restaurantes" — no filtra
              contra la base de datos, solo el array ya cargado. */}
          {misRestaurantes.length > 3 && (
            <div style={styles.searchWrap}>
              <span style={styles.searchIcon}>🔍</span>
              <input
                type="text"
                placeholder="Buscar por nombre…"
                value={busquedaMisRestaurantes}
                onChange={(e) => setBusquedaMisRestaurantes(e.target.value)}
                style={styles.searchInput}
              />
            </div>
          )}

          <div style={styles.list}>
            {misRestaurantesFiltrados.map(r => {
              const datos = datosPorSede[r.id];
              const nivel = datos ? calcularNivel(datos.puntos) : null;
              return (
                <div
                  key={r.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => irA(r.nombre)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') irA(r.nombre); }}
                  style={{ ...styles.card, ...styles.cardMine }}
                >
                  <div style={styles.cardLeft}>
                    <div style={{ ...styles.avatar, ...styles.avatarMine }}>
                      {r.nombre?.charAt(0).toUpperCase()}
                    </div>
                    <div>
                      <div style={styles.cardName}>{r.nombre}</div>
                      {datos ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3 }}>
                          <span style={styles.badge}>
                            {nivel.emoji} {nivel.label} · {datos.puntos} pts
                          </span>
                          <span style={styles.ciclosBadge}>{datos.ciclos} ciclo{datos.ciclos !== 1 ? 's' : ''}</span>
                        </div>
                      ) : (
                        <div style={styles.badge}>✓ Inscrito · Ver mi perfil</div>
                      )}
                      <button
                        type="button"
                        onClick={(e) => abrirModalDesvincular(e, r)}
                        style={styles.linkDesvincular}
                      >
                        No seguir este restaurante
                      </button>
                    </div>
                  </div>
                  <span style={styles.arrow}>→</span>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <footer style={styles.footer}>LoyalPass v2.9</footer>

      {restauranteADesvincular && (
        <div style={styles.modalOverlay} onClick={cerrarModalDesvincular}>
          <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h3 style={styles.modalTitulo}>¿Desvincular de {restauranteADesvincular.nombre}?</h3>
            <p style={styles.modalTexto}>
              Al confirmar, perderás de forma permanente tus puntos acumulados en este restaurante
              y dejarás de recibir alertas push de proximidad.
            </p>
            {errorDesvinculo && <div className="error-alert">⚠️ {errorDesvinculo}</div>}
            <div style={styles.modalAcciones}>
              <button
                type="button"
                onClick={cerrarModalDesvincular}
                disabled={desvinculando}
                style={styles.btnCancelarDorado}
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={confirmarDesvincular}
                disabled={desvinculando}
                style={styles.btnConfirmarBaja}
              >
                {desvinculando ? 'Desvinculando…' : 'Confirmar baja'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const styles = {
  wrapper: {
    minHeight: '100vh',
    padding: '1.75rem 1rem 2rem',
    background: 'var(--bg-subtle)',
    display: 'flex',
    flexDirection: 'column',
    gap: '1.5rem',
    maxWidth: 520,
    margin: '0 auto',
    width: '100%',
  },
  header:    { textAlign: 'center' },
  profileBtn: {
    background: 'var(--bg-card)',
    border: '1px solid var(--border)',
    borderRadius: '50%',
    width: 36, height: 36,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: '1rem', cursor: 'pointer', flexShrink: 0,
  },
  profilePanel: {
    background: 'var(--bg-card)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--r-md)',
    padding: '0.75rem 1rem',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '0.75rem',
  },
  logoutBtn: {
    background: 'transparent',
    border: '1px solid var(--coral)',
    color: 'var(--coral)',
    borderRadius: 'var(--r-sm)',
    padding: '6px 12px',
    fontSize: '0.75rem',
    fontWeight: 700,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  title: {
    fontFamily: 'var(--font-display)',
    fontSize: '1.9rem',
    fontWeight: 800,
    color: 'var(--text-h)',
    letterSpacing: '-0.02em',
    margin: 0,
  },
  dot:      { color: 'var(--coral)' },
  subtitle: { fontSize: '0.875rem', color: 'var(--text)', opacity: 0.7, margin: '0.4rem 0 0' },
  section:  { display: 'flex', flexDirection: 'column', gap: '0.75rem' },
  sectionTitle: {
    fontSize: '10px',
    fontWeight: 700,
    letterSpacing: '0.1em',
    textTransform: 'uppercase',
    color: 'var(--text)',
    opacity: 0.6,
    margin: 0,
  },
  searchWrap: { position: 'relative', display: 'flex', alignItems: 'center' },
  searchIcon: {
    position: 'absolute', left: 14,
    fontSize: '0.95rem', opacity: 0.55, pointerEvents: 'none',
  },
  searchInput: {
    width: '100%',
    padding: '13px 14px 13px 40px',
    border: '1px solid var(--border)',
    borderRadius: 'var(--r-md)',
    background: 'var(--bg-card)',
    fontSize: '0.95rem',
    fontFamily: 'var(--font-body)',
    color: 'var(--text-h)',
    outline: 'none',
  },
  list:  { display: 'flex', flexDirection: 'column', gap: '0.6rem' },
  card: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0.85rem 1rem',
    background: 'var(--bg-card)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--r-lg)',
    cursor: 'pointer',
    textAlign: 'left',
    fontFamily: 'var(--font-body)',
    transition: 'transform .15s, box-shadow .15s',
    boxShadow: 'var(--shadow-card)',
  },
  cardMine: {
    border: '1px solid var(--coral-border)',
    background: 'var(--coral-light)',
  },
  cardLeft:  { display: 'flex', alignItems: 'center', gap: '0.85rem' },
  avatar: {
    width: 42, height: 42,
    borderRadius: '50%',
    background: 'var(--bg-subtle)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontFamily: 'var(--font-display)',
    fontWeight: 700,
    color: 'var(--text-h)',
    fontSize: '1.05rem',
    flexShrink: 0,
  },
  avatarMine: { background: 'white', color: 'var(--coral)' },
  cardName: {
    fontWeight: 700,
    color: 'var(--text-h)',
    fontSize: '0.95rem',
    fontFamily: 'var(--font-display)',
  },
  badge:      { fontSize: '0.72rem', color: 'var(--coral)', fontWeight: 600 },
  ciclosBadge: {
    fontSize: '0.68rem',
    background: 'rgba(255,255,255,0.6)',
    color: '#666',
    borderRadius: 99,
    padding: '1px 7px',
    fontWeight: 600,
  },
  arrow:  { fontSize: '1.1rem', opacity: 0.5 },
  empty: { fontSize: '0.85rem', color: 'var(--text)', opacity: 0.6, textAlign: 'center', padding: '1rem' },
  loadingRow: {
    display: 'flex', alignItems: 'center', gap: '0.6rem',
    fontSize: '0.85rem', color: 'var(--text)', opacity: 0.7,
    padding: '0.5rem',
  },
  footer: {
    textAlign: 'center',
    fontSize: '0.7rem',
    opacity: 0.4,
    marginTop: 'auto',
    paddingTop: '1.5rem',
  },

  // "No seguir este restaurante" — opción sutil dentro de la tarjeta, nunca
  // más prominente que el nombre/nivel del restaurante.
  linkDesvincular: {
    display: 'block',
    marginTop: 6,
    padding: 0,
    background: 'none',
    border: 'none',
    color: 'var(--text)',
    opacity: 0.55,
    fontSize: '0.68rem',
    fontFamily: 'var(--font-body)',
    textDecoration: 'underline',
    textDecorationColor: 'rgba(245,245,220,0.3)',
    cursor: 'pointer',
  },

  // Modal premium de confirmación — mismo lenguaje visual que
  // CuentaScreen.css (.cuenta-modal / .cuenta-modal-peligro /
  // .cuenta-btn-eliminar-confirmar): fondo carbón mate, borde bronce.
  modalOverlay: {
    position: 'fixed',
    inset: 0,
    zIndex: 300,
    background: 'rgba(0,0,0,0.6)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '1.25rem',
  },
  modal: {
    width: '100%',
    maxWidth: 420,
    background: 'var(--luxury-dark)',
    border: '1px solid rgba(169,105,79,0.4)',
    borderRadius: 'var(--r-xl)',
    padding: '1.5rem',
    boxShadow: '0 20px 60px rgba(0,0,0,0.6)',
  },
  modalTitulo: {
    fontFamily: 'var(--font-display)',
    fontWeight: 800,
    fontSize: '1.05rem',
    color: 'var(--text-h)',
    margin: '0 0 1rem',
  },
  modalTexto: {
    fontSize: '0.85rem',
    color: 'var(--text)',
    lineHeight: 1.6,
    margin: 0,
  },
  modalAcciones: {
    display: 'flex',
    gap: 10,
    marginTop: '1.25rem',
  },
  // "Confirmar baja" — rojo bronce apagado (idéntico a
  // .cuenta-btn-eliminar-confirmar en CuentaScreen.css).
  btnConfirmarBaja: {
    flex: 1,
    padding: 12,
    background: 'linear-gradient(135deg, #8A5236 0%, #5E3220 100%)',
    color: '#F5E9DD',
    border: 'none',
    borderRadius: 'var(--r-md)',
    fontWeight: 700,
    fontSize: '0.85rem',
    fontFamily: 'var(--font-body)',
    cursor: 'pointer',
  },
  // "Cancelar" — dorado metálico (idéntico a .cuenta-btn-guardar).
  btnCancelarDorado: {
    flex: 1,
    padding: 12,
    background: 'var(--gold-gradient)',
    color: '#14100A',
    border: 'none',
    borderRadius: 'var(--r-md)',
    fontWeight: 800,
    fontSize: '0.85rem',
    fontFamily: 'var(--font-display)',
    letterSpacing: '0.02em',
    cursor: 'pointer',
  },
};
