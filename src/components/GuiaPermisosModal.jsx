/**
 * GuiaPermisosModal.jsx — LoyalPass (bistro-app)
 * ────────────────────────────────────────────────────────────────────────
 * Onboarding / Guía de Permisos: pantalla completa, amigable y cero
 * invasiva, que se muestra ÚNICAMENTE la primera vez que el cliente abre
 * la app tras instalarla (detección vía localStorage). Educa sobre los
 * 3 permisos que hacen funcionar los puntos pasivos de LoyalPass:
 *
 *   Paso 1 — GPS "Permitir siempre"   (+200 pts de geocerca a 200 m)
 *   Paso 2 — Notificaciones con sonido (avisos de puntos ganados/premios)
 *   Paso 3 — Batería sin restricciones (evita que Android mate la app)
 *
 * IMPORTANTE — APIs REALES reutilizadas (no se inventa ninguna nueva):
 *   - GPS: `hooks/permissions.js` (`requestForegroundLocation`,
 *     `requestBackgroundLocation`, `checkLocationPermissions`) — este
 *     proyecto usa @capgo/background-geolocation, NO @capacitor/geolocation.
 *     `useGeofencing.js` ya dispara su propio `setupGeofencing({requestPermissions:true})`
 *     al cargar restaurantes, así que el diálogo del sistema puede
 *     aparecer solo o por este botón — pedir de nuevo es seguro/ idempotente
 *     (el plugin resuelve al toque si ya estaba decidido). Por eso el botón
 *     de este modal NO llama a `ensureAlwaysLocationAndStartWatcher()`
 *     (que además arranca el watcher con `.start()`): eso ya lo maneja
 *     `useGeofencing.js` una sola vez, y llamarlo de nuevo aquí duplicaría
 *     el watcher.
 *   - Push: `@capacitor/push-notifications` directo, mismo patrón que
 *     `hooks/usePushNotifications.js` (que ya se auto-registra al montar
 *     la app — este botón solo lo repite a demanda si el usuario aún no
 *     lo había concedido; el listener 'registration' global de ese hook
 *     guarda el token igual, sin duplicar código).
 *   - Batería: reusa `abrirAjustesBateria` de `BatteryOptimizationGuide.jsx`
 *     (abre Ajustes de batería del sistema — NUNCA
 *     `requestIgnoreBatteryOptimization()` directo, prohibido por la
 *     política de Play salvo excepción revisada caso por caso).
 *   - Estado (ACTIVA/INACTIVA): `utils/permisosDispositivo.js`
 *     (`chequearPermisoGPS`, `chequearPermisoPush`) — mismos chequeos que
 *     ya usan CentroNotificaciones.jsx y CuentaScreen.jsx.
 *
 * Anti-spam (localStorage):
 *   - `guia_permisos_vista`        → 'true' una vez que el usuario cierra
 *     el modal por cualquier vía (CTA principal o "Más tarde").
 *   - `fecha_ultimo_aviso`         → ISO de la última vez que se mostró/
 *     cerró el modal. Sirve de ancla para el cooldown de 14 días del
 *     banner flotante (ver `GuiaPermisosBanner`).
 *   - `guia_permisos_banner_snooze_hasta` → epoch ms hasta el cual el
 *     banner flotante NO debe reaparecer (se fija al tocar su botón "✕",
 *     por 2 semanas más).
 *   Al cerrar el modal también se pospone 3 días el aviso independiente
 *   de `BatteryOptimizationGuide.jsx` (misma clave que ya usa ese
 *   componente) para no mostrar DOS avisos de batería seguidos apenas
 *   termina el Paso 3 de este modal — sigue siendo su propio aviso
 *   autónomo si el usuario nunca completa este onboarding.
 *
 * Acceso voluntario: `abrirGuiaPermisos()` dispara un CustomEvent en
 * `window` (mismo patrón ya usado por SelectorNotificaciones.jsx /
 * GeofencingProvider.jsx con `loyalpass_notif_changed`) que este
 * componente escucha para forzar su apertura sin importar el cooldown —
 * úsalo desde el botón de la Campanita (CentroNotificaciones.jsx) o la
 * pantalla de Cuenta (CuentaScreen.jsx).
 */
import { useState, useEffect, useCallback } from 'react';
import { Capacitor } from '@capacitor/core';
import {
  requestForegroundLocation,
  requestBackgroundLocation,
  checkLocationPermissions,
} from '../hooks/permissions';
import {
  chequearPermisoGPS,
  chequearPermisoPush,
  abrirConfiguracionSistema,
} from '../utils/permisosDispositivo';
import { abrirAjustesBateria } from './BatteryOptimizationGuide';

