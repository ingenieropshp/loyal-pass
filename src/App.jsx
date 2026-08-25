import { useState, useEffect, useMemo, useRef } from 'react';
import { GeofencingProvider } from './components/GeofencingProvider';
import { BatteryOptimizationGuide } from './components/BatteryOptimizationGuide';
import { BatteryOptimizationGuide } from './components/BatteryOptimizationGuide';
import { PruebaGeofencingCapgo } from './components/PruebaGeofencingCapgo';
import { AuthScreen }       from './components/AuthScreen';
import { ResetPassword }    from './components/ResetPassword';
import { RegistrationForm } from './components/RegistrationForm';
import { SuccessCard }      from './components/manejarRegistro';
import { UserDashboard }    from './components/UserDashboard';
import { BuscadorRestaurantes } from './components/BuscadorRestaurantes';
import { BrandLogo } from './components/BrandLogo';
import { useLocation }      from './hooks/useLocation';
import { supabase, buscarClienteEnRestaurante, registrarLlegada } from './services/supabaseClient';
import './App.css';

function App() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);

  // El QR impreso en el local codifica ?restaurante_id=<id>. Seguimos
  // aceptando también ?r=<id-o-nombre> por compatibilidad con links/QRs
  // generados antes de este cambio — ambos apuntan a la misma sede.
  const idParamRaw = params.get('restaurante_id') || params.get('r');
  // Saneamos el valor: URLSearchParams ya decodifica %20 → espacio, pero
  // dejamos un decodeURIComponent extra por si llega doblemente codificado
  // (algunos generadores de QR lo hacen). Colapsamos espacios repetidos y
  // quitamos comas/comillas — caracteres que rompen el filtro .ilike() de
  // PostgREST si el nombre del restaurante los trae (ej. "101, Bistro").
  const sanitizarParametroRestaurante = (valor) => {
    if (!valor) return null;
    let limpio = valor;
    try { limpio = decodeURIComponent(limpio); } catch { /* ya estaba decodificado */ }
    limpio = limpio.trim().replace(/\s+/g, ' ').replace(/[,"']/g, '');
    return limpio || null;
  };
  const restauranteIDDeURL = sanitizarParametroRestaurante(idParamRaw);

  // CLAVE_ESCANEO_PENDIENTE: guarda el último restaurante escaneado por QR
  // para que sobreviva aunque el usuario cierre la pestaña (ej. porque tuvo
  // que ir a confirmar su correo) y vuelva a abrir la app días después SIN
  // el ?restaurante_id= en la URL. Sin esto, ese contexto se perdería y el
  // usuario terminaría en el buscador general en vez de directo en la sede
  // que escaneó.
  const CLAVE_ESCANEO_PENDIENTE = 'loyalpass_pending_scan';

  // `restauranteID` prioriza la URL (un QR nuevo siempre gana), y solo si
  // la URL no trae nada, cae al último escaneo pendiente guardado.
  const [restauranteID, setRestauranteID] = useState(() => {
    if (restauranteIDDeURL) return restauranteIDDeURL;
    try {
      const pendiente = JSON.parse(localStorage.getItem(CLAVE_ESCANEO_PENDIENTE) || 'null');
      return pendiente?.restauranteId || null;
    } catch { return null; }
  });

  // Si llega un ?restaurante_id= nuevo por la URL (un escaneo fresco),
  // sincronizamos el estado y lo persistimos como "pendiente" — se limpia
  // más abajo en cuanto la llegada queda registrada con éxito.
  useEffect(() => {
    if (restauranteIDDeURL && restauranteIDDeURL !== restauranteID) {
      setRestauranteID(restauranteIDDeURL);
    }
    if (restauranteIDDeURL) {
      localStorage.setItem(CLAVE_ESCANEO_PENDIENTE, JSON.stringify({
        restauranteId: restauranteIDDeURL,
        ts: Date.now(),
      }));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restauranteIDDeURL]);

  // Evita registrar la misma llegada más de una vez por sesión de la
  // pestaña (ej. si el componente vuelve a renderizar / StrictMode).
  const llegadaRegistradaRef = useRef(null); // guarda `${clienteId}-${restauranteId}` ya procesado

  const limpiarEscaneoPendiente = () => localStorage.removeItem(CLAVE_ESCANEO_PENDIENTE);

  // ── Sesión persistente de Supabase Auth ───────────────────────────────
  // `session` es null mientras no sabemos si hay un login guardado, y
  // pasa a `undefined` intencionalmente nunca: solo null (sin sesión) u
  // objeto de sesión. `sessionLoaded` distingue "todavía no verificamos"
  // de "ya verificamos y no hay sesión", para no mostrar pantallas de
  // login/registro de golpe mientras se resuelve el getSession() inicial.
  const [session,           setSession]           = useState(null);
  const [sessionLoaded,     setSessionLoaded]      = useState(false);
  // Se activa cuando el usuario vuelve del link de "recuperar contraseña"
  // de su correo. OJO: no basta con escuchar el evento PASSWORD_RECOVERY de
  // onAuthStateChange — Supabase procesa el #access_token del hash de forma
  // asíncrona apenas se crea el cliente (al importar supabaseClient.js),
  // que puede pasar ANTES de que este useEffect llegue a suscribirse. Si el
  // evento se dispara sin que nadie lo esté escuchando todavía, se pierde.
  // Por eso inicializamos leyendo el hash directamente y de forma síncrona:
  // así queda detectado sin importar si alcanzamos a "escuchar" el evento.
  const [passwordRecovery,  setPasswordRecovery]   = useState(
    () => window.location.hash.includes('type=recovery')
  );

  const [clienteId,       setClienteId]       = useState(() => {
    if (!restauranteID) return null;
    const registros = JSON.parse(localStorage.getItem('loyalpass_multisede') || '{}');
    return registros[restauranteID] || null;
  });
  const [nombreCliente,   setNombreCliente]    = useState('');
  const [puntosCliente,   setPuntosCliente]    = useState(0);
  const [isRegisteredNow, setIsRegisteredNow]  = useState(false);
  const [isVerifyingUser, setIsVerifyingUser]  = useState(!!restauranteID);
  const [referidoPor,     setReferidoPor]      = useState('');
  const [sedeActual,       setSedeActual]        = useState(null);
  const [sedeNoEncontrada, setSedeNoEncontrada] = useState(false);
  const [llegadaConfirmada, setLlegadaConfirmada] = useState(false); // banner "✓ Llegada registrada"

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
        const esUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(restauranteID);
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

          const registros = JSON.parse(localStorage.getItem('loyalpass_multisede') || '{}');
          if (cliente) {
            registros[restauranteID] = cliente.id;
            localStorage.setItem('loyalpass_multisede', JSON.stringify(registros));

            setClienteId(cliente.id);
            setNombreCliente(cliente.nombre);
            setPuntosCliente(cliente.puntos);
          } else {
            // Autenticado globalmente, pero aún NO inscrito en esta sede.
            delete registros[restauranteID];
            localStorage.setItem('loyalpass_multisede', JSON.stringify(registros));
            setClienteId(null);
          }
        } else if (clienteId) {
          const { data: userDB, error: errorUser } = await supabase
            .from('clientes').select('id, nombre, puntos')
            .eq('id', clienteId).maybeSingle();

          if (errorUser || !userDB) {
            const registros = JSON.parse(localStorage.getItem('loyalpass_multisede') || '{}');
            delete registros[restauranteID];
            localStorage.setItem('loyalpass_multisede', JSON.stringify(registros));
            setClienteId(null);
          } else {
            setNombreCliente(userDB.nombre);
            setPuntosCliente(userDB.puntos);
          }
        }

        const { data: gpsData } = await supabase
          .from('conexion').select('*')
          .eq('restaurante_id', sede.id).maybeSingle();

        if (gpsData) setSedeActual({ ...gpsData, nombre: sede.nombre });
        else setSedeActual({ restaurante_id: sede.id, nombre: sede.nombre, latitud: null, longitud: null });
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
    const registros    = JSON.parse(localStorage.getItem('loyalpass_multisede') || '{}');
    const idEnEstaSede = registros[restauranteID] || null;
    if (idEnEstaSede !== clienteId) setClienteId(idEnEstaSede);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restauranteID, session?.user]);

  // ── CHECK-IN AUTOMÁTICO POR QR (Caso 1 del flujo) ───────────────────────
  // Si el usuario tiene sesión activa Y ya está inscrito en esta sede
  // (clienteId resuelto), registramos la llegada sin pedirle NADA — ni
  // login, ni confirmación. Esto corre tanto para el escaneo "en caliente"
  // (llegó con el QR y ?restaurante_id= en la URL) como para el caso de
  // haber recuperado un escaneo pendiente desde localStorage tras volver
  // de confirmar su correo.
  useEffect(() => {
    // Se agrega la espera por `sedeActual?.restaurante_id` (el UUID real,
    // resuelto contra la tabla `configuracion`) en vez de solo `restauranteID`
    // (el parámetro crudo de la URL, que puede ser un slug/nombre — ver el
    // fallback `ilike('nombre', restauranteID)` más arriba). Si `visitas.
    // restaurante_id` es de tipo uuid, mandarle el nombre en texto plano
    // provoca un 400 de Postgres. Esperamos a que `sedeActual` ya esté
    // resuelto antes de intentar el insert.
    if (!clienteId || !sedeActual?.restaurante_id || !session?.user) return;

    const restauranteIdReal = sedeActual.restaurante_id; // UUID real, no el slug de la URL
    const llaveIntento = `${clienteId}-${restauranteIdReal}`;
    if (llegadaRegistradaRef.current === llaveIntento) return; // ya procesado en esta sesión de la pestaña
    llegadaRegistradaRef.current = llaveIntento;

    (async () => {
      let ok = false;
      try {
        // registrarLlegada() ya captura sus propios errores internamente y
        // nunca lanza (ver supabaseClient.js) — este try/catch es una
        // segunda capa de seguridad por si algo entre medio (ej. el propio
        // await) fallara de forma inesperada, para que NUNCA se congele la
        // pantalla del cliente por un 400/500 en el registro de la visita.
        ok = await registrarLlegada({ clienteId, restauranteId: restauranteIdReal, origen: 'qr' });
      } catch (err) {
        console.error('[App] Error inesperado al registrar la llegada por QR:', {
          clienteId, restauranteId: restauranteIdReal, error: err?.message || err,
        });
      } finally {
        limpiarEscaneoPendiente();
        if (ok) {
          setLlegadaConfirmada(true);
          setTimeout(() => setLlegadaConfirmada(false), 3500);
        }
      }
    })();
  }, [clienteId, restauranteID, sedeActual?.restaurante_id, session?.user]);

  // ── REALTIME: escuchar cambios de GPS/radio Y configuración en tiempo real ──
  useEffect(() => {
    // Solo activar cuando ya tenemos el ID del restaurante cargado
    if (!sedeActual?.restaurante_id) return;

    const restauranteId = sedeActual.restaurante_id;

    // ── Canal 1: tabla `conexion` ─────────────────────────────────────────────
    // Escucha cambios de latitud, longitud y radio_aviso que hace el admin.
    // Cuando el admin mueve el pin en el mapa o ajusta el radio, este canal
    // recibe el UPDATE y actualiza sedeActual → useLocation recalcula distancia.
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
          setSedeActual(prev => ({ ...prev, ...payload.new }));
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
          // Actualizar nombre y mensaje_promo en sedeActual para que
          // config (useMemo) los recalcule automáticamente
          setSedeActual(prev => ({
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
  }, [sedeActual?.restaurante_id]); // Solo se re-ejecuta si cambia el restaurante

  const { distance: distancia, error: geoError } = useLocation(
    sedeActual?.latitud  ?? null,
    sedeActual?.longitud ?? null
  );

  const config = useMemo(() => ({
    radioAviso:   sedeActual?.radio_aviso ? Number(sedeActual.radio_aviso) : 800,
    mensaje:      sedeActual?.mensaje_promo || 'CORTESÍA DISPONIBLE',
    nombreSede: sedeActual?.nombre || restauranteID,
  }), [sedeActual, restauranteID]);

  const volverAlBuscador = () => { window.location.href = '/'; };

  const handleSuccess = (nuevoId, nombre, puntos) => {
    const registros = JSON.parse(localStorage.getItem('loyalpass_multisede') || '{}');
    registros[restauranteID] = nuevoId;
    localStorage.setItem('loyalpass_multisede', JSON.stringify(registros));
    setClienteId(nuevoId);
    setNombreCliente(nombre);
    setPuntosCliente(puntos);
    setIsRegisteredNow(true);

    // También cuenta como "llegada" — es la primera visita registrada del
    // cliente en esta sede.
    //
    // ⚠️ Usamos sedeActual.restaurante_id (UUID real) y NUNCA restauranteID
    // (el slug/nombre crudo de la URL) — visitas.restaurante_id es uuid, y
    // mandarle texto plano (ej. "101 Bistro") revienta con 400 "invalid
    // input syntax for type uuid". Antes había un fallback `|| restauranteID`
    // que sí lo hacía si sedeActual todavía no había cargado en el momento
    // exacto en que termina el registro — era la causa real del 400 que
    // aparecía en consola. Si todavía no cargó, simplemente NO registramos
    // acá: el efecto de check-in de arriba corre de nuevo en cuanto
    // `sedeActual` esté listo (depende de `clienteId`, que ya se actualiza
    // abajo) y lo registra ahí, con el UUID real garantizado.
    if (sedeActual?.restaurante_id) {
      const restauranteIdReal = sedeActual.restaurante_id;
      llegadaRegistradaRef.current = `${nuevoId}-${restauranteIdReal}`;
      registrarLlegada({ clienteId: nuevoId, restauranteId: restauranteIdReal, origen: 'qr' });
    }
    limpiarEscaneoPendiente();
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
    localStorage.removeItem('loyalpass_multisede');
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
          <BrandLogo size={44} />
        </header>
        <ResetPassword onDone={() => {
          // Limpiamos el #access_token de la URL para que un refresco de
          // página no vuelva a intentar activar la recuperación con un
          // token que ya se usó.
          window.history.replaceState(null, '', window.location.pathname + window.location.search);
          setPasswordRecovery(false);
        }} />
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
  // (?restaurante_id=... o ?r=...) y aún no tiene sesión, seguimos esperando (spinner) a que `sedeActual`
  // termine de cargar. AuthScreen SOLO crea/inicia la cuenta global (correo
  // + contraseña) — nunca inscribe en ningún restaurante. En cuanto la
  // sesión queda activa, este mismo componente vuelve a renderizar, el
  // efecto de arriba verifica si ya existe una fila en `clientes` para esta
  // sede y, si no, se muestra "Crea tu perfil" (RegistrationForm) sin
  // perder el contexto del link/QR que escaneó.
  if (!session?.user) {
    if (restauranteID && (isVerifyingUser || !sedeActual) && !sedeNoEncontrada) {
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
          <BrandLogo size={44} />
        </header>
        <AuthScreen
          restaurantId={sedeNoEncontrada ? null : sedeActual?.restaurante_id}
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
  if (isVerifyingUser || !sedeActual) {
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
        restauranteId={sedeActual.restaurante_id}
        nombreRestaurante={config.nombreSede}
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
        <h1 className="brand-title">
          {config.nombreSede}<span className="dot">.</span>
        </h1>
        {referidoPor && (
          <p style={{ marginTop: '0.4rem', fontSize: '0.8rem', opacity: 0.6 }}>
            Invitado por <strong>{referidoPor}</strong>
          </p>
        )}
      </header>

      {geoError && <div className="error-alert">⚠️ {geoError}</div>}

      {llegadaConfirmada && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: '8px',
          background: 'rgba(60,160,90,0.12)', color: '#2f8a52',
          border: '1px solid rgba(60,160,90,0.3)', borderRadius: 'var(--r-md)',
          padding: '10px 14px', margin: '0 0 0.75rem', fontSize: '0.85rem', fontWeight: 600,
        }}>
          ✓ Llegada registrada — ¡bienvenido de nuevo!
        </div>
      )}

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
          {sedeActual?.latitud && sedeActual?.longitud && (
            <a
              href={`https://www.google.com/maps/dir/?api=1&destination=${sedeActual.latitud},${sedeActual.longitud}`}
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
            restauranteId={sedeActual.restaurante_id}
            clienteId={clienteId}
            distancia={distancia}
            esCerca={esCerca}
            nombreRestaurante={config.nombreSede}
            onLogout={handleLogout}
          />
        ) : (
          // Ya hay sesión global (session.user existe — de lo contrario no
          // llegaríamos aquí, ver el GATE más arriba), pero todavía no hay
          // una fila en `clientes` para ESTA sede: "Crea tu perfil" es la
          // inscripción local, explícita y controlada por el usuario.
          <RegistrationForm
            user={session.user}
            restaurantId={sedeActual.restaurante_id}
            referidoPor={referidoPor}
            onSuccess={handleSuccess}
          />
        )}
      </main>

      <footer className="version-footer">
        LoyalPass v2.9 · {config.nombreSede}
      </footer>
    </div>
  );
}

function AppConGeofencing() {
  return (
    <GeofencingProvider>
      <App />
      {/* Vive fuera de <App/> a propósito: se auto-controla por completo vía
          localStorage/Capacitor.isNativePlatform(), no necesita ningún
          estado de App.jsx ni depende de en qué pantalla esté el usuario. */}
      <BatteryOptimizationGuide />
      <PruebaGeofencingCapgo /> {/* TEMPORAL — borrar después de probar */}
    </GeofencingProvider>
  );
}

export default AppConGeofencing;
