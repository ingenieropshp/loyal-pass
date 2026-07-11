import { useState, useEffect, useMemo } from 'react';
import { GeofencingProvider } from './components/GeofencingProvider';
import { RegistrationForm } from './components/RegistrationForm';
import { SuccessCard }      from './components/manejarRegistro';
import { UserDashboard }    from './components/UserDashboard';
import { BuscadorRestaurantes } from './components/BuscadorRestaurantes';
import { useLocation }      from './hooks/useLocation';
import { supabase }         from './services/supabaseClient';
import './App.css';

function App() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);

  // Si NO viene ?r=, mostramos el buscador global de restaurantes.
  const rRaw = params.get('r');
  const restauranteID = rRaw ? decodeURIComponent(rRaw).trim() : null;

  const [clienteId,       setClienteId]       = useState(() => {
    if (!restauranteID) return null;
    const registros = JSON.parse(localStorage.getItem('bistro_multisede') || '{}');
    return registros[restauranteID] || null;
  });
  const [nombreCliente,   setNombreCliente]    = useState('');
  const [puntosCliente,   setPuntosCliente]    = useState(0);
  const [isRegisteredNow, setIsRegisteredNow]  = useState(false);
  const [isVerifyingUser, setIsVerifyingUser]  = useState(!!restauranteID);
  const [referidoPor,     setReferidoPor]      = useState('');
  const [bistroLoc,       setBistroLoc]        = useState(null);
  const [sedeNoEncontrada, setSedeNoEncontrada] = useState(false);

  useEffect(() => {
    const ref = params.get('ref');
    if (ref) setReferidoPor(ref);
  }, [params]);

  useEffect(() => {
    if (!restauranteID) return;
    const inicializarDatos = async () => {
      setIsVerifyingUser(true);
      try {
        const esUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(restauranteID);
        let q = supabase.from('configuracion').select('id, nombre');
        q = esUUID ? q.eq('id', restauranteID) : q.ilike('nombre', restauranteID);
        const { data: sede, error: errorSede } = await q.maybeSingle();

        if (errorSede || !sede) {
          console.warn('⚠️ Sede no encontrada:', restauranteID);
          setSedeNoEncontrada(true);
          setIsVerifyingUser(false);
          return;
        }

        if (clienteId) {
          const { data: userDB, error: errorUser } = await supabase
            .from('clientes').select('id, nombre, puntos')
            .eq('id', clienteId).maybeSingle();

          if (errorUser || !userDB) {
            const registros = JSON.parse(localStorage.getItem('bistro_multisede') || '{}');
            delete registros[restauranteID];
            localStorage.setItem('bistro_multisede', JSON.stringify(registros));
            setClienteId(null);
          } else {
            setNombreCliente(userDB.nombre);
            setPuntosCliente(userDB.puntos);
          }
        }

        const { data: gpsData } = await supabase
          .from('conexion').select('*')
          .eq('restaurante_id', sede.id).maybeSingle();

        if (gpsData) setBistroLoc({ ...gpsData, nombre: sede.nombre });
        else setBistroLoc({ restaurante_id: sede.id, nombre: sede.nombre, latitud: null, longitud: null });
      } catch (err) {
        console.error('Error en inicialización:', err);
      } finally {
        setIsVerifyingUser(false);
      }
    };
    inicializarDatos();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restauranteID]);

  useEffect(() => {
    if (!restauranteID) return;
    const registros    = JSON.parse(localStorage.getItem('bistro_multisede') || '{}');
    const idEnEstaSede = registros[restauranteID] || null;
    if (idEnEstaSede !== clienteId) setClienteId(idEnEstaSede);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restauranteID]);

  // ── REALTIME: escuchar cambios de GPS/radio Y configuración en tiempo real ──
  useEffect(() => {
    // Solo activar cuando ya tenemos el ID del restaurante cargado
    if (!bistroLoc?.restaurante_id) return;

    const restauranteId = bistroLoc.restaurante_id;

    // ── Canal 1: tabla `conexion` ─────────────────────────────────────────────
    // Escucha cambios de latitud, longitud y radio_aviso que hace el admin.
    // Cuando el admin mueve el pin en el mapa o ajusta el radio, este canal
    // recibe el UPDATE y actualiza bistroLoc → useLocation recalcula distancia.
    const chConexion = supabase
      .channel(`realtime-conexion-${restauranteId}`)
      .on(
        'postgres_changes',
        {
          event:  'UPDATE',
          schema: 'public',
          table:  'conexion',
          filter: `restaurante_id=eq.${restauranteId}`, // solo este restaurante
        },
        (payload) => {
          // Fusionar los nuevos valores GPS conservando el nombre y otros campos
          setBistroLoc(prev => ({ ...prev, ...payload.new }));
        }
      )
      .subscribe();

    // ── Canal 2: tabla `configuracion` ───────────────────────────────────────
    // Escucha cambios de nombre, mensaje_promo y estado activo/inactivo.
    // Cuando el admin pausa la campaña o cambia el mensaje, se refleja aquí.
    const chConfig = supabase
      .channel(`realtime-config-${restauranteId}`)
      .on(
        'postgres_changes',
        {
          event:  'UPDATE',
          schema: 'public',
          table:  'configuracion',
          filter: `id=eq.${restauranteId}`, // solo este restaurante
        },
        (payload) => {
          // Actualizar nombre y mensaje_promo en bistroLoc para que
          // config (useMemo) los recalcule automáticamente
          setBistroLoc(prev => ({
            ...prev,
            nombre:        payload.new.nombre        ?? prev.nombre,
            mensaje_promo: payload.new.mensaje_promo ?? prev.mensaje_promo,
          }));
        }
      )
      .subscribe();

    // Limpiar ambos canales cuando el componente se desmonta o cambia el ID
    return () => {
      supabase.removeChannel(chConexion);
      supabase.removeChannel(chConfig);
    };
  }, [bistroLoc?.restaurante_id]); // Solo se re-ejecuta si cambia el restaurante

  const { distance: distancia, error: geoError } = useLocation(
    bistroLoc?.latitud  ?? null,
    bistroLoc?.longitud ?? null
  );

  const config = useMemo(() => ({
    radioAviso:   bistroLoc?.radio_aviso ? Number(bistroLoc.radio_aviso) : 800,
    mensaje:      bistroLoc?.mensaje_promo || 'CORTESÍA DISPONIBLE',
    nombreBistro: bistroLoc?.nombre || restauranteID,
  }), [bistroLoc, restauranteID]);

  const volverAlBuscador = () => { window.location.href = '/'; };

  const handleSuccess = (nuevoId, nombre, puntos) => {
    const registros = JSON.parse(localStorage.getItem('bistro_multisede') || '{}');
    registros[restauranteID] = nuevoId;
    localStorage.setItem('bistro_multisede', JSON.stringify(registros));
    setClienteId(nuevoId);
    setNombreCliente(nombre);
    setPuntosCliente(puntos);
    setIsRegisteredNow(true);
  };

  // ── QR GENERAL → Buscador de restaurantes ────────────────────────────────
  if (!restauranteID) {
    return <BuscadorRestaurantes />;
  }

  // ── Sede no encontrada ───────────────────────────────────────────────────
  if (sedeNoEncontrada) {
    return (
      <div className="main-wrapper" style={{ justifyContent: 'center', gap: '1rem', textAlign: 'center', padding: '2rem' }}>
        <h2 style={{ fontFamily: 'var(--font-display)', color: 'var(--text-h)' }}>Restaurante no encontrado</h2>
        <p style={{ fontSize: '0.9rem', opacity: 0.7 }}>“{restauranteID}” no está afiliado.</p>
        <button onClick={volverAlBuscador} style={{
          padding: '12px 20px', background: 'var(--coral)', color: 'white',
          border: 'none', borderRadius: 'var(--r-md)', fontWeight: 700, cursor: 'pointer',
        }}>← Ver todos los restaurantes</button>
      </div>
    );
  }

  // ── Pantalla de carga ─────────────────────────────────────────────────────
  if (isVerifyingUser || !bistroLoc) {
    return (
      <div className="main-wrapper" style={{ justifyContent: 'center', gap: '1rem' }}>
        <div className="loader-spinner" />
        <p style={{ fontSize: '0.8rem', opacity: 0.5, letterSpacing: '0.04em' }}>
          {isVerifyingUser ? 'Verificando cuenta…' : `Sincronizando con ${restauranteID}…`}
        </p>
      </div>
    );
  }

  // ── Pantalla de éxito ─────────────────────────────────────────────────────
  if (isRegisteredNow) {
    return (
      <SuccessCard
        restauranteId={bistroLoc.restaurante_id}
        nombreRestaurante={config.nombreBistro}
        nombreCliente={nombreCliente}
        clienteId={clienteId}
        puntosActuales={puntosCliente}
        onClose={volverAlBuscador}
      />
    );
  }

  const esCerca = typeof distancia === 'number' && distancia <= config.radioAviso;

  // ── App principal ─────────────────────────────────────────────────────────
  return (
    <div className="main-wrapper">
      <button onClick={volverAlBuscador} style={{
        alignSelf: 'flex-start', margin: '0.75rem 0 0 0.5rem',
        background: 'transparent', border: 'none', color: 'var(--text)',
        fontSize: '0.85rem', cursor: 'pointer', opacity: 0.7,
      }}>← Buscador</button>

      <header style={{ textAlign: 'center', margin: '0.5rem 0 1.5rem', width: '100%' }}>
        <h1 className="bistro-title">
          {config.nombreBistro}<span className="dot">.</span>
        </h1>
        {referidoPor && (
          <p style={{ marginTop: '0.4rem', fontSize: '0.8rem', opacity: 0.6 }}>
            Invitado por <strong>{referidoPor}</strong>
          </p>
        )}
      </header>

      {geoError && <div className="error-alert">⚠️ {geoError}</div>}

      {typeof distancia === 'number' ? (
        <div className={`proximity-badge${esCerca ? ' near' : ''}`}>
          <div className="prox-icon-wrap">
            {esCerca ? '✓' : '📍'}
          </div>
          <div style={{ flex: 1 }}>
            <div className="prox-label">{esCerca ? '¡Bienvenido!' : 'Estás a'}</div>
            <div className="prox-distance">
              {esCerca
                ? 'Estás aquí'
                : distancia >= 1000
                  ? `${(distancia / 1000).toFixed(1)} km`
                  : `${Math.round(distancia)} metros`}
            </div>
          </div>
          {bistroLoc?.latitud && bistroLoc?.longitud && (
            <a
              href={`https://www.google.com/maps/dir/?api=1&destination=${bistroLoc.latitud},${bistroLoc.longitud}`}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '2px',
                padding: '6px 10px',
                background: esCerca ? 'rgba(255,255,255,0.35)' : 'rgba(220,80,50,0.12)',
                borderRadius: '10px',
                textDecoration: 'none',
                color: esCerca ? 'white' : 'var(--coral, #e04a2f)',
                fontSize: '0.65rem',
                fontWeight: 700,
                letterSpacing: '0.03em',
                whiteSpace: 'nowrap',
                flexShrink: 0,
              }}
              title="Abrir en Google Maps"
            >
              <span style={{ fontSize: '1.3rem', lineHeight: 1 }}>🗺️</span>
              Cómo llegar
            </a>
          )}
        </div>
      ) : (
        <div className="gps-loader">
          <div className="loader-spinner" style={{ width: 16, height: 16, borderWidth: 2 }} />
          Buscando ubicación…
        </div>
      )}

      <main className="animate-fade-in">
        {clienteId ? (
          <UserDashboard
            restauranteId={bistroLoc.restaurante_id}
            clienteId={clienteId}
            distancia={distancia}
            esCerca={esCerca}
            nombreRestaurante={config.nombreBistro}
          />
        ) : (
          <RegistrationForm
            restaurantId={bistroLoc.restaurante_id}
            referidoPor={referidoPor}
            onSuccess={handleSuccess}
          />
        )}
      </main>

      <footer className="version-footer">
        Bistro Connect v2.8 · {config.nombreBistro}
      </footer>
    </div>
  );
}

function AppConGeofencing() {
  return (
    <GeofencingProvider>
      <App />
    </GeofencingProvider>
  );
}

export default AppConGeofencing;
