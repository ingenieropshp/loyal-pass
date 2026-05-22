import { useState, useEffect, useMemo } from 'react';
import { supabase } from '../services/supabaseClient';

/**
 * BuscadorRestaurantes
 * Pantalla inicial cuando el cliente entra por el QR GENERAL (sin ?r=).
 * - Muestra los restaurantes en los que YA está inscrito (desde localStorage).
 * - Permite buscar TODOS los restaurantes afiliados (tabla `configuracion`).
 * - Al elegir uno, redirige a /?r=<nombre> para inscribirse / entrar.
 */
export const BuscadorRestaurantes = () => {
  const [restaurantes, setRestaurantes] = useState([]);
  const [busqueda, setBusqueda]         = useState('');
  const [cargando, setCargando]         = useState(true);
  const [error, setError]               = useState(null);

  // IDs de restaurantes donde el cliente ya está inscrito
  const misInscripciones = useMemo(() => {
    try {
      return JSON.parse(localStorage.getItem('bistro_multisede') || '{}');
    } catch {
      return {};
    }
  }, []);

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
      } catch (e) {
        console.error(e);
        setError('No pudimos cargar los restaurantes. Intenta de nuevo.');
      } finally {
        setCargando(false);
      }
    };
    cargar();
  }, []);

  const irA = (nombre) => {
    window.location.href = `/?r=${encodeURIComponent(nombre)}`;
  };

  const filtrados = restaurantes.filter(r =>
    r.nombre?.toLowerCase().includes(busqueda.trim().toLowerCase())
  );

  const misRestaurantes = restaurantes.filter(r =>
    misInscripciones[r.nombre] || misInscripciones[r.id]
  );

  return (
    <div style={styles.wrapper}>
      <header style={styles.header}>
        <h1 style={styles.title}>Bistro Connect<span style={styles.dot}>.</span></h1>
        <p style={styles.subtitle}>Encuentra tu restaurante favorito</p>
      </header>

      {/* Mis restaurantes */}
      {misRestaurantes.length > 0 && (
        <section style={styles.section}>
          <p style={styles.sectionTitle}>Mis restaurantes</p>
          <div style={styles.list}>
            {misRestaurantes.map(r => (
              <button key={r.id} onClick={() => irA(r.nombre)} style={{ ...styles.card, ...styles.cardMine }}>
                <div style={styles.cardLeft}>
                  <div style={{ ...styles.avatar, ...styles.avatarMine }}>
                    {r.nombre?.charAt(0).toUpperCase()}
                  </div>
                  <div>
                    <div style={styles.cardName}>{r.nombre}</div>
                    <div style={styles.badge}>✓ Inscrito · Ver mi perfil</div>
                  </div>
                </div>
                <span style={styles.arrow}>→</span>
              </button>
            ))}
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
              <p style={styles.empty}>No encontramos restaurantes con “{busqueda}”.</p>
            ) : (
              filtrados.map(r => {
                const inscrito = !!(misInscripciones[r.nombre] || misInscripciones[r.id]);
                return (
                  <button key={r.id} onClick={() => irA(r.nombre)} style={styles.card}>
                    <div style={styles.cardLeft}>
                      <div style={styles.avatar}>
                        {r.nombre?.charAt(0).toUpperCase()}
                      </div>
                      <div>
                        <div style={styles.cardName}>{r.nombre}</div>
                        <div style={styles.cardHint}>
                          {inscrito ? '✓ Ya inscrito' : 'Toca para inscribirte'}
                        </div>
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

      <footer style={styles.footer}>Bistro Connect v2.7</footer>
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
  header: { textAlign: 'center' },
  title: {
    fontFamily: 'var(--font-display)',
    fontSize: '1.9rem',
    fontWeight: 800,
    color: 'var(--text-h)',
    letterSpacing: '-0.02em',
    margin: 0,
  },
  dot: { color: 'var(--coral)' },
  subtitle: { fontSize: '0.875rem', color: 'var(--text)', opacity: 0.7, margin: '0.4rem 0 0' },
  section: { display: 'flex', flexDirection: 'column', gap: '0.75rem' },
  sectionTitle: {
    fontSize: '10px',
    fontWeight: 700,
    letterSpacing: '0.1em',
    textTransform: 'uppercase',
    color: 'var(--text)',
    opacity: 0.6,
    margin: 0,
  },
  searchWrap: {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
  },
  searchIcon: {
    position: 'absolute',
    left: 14,
    fontSize: '0.95rem',
    opacity: 0.55,
    pointerEvents: 'none',
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
  list: { display: 'flex', flexDirection: 'column', gap: '0.6rem' },
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
  cardLeft: { display: 'flex', alignItems: 'center', gap: '0.85rem' },
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
  cardHint: { fontSize: '0.75rem', color: 'var(--text)', opacity: 0.7, marginTop: 2 },
  badge: { fontSize: '0.72rem', color: 'var(--coral)', marginTop: 2, fontWeight: 600 },
  arrow: { fontSize: '1.1rem', opacity: 0.5 },
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
