import { useState, useEffect, useMemo } from 'react';
import { RegistrationForm } from './components/RegistrationForm';
import { SuccessCard }      from './components/manejarRegistro';
import { UserDashboard }    from './components/UserDashboard';
import { useLocation }      from './hooks/useLocation';
import { supabase }         from './services/supabaseClient';
import './App.css';

function App() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);

  const restauranteID = useMemo(() => {
    const rRaw = params.get('r');
    return rRaw ? decodeURIComponent(rRaw).trim() : '101 Bistro';
  }, [params]);

  const [clienteId,       setClienteId]       = useState(() => {
    const registros = JSON.parse(localStorage.getItem('bistro_multisede') || '{}');
    return registros[restauranteID] || null;
  });
  const [nombreCliente,   setNombreCliente]    = useState('');
  const [puntosCliente,   setPuntosCliente]    = useState(0);
  const [isRegisteredNow, setIsRegisteredNow]  = useState(false);
  const [isVerifyingUser, setIsVerifyingUser]  = useState(true);
  const [referidoPor,     setReferidoPor]      = useState('');
  const [bistroLoc,       setBistroLoc]        = useState(null);

  useEffect(() => {
    const ref = params.get('ref');
    if (ref) setReferidoPor(ref);
  }, [params]);

  useEffect(() => {
    const inicializarDatos = async () => {
      if (!restauranteID) return;
      setIsVerifyingUser(true);
      try {
        const esUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(restauranteID);
        let q = supabase.from('configuracion').select('id, nombre');
        q = esUUID ? q.eq('id', restauranteID) : q.ilike('nombre', restauranteID);
        const { data: sede, error: errorSede } = await q.maybeSingle();

        if (errorSede || !sede) {
          console.warn('⚠️ Sede no encontrada:', restauranteID);
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
    const registros    = JSON.parse(localStorage.getItem('bistro_multisede') || '{}');
    const idEnEstaSede = registros[restauranteID] || null;
    if (idEnEstaSede !== clienteId) setClienteId(idEnEstaSede);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restauranteID]);

  useEffect(() => {
    if (!bistroLoc?.restaurante_id) return;
    const channel = supabase
      .channel(`gps-realtime-${bistroLoc.restaurante_id}`)
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'conexion',
          filter: `restaurante_id=eq.${bistroLoc.restaurante_id}` },
        (payload) => setBistroLoc(prev => ({ ...prev, ...payload.new }))
      ).subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [bistroLoc?.restaurante_id]);

  const { distance: distancia, error: geoError } = useLocation(
    bistroLoc?.latitud  ?? null,
    bistroLoc?.longitud ?? null
  );

  const config = useMemo(() => ({
    radioAviso:   bistroLoc?.radio_aviso ? Number(bistroLoc.radio_aviso) : 800,
    mensaje:      bistroLoc?.mensaje_promo || 'CORTESÍA DISPONIBLE',
    nombreBistro: bistroLoc?.nombre || restauranteID,
  }), [bistroLoc, restauranteID]);

  const handleSuccess = (nuevoId, nombre, puntos) => {
    const registros = JSON.parse(localStorage.getItem('bistro_multisede') || '{}');
    registros[restauranteID] = nuevoId;
    localStorage.setItem('bistro_multisede', JSON.stringify(registros));
    setClienteId(nuevoId);
    setNombreCliente(nombre);
    setPuntosCliente(puntos);
    setIsRegisteredNow(true);
  };

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
        onClose={() => setIsRegisteredNow(false)}
      />
    );
  }

  const esCerca = typeof distancia === 'number' && distancia <= config.radioAviso;

  // ── App principal ─────────────────────────────────────────────────────────
  return (
    <div className="main-wrapper">
      <header style={{ textAlign: 'center', margin: '1.75rem 0 1.5rem', width: '100%' }}>
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
          <div>
            <div className="prox-label">{esCerca ? '¡Bienvenido!' : 'Estás a'}</div>
            <div className="prox-distance">
              {esCerca
                ? 'Estás aquí'
                : distancia >= 1000
                  ? `${(distancia / 1000).toFixed(1)} km`
                  : `${Math.round(distancia)} metros`}
            </div>
          </div>
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
        Bistro Connect v2.7 · {config.nombreBistro}
      </footer>
    </div>
  );
}

export default App;