export const CLAVE_VISTA          = 'guia_permisos_vista';
export const CLAVE_FECHA          = 'fecha_ultimo_aviso';
const CLAVE_BANNER_SNOOZE         = 'guia_permisos_banner_snooze_hasta';
const CLAVE_BATERIA_DISMISSED     = 'loyalpass_battery_guide_dismissed'; // misma clave de BatteryOptimizationGuide.jsx
const EVENTO_ABRIR_GUIA           = 'loyalpass_abrir_guia_permisos';
const COOLDOWN_BANNER_MS          = 14 * 24 * 60 * 60 * 1000; // 14 días
const SNOOZE_BANNER_MS            = 14 * 24 * 60 * 60 * 1000; // 2 semanas más al descartar
const POSPONER_BATERIA_MS         = 3 * 24 * 60 * 60 * 1000;  // igual al cooldown propio de BatteryOptimizationGuide

/** Acceso voluntario: abre el modal desde cualquier parte de la app (Campanita, Cuenta, etc.). */
export function abrirGuiaPermisos() {
  try {
    window.dispatchEvent(new Event(EVENTO_ABRIR_GUIA));
  } catch {
    // entorno sin `window` (SSR/tests) — no-op
  }
}

function marcarVistaYFecha() {
  try {
    localStorage.setItem(CLAVE_VISTA, 'true');
    localStorage.setItem(CLAVE_FECHA, new Date().toISOString());
    // Evita el "doble aviso" de batería justo después del Paso 3 de este modal.
    localStorage.setItem(
      CLAVE_BATERIA_DISMISSED,
      JSON.stringify({ permanente: false, hasta: Date.now() + POSPONER_BATERIA_MS })
    );
  } catch {
    // localStorage no disponible — cero invasivo: seguimos sin bloquear nada.
  }
}

/** Paso 2: pide permiso de notificaciones push exactamente como usePushNotifications.js. */
async function activarNotificacionesPush() {
  const mod = await import('@capacitor/push-notifications');
  const PushNotifications = mod?.PushNotifications;
  if (!PushNotifications) return;

  let estado = await PushNotifications.checkPermissions();
  if (estado.receive === 'prompt' || estado.receive === 'prompt-with-rationale') {
    estado = await PushNotifications.requestPermissions();
  }
  if (estado.receive === 'granted') {
    // Dispara el registro real — el listener 'registration' global que ya
    // instaló usePushNotifications.js en el montaje de la app guarda el
    // token en Supabase; no se duplica lógica aquí.
    await PushNotifications.register();
  }
}

/** Paso 1: flujo de permisos de ubicación en dos pasos (foreground → background/"Always"). */
async function activarUbicacionSiempre() {
  await requestForegroundLocation();
  const estado = await checkLocationPermissions();
  if (estado.backgroundLocation !== 'granted' && estado.backgroundLocation !== 'always') {
    await requestBackgroundLocation();
  }
}

function EstadoBadge({ estado }) {
  if (estado === 'activa') {
    return <span style={estilos.badgeActiva}>✓ Activo</span>;
  }
  if (estado === 'inactiva') {
    return <span style={estilos.badgeInactiva}>Inactivo</span>;
  }
  return null;
}

function TarjetaPaso({ numero, icono, titulo, descripcion, estado, cargando, textoBoton, onAccionar, extra }) {
  const yaActivo = estado === 'activa';
  return (
    <div style={estilos.tarjeta}>
      <div style={estilos.tarjetaHeader}>
        <div style={estilos.numeroPaso}>{numero}</div>
        <div style={estilos.iconoPaso}>{icono}</div>
        <div style={{ flex: 1 }}>
          <p style={estilos.tarjetaTitulo}>{titulo}</p>
        </div>
        <EstadoBadge estado={estado} />
      </div>

      <p style={estilos.tarjetaTexto}>{descripcion}</p>

      {!yaActivo && (
        <button
          type="button"
          style={{ ...estilos.btnAccion, ...(cargando ? estilos.btnAccionCargando : {}) }}
          disabled={cargando}
          onClick={onAccionar}
        >
          {cargando ? 'Un momento…' : textoBoton}
        </button>
      )}

      {estado === 'inactiva' && (
        <button type="button" style={estilos.linkAjustes} onClick={abrirConfiguracionSistema}>
          Abrir ajustes del sistema
        </button>
      )}

      {extra}
    </div>
  );
}

