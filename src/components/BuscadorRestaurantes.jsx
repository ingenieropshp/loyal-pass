import { useState, useEffect } from 'react';
import { supabase } from '../services/supabaseClient';
import { SelectorNotificaciones } from './SelectorNotificaciones';

const calcularNivel = (ciclos = 0) => {
  if (ciclos >= 10) return { label: 'Oro',    emoji: '🥇' };
  if (ciclos >= 5)  return { label: 'Plata',  emoji: '🥈' };
  return                   { label: 'Bronce', emoji: '🥉' };
};

/**
 * BuscadorRestaurantes — pantalla "home" después del login global.
 * Props:
 *   session   → sesión activa de Supabase Auth (App.jsx garantiza que
 *               este componente solo se monta cuando ya existe sesión).
 *   onLogout  → cierra sesión (mismo handler que usa UserDashboard).
 */
export const BuscadorRestaurantes = ({ session, onLogout }) => {
  const [restaurantes, setRestaurantes] = useState([]);
  const [busqueda, setBusqueda]         = useState('');
  const [cargando, setCargando]         = useState(true);
  const [error, setError]               = useState(null);
  const [mostrarPerfil, setMostrarPerfil] = useState(false);
  // datos enriquecidos del cliente por sede: { [restauranteId]: { puntos, ciclos, nombre } }
  const [datosPorSede, setDatosPorSede] = useState({});

  useEffect(() => {
    const cargar = async () => {
      setCargando(true);
      try {
        const { data, error: err } = await supabase
          .from('configuracion')
          .select('id, nombre')
          .order('nombre', { ascending: true });
        if (err) throw err;
        setRestaurantes(data || []);

        // ── Restaurantes donde el usuario YA está inscrito ────────────────
        // Antes esto se leía de localStorage (bistro_multisede), lo que
        // significaba que si el usuario borraba la app o cambiaba de
        // dispositivo, perdía la vista de "Mis restaurantes" aunque sus
        // puntos seguían intactos en la base de datos. Ahora se consulta
        // directamente por `auth_user_id`, que es la cuenta global — así
        // esta lista es la misma sin importar desde dónde entre.
        if (session?.user?.id) {
          const { data: clientesData, error: errCli } = await supabase
            .from('clientes')
            .select('id, nombre, puntos, ciclos_completados, restaurante_id')
            .eq('auth_user_id', session.user.id);
          if (errCli) throw errCli;

          const mapa = {};
          (clientesData || []).forEach(c => {
            mapa[c.restaurante_id] = {
              puntos:  c.puntos || 0,
              ciclos:  c.ciclos_completados || 0,
              nombre:  c.nombre,
            };
          });
          setDatosPorSede(mapa);
        }
      } catch (e) {
        console.error(e);
        setError('No pudimos cargar los restaurantes. Intenta de nuevo.');
      } finally {
        setCargando(false);
      }
    };
    cargar();
  }, [session?.user?.id]);

  // Navega a la vista de la sede. App.jsx verifica ahí si el usuario ya
  // tiene una fila en `clientes` para ese restaurante (misma sesión
  // global, distinta sede):
  //   - Si ya está inscrito → entra directo a su tarjeta de fidelización.
  //   - Si NO está inscrito → NO se le crea nada automáticamente; se le
  //     muestra primero "Crea tu perfil" para que decida, con control
  //     total, si quiere unirse a este restaurante.
  const irA = (nombre) => { window.location.href = `/?r=${encodeURIComponent(nombre)}`; };

  const filtrados = restaurantes.filter(r =>
    r.nombre?.toLowerCase().includes(busqueda.trim().toLowerCase())
  );

  const misRestaurantes = restaurantes.filter(r => !!datosPorSede[r.id]);

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
        <h1 style={styles.title}>Bistro Connect<span style={styles.dot}>.</span></h1>
        <p style={styles.subtitle}>Encuentra tu restaurante favorito</p>
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

      {/* Mis restaurantes (vista multi-sede enriquecida) */}
      {misRestaurantes.length > 0 && (
        <section style={styles.section}>
          <p style={styles.sectionTitle}>Mis restaurantes</p>

          {/* Selector de notificaciones por restaurante */}
          <SelectorNotificaciones restaurantes={misRestaurantes} />

          <div style={styles.list}>
            {misRestaurantes.map(r => {
              const datos = datosPorSede[r.id];
              const nivel = datos ? calcularNivel(datos.ciclos) : null;
              return (
                <button key={r.id} onClick={() => irA(r.nombre)} style={{ ...styles.card, ...styles.cardMine }}>
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
                    </div>
                  </div>
                  <span style={styles.arrow}>→</span>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {/* Buscador */}
      <section style={styles.section}>
        <p style={styles.sectionTitle}>Descubre restaurantes</p>
        <div style={styles.searchWrap}>
          <span style={styles.searchIcon}>🔍</span>
          <input
            type="text"
            placeholder="Buscar por nombre…"
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
            style={styles.searchInput}
          />
        </div>

        {cargando && (
          <div style={styles.loadingRow}>
            <div className="loader-spinner" style={{ width: 16, height: 16, borderWidth: 2 }} />
            <span>Cargando restaurantes…</span>
          </div>
        )}

        {error && <div className="error-alert">⚠️ {error}</div>}

        {!cargando && !error && (
          <div style={styles.list}>
            {filtrados.length === 0 ? (
              <p style={styles.empty}>No encontramos restaurantes con "{busqueda}".</p>
            ) : (
              filtrados.map(r => {
                const datos    = datosPorSede[r.id];
                const inscrito = !!datos;
                const nivel    = datos ? calcularNivel(datos.ciclos) : null;
                return (
                  <button key={r.id} onClick={() => irA(r.nombre)}
                    style={inscrito ? { ...styles.card, ...styles.cardMine } : styles.card}>
                    <div style={styles.cardLeft}>
                      <div style={inscrito ? { ...styles.avatar, ...styles.avatarMine } : styles.avatar}>
                        {r.nombre?.charAt(0).toUpperCase()}
                      </div>
                      <div>
                        <div style={styles.cardName}>{r.nombre}</div>
                        {datos ? (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3 }}>
                            <span style={styles.badge}>{nivel.emoji} {nivel.label} · {datos.puntos} pts</span>
                          </div>
                        ) : (
                          <div style={styles.cardHint}>Toca para inscribirte</div>
                        )}
                      </div>
                    </div>
                    <span style={styles.arrow}>→</span>
                  </button>
                );
              })
            )}
          </div>
        )}
      </section>

      <footer style={styles.footer}>Bistro Connect v2.9</footer>
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
  cardHint:   { fontSize: '0.75rem', color: 'var(--text)', opacity: 0.7, marginTop: 2 },
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
};
