import { useState, useEffect, useMemo } from 'react';
import { GeofencingProvider } from './components/GeofencingProvider';
import { AuthScreen }       from './components/AuthScreen';
import { ResetPassword }    from './components/ResetPassword';
import { RegistrationForm } from './components/RegistrationForm';
import { SuccessCard }      from './components/manejarRegistro';
import { UserDashboard }    from './components/UserDashboard';
import { BuscadorRestaurantes } from './components/BuscadorRestaurantes';
import { useLocation }      from './hooks/useLocation';
import { supabase, buscarClienteEnRestaurante } from './services/supabaseClient';
import './App.css';

function App() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);

  // El QR impreso en el local codifica ?restaurante_id=<id>. Seguimos
  // aceptando también ?r=<id-o-nombre> por compatibilidad con links/QRs
  // generados antes de este cambio — ambos apuntan a la misma sede.
  const idParamRaw = params.get('restaurante_id') || params.get('r');
  const restauranteID = idParamRaw ? decodeURIComponent(idParamRaw).trim() : null;

  // ── Sesión persistente de Supabase Auth ───────────────────────────────
  // `session` es null mientras no sabemos si hay un login guardado, y
  // pasa a `undefined` intencionalmente nunca: solo null (sin sesión) u
  // objeto de sesión. `sessionLoaded` distingue "todavía no verificamos"
  // de "ya verificamos y no hay sesión", para no mostrar pantallas de
  // login/registro de golpe mientras se resuelve el getSession() inicial.
  const [session,           setSession]           = useState(null);
  const [sessionLoaded,     setSessionLoaded]      = useState(false);
  // Se activa cuando el usuario vuelve del link de "recuperar contraseña"
  // de su correo (evento PASSWORD_RECOVERY de Supabase Auth).
  const [passwordRecovery,  setPasswordRecovery]   = useState(false);

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

  // ── Cargar sesión guardada + escuchar cambios de autenticación ─────────
  // getSession() lee el token que quedó en localStorage de una visita
  // anterior (si existe) y lo valida. onAuthStateChange se dispara cada
  // vez que el usuario inicia sesión, cierra sesión, o Supabase renueva
  // el token — así toda la app se mantiene sincronizada con el estado
  // real de autenticación sin tener que revisarlo manualmente en cada
  // componente.
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session: s } }) => {
      setSession(s);
      setSessionLoaded(true);
    });

    const { data: listener } = supabase.auth.onAuthStateChange((event, s) => {
      if (event === 'PASSWORD_RECOVERY') {
        // El usuario volvió del correo de recuperación: Supabase ya creó
        // una sesión temporal para permitirle cambiar la contraseña.
        setPasswordRecovery(true);
      }
      setSession(s);
      setSessionLoaded(true);
    });

    // Al desmontar, cancelamos la suscripción para no acumular listeners.
    return () => listener.subscription.unsubscribe();
  }, []);

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

        // ── Identificar al cliente ────────────────────────────────────
        // Prioridad 1: si hay sesión de Supabase Auth activa (login
        //   persistente global), esa es la fuente de verdad — pero ojo:
        //   tener sesión NO significa estar inscrito en ESTA sede. Solo
        //   VERIFICAMOS (buscarClienteEnRestaurante, solo lectura); nunca
        //   creamos la fila aquí. Si no existe, clienteId queda en null y
        //   más abajo se muestra el formulario "Crea tu perfil" para que
        //   el usuario decida, con control total, si quiere unirse a esta
        //   sede o no.
        // Prioridad 2 (compatibilidad hacia atrás): si no hay sesión pero
        //   sí hay un clienteId guardado en localStorage (usuarios que se
        //   registraron antes de esta actualización, con el formulario
        //   rápido sin cuenta), seguimos verificándolo como antes.
        if (session?.user) {
          const cliente = await buscarClienteEnRestaurante({
            authUserId: session.user.id,
            restauranteId: sede.id,
          });

          const registros = JSON.parse(localStorage.getItem('bistro_multisede') || '{}');
          if (cliente) {
            registros[restauranteID] = cliente.id;
            localStorage.setItem('bistro_multisede', JSON.stringify(registros));

            setClienteId(cliente.id);
            setNombreCliente(cliente.nombre);
            setPuntosCliente(cliente.puntos);
          } else {
            // Autenticado globalmente, pero aún NO inscrito en esta sede.
            delete registros[restauranteID];
            localStorage.setItem('bistro_multisede', JSON.stringify(registros));
            setClienteId(null);
          }
        } else if (clienteId) {
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
    // Esperamos a que sessionLoaded sea true antes de decidir el camino
    // (auth vs. localStorage), para no crear por error una fila duplicada
    // en `clientes` mientras getSession() todavía está resolviendo.
    if (sessionLoaded) inicializarDatos();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restauranteID, sessionLoaded, session?.user?.id]);

  useEffect(() => {
    if (!restauranteID || session?.user) return; // con sesión, el efecto de arriba ya maneja el clienteId
    const registros    = JSON.parse(localStorage.getItem('bistro_multisede') || '{}');
    const idEnEstaSede = registros[restauranteID] || null;
    if (idEnEstaSede !== clienteId) setClienteId(idEnEstaSede);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restauranteID, session?.user]);

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

  // ── Cerrar sesión ─────────────────────────────────────────────────────
  // Se pasa como prop a UserDashboard para el botón "Cerrar sesión" en el
  // perfil/configuración. Además de cerrar la sesión de Supabase Auth,
  // limpiamos el registro local de esta sede para que, al recargar, la app
  // no intente reabrir el dashboard con un clienteId huérfano.
  const handleLogout = async () => {
    await supabase.auth.signOut();
    // Como ahora la cuenta es global (una sola sesión para todos los
    // restaurantes), al cerrar sesión limpiamos el mapa completo en vez de
    // solo la sede actual — si no, "Mis restaurantes" en el buscador
    // seguiría mostrando sedes de la cuenta anterior tras un cambio de usuario.
    localStorage.removeItem('bistro_multisede');
    setClienteId(null);
    setNombreCliente('');
    setPuntosCliente(0);
    setIsRegisteredNow(false);
    // `session` se actualiza solo vía onAuthStateChange (evento SIGNED_OUT).
  };

  // ── Pantalla de carga inicial (verificando si hay sesión guardada) ────────
  // Va primero que cualquier otra cosa: sin esto, por una fracción de
  // segundo se alcanzaría a mostrar el buscador o el AuthScreen de más,
  // antes de saber si el usuario ya tenía sesión persistida.
  if (!sessionLoaded) {
    return (
      <div className="main-wrapper" style={{ justifyContent: 'center', gap: '1rem' }}>
        <div className="loader-spinner" />
        <p style={{ fontSize: '0.8rem', opacity: 0.5, letterSpacing: '0.04em' }}>Verificando cuenta…</p>
      </div>
    );
  }

  // ── Recuperación de contraseña: tiene prioridad sobre cualquier otra pantalla ──
  if (passwordRecovery) {
    return (
      <div className="main-wrapper" style={{ justifyContent: 'center', padding: '2rem 1rem' }}>
        <header style={{ textAlign: 'center', margin: '0.5rem 0 1.5rem', width: '100%' }}>
          <h1 className="bistro-title">Bistro Connect<span className="dot">.</span></h1>
        </header>
        <ResetPassword onDone={() => setPasswordRecovery(false)} />
      </div>
    );
  }

  // ── GATE GLOBAL: sin cuenta unificada no se ve ni el buscador ni una sede ──
  // Este es el cambio central del flujo nuevo: antes, cada restaurante tenía
  // su propio formulario de registro. Ahora la cuenta (Supabase Auth) es
  // ÚNICA y global — se crea/inicia sesión UNA sola vez, antes de llegar a
  // "Descubre restaurantes".
  //
  // Si el usuario entró por un link/QR directo de un restaurante
  // (?restaurante_id=... o ?r=...) y aún no tiene sesión, seguimos esperando (spinner) a que `bistroLoc`
  // termine de cargar. AuthScreen SOLO crea/inicia la cuenta global (correo
  // + contraseña) — nunca inscribe en ningún restaurante. En cuanto la
  // sesión queda activa, este mismo componente vuelve a renderizar, el
  // efecto de arriba verifica si ya existe una fila en `clientes` para esta
  // sede y, si no, se muestra "Crea tu perfil" (RegistrationForm) sin
  // perder el contexto del link/QR que escaneó.
  if (!session?.user) {
    if (restauranteID && (isVerifyingUser || !bistroLoc) && !sedeNoEncontrada) {
      return (
        <div className="main-wrapper" style={{ justifyContent: 'center', gap: '1rem' }}>
          <div className="loader-spinner" />
          <p style={{ fontSize: '0.8rem', opacity: 0.5, letterSpacing: '0.04em' }}>Cargando…</p>
        </div>
      );
    }
    return (
      <div className="main-wrapper" style={{ justifyContent: 'center', padding: '2rem 1rem' }}>
        <header style={{ textAlign: 'center', margin: '0.5rem 0 1.5rem', width: '100%' }}>
          <h1 className="bistro-title">Bistro Connect<span className="dot">.</span></h1>
        </header>
        <AuthScreen
          restaurantId={sedeNoEncontrada ? null : bistroLoc?.restaurante_id}
        />
      </div>
    );
  }

  // ── Ya autenticado, sin ?restaurante_id= (ni ?r=) en la URL → buscador ───
  if (!restauranteID) {
    return <BuscadorRestaurantes session={session} onLogout={handleLogout} />;
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
            <div className="prox-label">{esCerca ? '¡Bienvenido! Estás a' : 'Estás a'}</div>
            <div className="prox-distance">
              {distancia >= 1000
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
            onLogout={handleLogout}
          />
        ) : (
          // Ya hay sesión global (session.user existe — de lo contrario no
          // llegaríamos aquí, ver el GATE más arriba), pero todavía no hay
          // una fila en `clientes` para ESTA sede: "Crea tu perfil" es la
          // inscripción local, explícita y controlada por el usuario.
          <RegistrationForm
            user={session.user}
            restaurantId={bistroLoc.restaurante_id}
            referidoPor={referidoPor}
            onSuccess={handleSuccess}
          />
        )}
      </main>

      <footer className="version-footer">
        Bistro Connect v2.9 · {config.nombreBistro}
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