export function GuiaPermisosModal() {
  const [mostrar, setMostrar] = useState(false);
  const [gpsEstado, setGpsEstado]   = useState('desconocida');
  const [pushEstado, setPushEstado] = useState('desconocida');
  const [gpsCargando, setGpsCargando]   = useState(false);
  const [pushCargando, setPushCargando] = useState(false);

  // Primera apertura tras instalar: solo si nunca se marcó `guia_permisos_vista`.
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    try {
      if (!localStorage.getItem(CLAVE_VISTA)) setMostrar(true);
    } catch {
      // si no se puede leer localStorage, no forzamos el modal (cero invasivo)
    }
  }, []);

  // Acceso voluntario desde Campanita / Cuenta — fuerza apertura sin importar cooldown.
  useEffect(() => {
    const handler = () => setMostrar(true);
    window.addEventListener(EVENTO_ABRIR_GUIA, handler);
    return () => window.removeEventListener(EVENTO_ABRIR_GUIA, handler);
  }, []);

  // Estado real de los permisos cada vez que el modal se abre.
  useEffect(() => {
    if (!mostrar) return;
    let cancelado = false;
    chequearPermisoGPS().then((e) => { if (!cancelado) setGpsEstado(e); });
    chequearPermisoPush().then((e) => { if (!cancelado) setPushEstado(e); });
    return () => { cancelado = true; };
  }, [mostrar]);

  const cerrar = useCallback(() => {
    marcarVistaYFecha();
    setMostrar(false);
  }, []);

  const manejarGPS = useCallback(async () => {
    setGpsCargando(true);
    try {
      await activarUbicacionSiempre();
    } catch (err) {
      console.warn('[GuiaPermisosModal] Error solicitando ubicación:', err?.message || err);
    } finally {
      try {
        setGpsEstado(await chequearPermisoGPS());
      } finally {
        setGpsCargando(false);
      }
    }
  }, []);

  const manejarPush = useCallback(async () => {
    setPushCargando(true);
    try {
      await activarNotificacionesPush();
    } catch (err) {
      console.warn('[GuiaPermisosModal] Error solicitando notificaciones:', err?.message || err);
    } finally {
      try {
        setPushEstado(await chequearPermisoPush());
      } finally {
        setPushCargando(false);
      }
    }
  }, []);

  if (!mostrar) return null;

  return (
    <div style={estilos.overlay} role="dialog" aria-modal="true" aria-label="Guía de permisos">
      <div style={estilos.contenedor}>
        <button type="button" style={estilos.btnMasTarde} onClick={cerrar}>
          Más tarde
        </button>

        <div style={estilos.encabezado}>
          <div style={estilos.encabezadoIcono}>✨</div>
          <h1 style={estilos.tituloPrincipal}>Aprovecha todos tus puntos</h1>
          <p style={estilos.subtitulo}>
            Con 3 permisos activados, LoyalPass suma tus puntos automáticamente —
            sin que tengas que sacar el celular del bolsillo.
          </p>
        </div>

        <div style={estilos.listaTarjetas}>
          <TarjetaPaso
            numero={1}
            icono="📍"
            titulo="GPS · Permitir siempre"
            descripcion={'Se requiere para sumar automáticamente +200 pts de geocerca al pasar a 200 m de tus restaurantes favoritos, sin abrir la app.'}
            estado={gpsEstado}
            cargando={gpsCargando}
            textoBoton="Activar GPS"
            onAccionar={manejarGPS}
          />

          <TarjetaPaso
            numero={2}
            icono="🔔"
            titulo="Notificaciones con sonido"
            descripcion="Te avisamos apenas ganas puntos o desbloqueas un premio — sin sonido, es fácil perderse el aviso."
            estado={pushEstado}
            cargando={pushCargando}
            textoBoton="Activar Notificaciones"
            onAccionar={manejarPush}
          />

          <TarjetaPaso
            numero={3}
            icono="🔋"
            titulo="Batería sin restricciones"
            descripcion="Algunos celulares (Xiaomi, Samsung, Huawei, OnePlus...) cierran apps en segundo plano para ahorrar batería. Libera LoyalPass para que no se te corten los puntos de cercanía."
            estado="desconocida"
            cargando={false}
            textoBoton="Abrir ajustes de batería"
            onAccionar={abrirAjustesBateria}
            extra={
              <a
                href="https://dontkillmyapp.com/?app=LoyalPass"
                target="_blank"
                rel="noopener noreferrer"
                style={estilos.linkAjustes}
              >
                📖 Ver guía por marca de celular
              </a>
            }
          />
        </div>

        <button type="button" style={estilos.btnPrincipal} onClick={cerrar}>
          ¡Listo! Continuar a mi cuenta (+500 pts)
        </button>
      </div>
    </div>
  );
}

