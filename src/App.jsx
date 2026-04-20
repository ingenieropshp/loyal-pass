import { useState, useEffect, useMemo, useRef } from 'react'; 
import { RegistrationForm } from './components/RegistrationForm';
import { SuccessCard, manejarRegistro } from './components/manejarRegistro'; 
import { UserDashboard } from './components/UserDashboard'; 
import { useLocation } from './hooks/useLocation';
import { supabase } from './services/supabaseClient'; 
import './App.css';

function App() {
  // --- PARÁMETROS Y CONFIGURACIÓN ---
  const params = useMemo(() => new URLSearchParams(window.location.search), []);

  const restauranteID = useMemo(() => {
    const rRaw = params.get('r');
    if (rRaw) {
      return decodeURIComponent(rRaw).trim();
    }
    return '101 Bistro';
  }, [params]);

  // --- ESTADOS DE USUARIO ---
  const [clienteId, setClienteId] = useState(() => {
    const registros = JSON.parse(localStorage.getItem("bistro_multisede") || "{}");
    return registros[restauranteID] || null;
  });
  
  const [nombreCliente, setNombreCliente] = useState(""); 
  const [puntosCliente, setPuntosCliente] = useState(0); 
  const [isRegisteredNow, setIsRegisteredNow] = useState(false); 
  const [isVerifyingUser, setIsVerifyingUser] = useState(true); 

  // --- OTROS ESTADOS ---
  const [referidoPor, setReferidoPor] = useState("");
  const [bistroLoc, setBistroLoc] = useState(null);

  // --- REFERENCIA PARA REALTIME ---
  const bistroLocRef = useRef(bistroLoc);
  useEffect(() => {
    bistroLocRef.current = bistroLoc;
  }, [bistroLoc]);

  useEffect(() => {
    const ref = params.get('ref');
    if (ref) setReferidoPor(ref);
  }, [params]);

  // --- VERIFICACIÓN DE EXISTENCIA Y CARGA DE DATOS ---
  useEffect(() => {
    const inicializarDatos = async () => {
      if (!restauranteID) return;
      setIsVerifyingUser(true);

      try {
        const esUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(restauranteID);
        let querySede = supabase.from('configuracion').select('id, nombre');

        if (esUUID) querySede = querySede.eq('id', restauranteID);
        else querySede = querySede.ilike('nombre', restauranteID);

        const { data: sede, error: errorSede } = await querySede.maybeSingle();

        if (errorSede || !sede) {
          console.warn("⚠️ No se encontró la sede:", restauranteID);
          setIsVerifyingUser(false);
          return;
        }

        if (clienteId) {
          const { data: userDB, error: errorUser } = await supabase
            .from('clientes')
            .select('id, nombre, puntos')
            .eq('id', clienteId)
            .maybeSingle();

          if (errorUser || !userDB) {
            console.warn("Usuario no encontrado en DB, limpiando sesión local...");
            const registros = JSON.parse(localStorage.getItem("bistro_multisede") || "{}");
            delete registros[restauranteID];
            localStorage.setItem("bistro_multisede", JSON.stringify(registros));
            setClienteId(null);
          } else {
            setNombreCliente(userDB.nombre);
            setPuntosCliente(userDB.puntos);
          }
        }

        const { data: gpsData } = await supabase
          .from('conexion')
          .select('*')
          .eq('restaurante_id', sede.id)
          .maybeSingle();

        if (gpsData) {
          setBistroLoc({ ...gpsData, nombre: sede.nombre });
        }
      } catch (err) {
        console.error("Error inesperado:", err);
      } finally {
        setIsVerifyingUser(false);
      }
    };

    inicializarDatos();
  }, [restauranteID, clienteId]);

  // --- CAMBIO DE SEDE DINÁMICO ---
  useEffect(() => {
    const registros = JSON.parse(localStorage.getItem("bistro_multisede") || "{}");
    const idEnEstaSede = registros[restauranteID] || null;
    if (idEnEstaSede !== clienteId) {
      setClienteId(idEnEstaSede);
    }
  }, [restauranteID]);

  // --- SUSCRIPCIÓN REALTIME ---
  useEffect(() => {
    if (!bistroLoc?.restaurante_id) return;

    const channel = supabase
      .channel(`gps-realtime-${bistroLoc.restaurante_id}`)
      .on(
        'postgres_changes',
        { 
          event: 'UPDATE', 
          schema: 'public', 
          table: 'conexion',
          filter: `restaurante_id=eq.${bistroLoc.restaurante_id}`
        },
        (payload) => {
          setBistroLoc(prev => ({ ...prev, ...payload.new }));
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [bistroLoc?.restaurante_id]);

  // --- UBICACIÓN ---
  const { distance: distancia, error: geoError } = useLocation(
    bistroLoc?.latitud ?? null, 
    bistroLoc?.longitud ?? null
  );

  // --- LÓGICA DE ÉXITO ---
  const handleSuccess = (nuevoId, nombre, puntos) => {
    const registros = JSON.parse(localStorage.getItem("bistro_multisede") || "{}");
    registros[restauranteID] = nuevoId;
    
    localStorage.setItem("bistro_multisede", JSON.stringify(registros));
    
    setClienteId(nuevoId);
    setNombreCliente(nombre);
    setPuntosCliente(puntos); 
    
    setIsRegisteredNow(true); 
  };

  // --- NUEVA LÓGICA AL ENVIAR SOLICITADA ---
  const alEnviar = (id, nombre, puntos) => {
    handleSuccess(id, nombre, puntos);
  };

  const config = useMemo(() => {
    const radioBD = bistroLoc?.radio_aviso; 
    const mensajeBD = bistroLoc?.mensaje_promo;

    return {
      radioAviso: radioBD ? Number(radioBD) : 800,
      mensaje: mensajeBD || 'CORTESÍA DISPONIBLE',
      nombreBistro: bistroLoc?.nombre || restauranteID 
    };
  }, [bistroLoc, restauranteID]);

  if (isVerifyingUser || !bistroLoc) {
    return (
      <div className="main-wrapper" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
        <div className="loader-spinner"></div>
        <div style={{ textAlign: 'center', opacity: 0.6, marginTop: '1rem' }}>
          ⌛ {isVerifyingUser ? 'Verificando cuenta...' : `Sincronizando con ${restauranteID}...`}
        </div>
      </div>
    );
  }

  if (isRegisteredNow) {
    return (
      <SuccessCard 
        restauranteId={restauranteID} 
        nombreRestaurante={config.nombreBistro} 
        nombreCliente={nombreCliente}
        clienteId={clienteId}
        puntos={puntosCliente}
        onClose={() => setIsRegisteredNow(false)} 
      />
    );
  }

  const esCerca = typeof distancia === 'number' && distancia <= config.radioAviso;

  return (
    <div className="main-wrapper">
      <header style={{ textAlign: 'center', marginBottom: '2rem', marginTop: '2rem' }}>
        <h1 className="bistro-title" style={{ fontSize: '3.5rem', fontWeight: '900' }}>
            {config.nombreBistro}<span style={{ color: 'var(--accent)' }}>.</span>
        </h1>
        {referidoPor && <p style={{ opacity: 0.7 }}>Invitado por: <strong>{referidoPor}</strong></p>}
      </header>

      {geoError && <div className="error-alert">⚠️ {geoError}</div>}

      {typeof distancia === 'number' ? (
        <div className={`proximity-badge ${esCerca ? 'near' : ''}`}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', justifyContent: 'center' }}>
            <span style={{ fontSize: '1.5rem' }}>{esCerca ? '✨' : '📍'}</span>
            <div style={{ textAlign: 'left' }}>
              <p style={{ margin: 0, fontSize: '9px', fontWeight: 900 }}>{esCerca ? '¡BIENVENIDO!' : 'ESTÁS A'}</p>
              <p style={{ margin: 0, fontWeight: '900', fontSize: '1.2rem' }}>
                {distancia >= 1000 ? `${(distancia / 1000).toFixed(1)} km` : `${Math.round(distancia)} metros`}
              </p>
            </div>
          </div>
        </div>
      ) : (
        <div className="gps-loader">Buscando ubicación...</div>
      )}

      <main className="animate-fade-in" style={{ marginTop: '2rem' }}>
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
            onSuccess={alEnviar} 
          />
        )}
      </main>
      
      <footer className="version-footer" style={{ marginTop: '4rem', opacity: 0.4, textAlign: 'center', fontSize: '10px' }}>
        BISTRO CONNECT v2.6 - {config.nombreBistro}
      </footer>
    </div>
  );
}

export default App;