/**
 * GuiaPermisosBanner — recordatorio discreto, no bloqueante, para el feed
 * principal ("inicio"). Solo aparece si:
 *   1. El onboarding completo ya se mostró al menos una vez.
 *   2. Pasaron 14+ días desde la última vez (`fecha_ultimo_aviso`).
 *   3. No está en cooldown propio (descartado con "✕" hace < 2 semanas).
 *   4. GPS o Push siguen inactivos.
 * Móntalo solo dentro del feed principal (tab "inicio", con cliente ya
 * registrado) — nunca como overlay global, a diferencia del modal.
 */
export function GuiaPermisosBanner() {
  const [mostrar, setMostrar] = useState(false);

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let cancelado = false;

    (async () => {
      try {
        if (localStorage.getItem(CLAVE_VISTA) !== 'true') return;

        const snoozeHasta = parseInt(localStorage.getItem(CLAVE_BANNER_SNOOZE) || '0', 10);
        if (Date.now() < snoozeHasta) return;

        const fechaAviso = localStorage.getItem(CLAVE_FECHA);
        const ultimaFechaMs = fechaAviso ? new Date(fechaAviso).getTime() : 0;
        if (Date.now() - ultimaFechaMs < COOLDOWN_BANNER_MS) return;

        const [gps, push] = await Promise.all([chequearPermisoGPS(), chequearPermisoPush()]);
        if (cancelado) return;
        if (gps !== 'activa' || push !== 'activa') setMostrar(true);
      } catch {
        // cero invasivo: si algo falla al chequear, simplemente no mostramos nada
      }
    })();

    return () => { cancelado = true; };
  }, []);

  const configurar = useCallback(() => {
    setMostrar(false);
    abrirGuiaPermisos();
  }, []);

  const descartar = useCallback(() => {
    try {
      localStorage.setItem(CLAVE_BANNER_SNOOZE, String(Date.now() + SNOOZE_BANNER_MS));
    } catch {
      // no-op
    }
    setMostrar(false);
  }, []);

  if (!mostrar) return null;

  return (
    <div style={estilosBanner.barra} role="note">
      <span style={estilosBanner.texto}>
        📍 Activa tu GPS "Permitir siempre" para sumar +200 pts al pasar cerca.
      </span>
      <div style={estilosBanner.acciones}>
        <button type="button" style={estilosBanner.btnConfigurar} onClick={configurar}>
          Configurar
        </button>
        <button type="button" style={estilosBanner.btnCerrar} onClick={descartar} aria-label="Descartar por 2 semanas">
          ✕
        </button>
      </div>
    </div>
  );
}

/* ── Estilos — tema "Luxury Charcoal & Gold", tokens del design system ── */
const estilos = {
  overlay: {
    position: 'fixed', inset: 0, zIndex: 2000,
    background: 'var(--luxury-dark, #121212)',
    overflowY: 'auto',
    display: 'flex', justifyContent: 'center',
  },
  contenedor: {
    width: '100%', maxWidth: 480,
    padding: '48px 20px 32px',
    display: 'flex', flexDirection: 'column',
    minHeight: '100%',
  },
  btnMasTarde: {
    alignSelf: 'flex-end',
    background: 'transparent', border: 'none',
    color: 'var(--text, rgba(245,245,220,0.75))', opacity: 0.65,
    fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer',
    padding: '6px 4px', marginBottom: 4,
  },
  encabezado: { textAlign: 'center', marginBottom: '1.75rem' },
  encabezadoIcono: { fontSize: '2.2rem', marginBottom: '0.5rem' },
  tituloPrincipal: {
    fontFamily: 'var(--font-display, inherit)', fontWeight: 800,
    fontSize: '1.4rem', color: 'var(--text-h, #FBF8EE)', margin: '0 0 8px',
  },
  subtitulo: {
    fontSize: '0.88rem', lineHeight: 1.5,
    color: 'var(--text, rgba(245,245,220,0.75))', margin: 0,
  },
  listaTarjetas: { display: 'flex', flexDirection: 'column', gap: '14px', marginBottom: '1.75rem' },
  tarjeta: {
    background: 'var(--bg-card, #1E1E1E)',
    border: '1px solid var(--border, rgba(212,175,55,0.16))',
    borderRadius: 'var(--r-lg, 18px)',
    padding: '18px',
    boxShadow: 'var(--shadow-card, 0 10px 30px rgba(0,0,0,0.5))',
  },
  tarjetaHeader: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' },
  numeroPaso: {
    width: 22, height: 22, borderRadius: '50%', flexShrink: 0,
    background: 'var(--gold-gradient, linear-gradient(135deg,#CA8A04,#F5C451,#EAB308))',
    color: '#1A1A1A', fontWeight: 800, fontSize: '0.72rem',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  iconoPaso: { fontSize: '1.15rem' },
  tarjetaTitulo: {
    fontFamily: 'var(--font-display, inherit)', fontWeight: 700,
    fontSize: '0.95rem', color: 'var(--text-h, #FBF8EE)', margin: 0,
  },
  tarjetaTexto: {
    fontSize: '0.82rem', lineHeight: 1.5,
    color: 'var(--text, rgba(245,245,220,0.75))', margin: '0 0 12px',
  },
  badgeActiva: {
    fontSize: '0.68rem', fontWeight: 700, color: 'var(--green, #2FBF71)',
    background: 'var(--green-light, rgba(47,191,113,0.12))',
    border: '1px solid var(--green-border, rgba(47,191,113,0.32))',
    borderRadius: 999, padding: '3px 8px', whiteSpace: 'nowrap',
  },
  badgeInactiva: {
    fontSize: '0.68rem', fontWeight: 700, color: 'var(--text, rgba(245,245,220,0.6))',
    background: 'rgba(245,245,220,0.08)',
    border: '1px solid var(--border, rgba(212,175,55,0.16))',
    borderRadius: 999, padding: '3px 8px', whiteSpace: 'nowrap',
  },
  btnAccion: {
    width: '100%', padding: '11px', fontSize: '0.85rem', fontWeight: 700,
    background: 'var(--gold-gradient, linear-gradient(135deg,#CA8A04,#F5C451,#EAB308))',
    color: '#1A1A1A', border: 'none', borderRadius: 'var(--r-md, 12px)',
    cursor: 'pointer',
  },
  btnAccionCargando: { opacity: 0.6, cursor: 'default' },
  linkAjustes: {
    display: 'block', textAlign: 'center', marginTop: '8px',
    background: 'none', border: 'none', textDecoration: 'underline',
    color: 'var(--luxury-gold, #D4AF37)', fontSize: '0.76rem',
    cursor: 'pointer', padding: '4px',
  },
  btnPrincipal: {
    width: '100%', padding: '16px', fontSize: '0.95rem', fontWeight: 800,
    fontFamily: 'var(--font-display, inherit)',
    background: 'var(--gold-gradient, linear-gradient(135deg,#CA8A04,#F5C451,#EAB308))',
    color: '#1A1A1A', border: 'none', borderRadius: 'var(--r-md, 12px)',
    boxShadow: 'var(--shadow-btn, 0 4px 14px rgba(212,175,55,0.35))',
    cursor: 'pointer', marginTop: 'auto',
  },
};

const estilosBanner = {
  barra: {
    display: 'flex', alignItems: 'center', gap: '10px',
    background: 'var(--charcoal-mate, #1A1A1A)',
    border: '1px solid var(--border-mid, rgba(212,175,55,0.34))',
    borderRadius: 'var(--r-md, 12px)',
    padding: '10px 12px',
    margin: '0 0 0.9rem',
  },
  texto: {
    flex: 1, fontSize: '0.78rem', lineHeight: 1.4,
    color: 'var(--text, rgba(245,245,220,0.75))',
  },
  acciones: { display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 },
  btnConfigurar: {
    padding: '7px 12px', fontSize: '0.74rem', fontWeight: 700,
    background: 'var(--coral-light, rgba(212,175,55,0.12))',
    color: 'var(--luxury-gold, #D4AF37)',
    border: '1px solid var(--coral-border, rgba(212,175,55,0.35))',
    borderRadius: 999, cursor: 'pointer', whiteSpace: 'nowrap',
  },
  btnCerrar: {
    width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'transparent', border: 'none', color: 'var(--text, rgba(245,245,220,0.6))',
    fontSize: '0.85rem', cursor: 'pointer', opacity: 0.7, padding: 0,
  },
};
