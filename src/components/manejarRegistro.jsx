import { useEffect, useState } from 'react';
import { supabase }  from '../services/supabaseClient';
import { getDeviceId } from '../utils/deviceId';
import { enviarEventoGeocercaWebhook } from '../hooks/useGeofencing';

// Mismo cálculo de distancia (fórmula de Haversine) que ya usan
// useLocation.js y useGeofencing.js — se repite acá en vez de importarlo
// porque ninguno de los dos lo exporta, y crear un cuarto archivo compartido
// solo para esta única función es más cambio del que pide este fix.
function distanciaMetros(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const rLat1 = (lat1 * Math.PI) / 180;
  const rLat2 = (lat2 * Math.PI) / 180;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rLat1) * Math.cos(rLat2) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Traduce el código numérico de GeolocationPositionError a algo legible en
// consola. Los tres únicos valores que define la spec son 1/2/3 — cualquier
// otra cosa (o un error que no es de geolocalización) cae en el mensaje tal
// cual venga.
function describirErrorGeolocalizacion(err) {
  const codigos = { 1: 'PERMISSION_DENIED', 2: 'POSITION_UNAVAILABLE', 3: 'TIMEOUT' };
  if (err && typeof err.code === 'number') {
    return `${codigos[err.code] || `código ${err.code}`}: ${err.message || '(sin mensaje)'}`;
  }
  return err?.message || String(err);
}

/**
 * obtenerPosicionActual
 * ────────────────────────────────────────────────────────────────────────
 * Lectura de GPS de UNA sola vez, con el mismo esquema en cascada que ya
 * usa useLocation.js (hook, para el badge "estás cerca" del formulario):
 *   1) Alta precisión primero (GPS real, típico en celular).
 *   2) Si falla — código 2 POSITION_UNAVAILABLE es el caso típico de un
 *      escritorio sin chip GPS, pero también cubre timeout/permiso — se
 *      reintenta UNA vez con baja precisión (enableHighAccuracy: false),
 *      que en Chrome de escritorio resuelve por IP/Wi-Fi en vez de fallar
 *      directamente. `maximumAge` alto en este segundo intento porque una
 *      posición de red de hace un minuto sigue sirviendo para un radio de
 *      cientos/miles de metros.
 * Si el segundo intento también falla, se relanza el error ORIGINAL (el de
 * alta precisión) para que el log de arriba diga la causa real, no la del
 * fallback.
 */
async function obtenerPosicionActual() {
  try {
    return await new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true,
        timeout: 8000,
        maximumAge: 0,
      });
    });
  } catch (errAltaPrecision) {
    try {
      return await new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: false,
          timeout: 8000,
          maximumAge: 60000,
        });
      });
    } catch {
      throw errAltaPrecision; // se conserva el error original para el log
    }
  }
}

/**
 * SuccessCard — pantalla mostrada justo después de un registro exitoso.
 * Props:
 *   restauranteId, nombreRestaurante, nombreCliente,
 *   clienteId, puntosActuales, onClose
 */
export const SuccessCard = ({
  restauranteId,
  nombreRestaurante,
  nombreCliente,
  clienteId,
  puntosActuales = 500,
  onClose,
}) => {
  // Monto mínimo de redención real de este restaurante, para el paso
  // "¿Cómo funciona?" — se consulta aparte porque este componente no recibe
  // config como prop desde App.jsx.
  const [montoMinimoRedencion, setMontoMinimoRedencion] = useState(15000);
  useEffect(() => {
    if (!restauranteId) return;
    supabase
      .from('configuracion_restaurantes')
      .select('monto_minimo_redencion')
      .eq('restaurante_id', restauranteId)
      .maybeSingle()
      .then(({ data }) => {
        if (data?.monto_minimo_redencion) setMontoMinimoRedencion(data.monto_minimo_redencion);
      });
  }, [restauranteId]);

  // Notificación de bienvenida (best-effort)
  useEffect(() => {
    const enviarNotificacion = async () => {
      if (!('Notification' in window)) return;
      if (Notification.permission !== 'granted') return;
      try {
        const reg = await navigator.serviceWorker.ready;
        reg.showNotification(`¡Bienvenido a ${nombreRestaurante}! 🎉`, {
          body:    `Has ganado tus primeros ${puntosActuales} puntos. ¡Sigue visitándonos!`,
          icon:    '/icon-192.png',
          badge:   '/icon-72.png',
          vibrate: [100, 50, 100],
        });
      } catch {}
    };
    enviarNotificacion();
  }, [nombreRestaurante, puntosActuales]);

  // Bono de proximidad si el registro ocurrió DENTRO del local
  // ──────────────────────────────────────────────────────────────────────
  // Este es el fix del bug original: el comentario en RegistrationForm.jsx
  // asumía que un trigger de la base de datos sumaba +200 pts de proximidad
  // automáticamente al registrarse en el local — eso nunca fue cierto,
  // fn_bono_bienvenida() SOLO otorga los 500 pts de bienvenida (confirmado
  // leyendo la función real en Supabase) y no sabe nada de geolocalización.
  //
  // En vez de insertar puntos directamente desde el navegador (eso ya se
  // intentó una vez para el bono de referido, más arriba, y se abandonó por
  // ser un hueco de seguridad — ver ese comentario), esta lectura de GPS
  // hace UNA sola vez lo mismo que ya hace el sistema de geocercas nativas
  // cuando detecta una entrada real: llama a `enviarEventoGeocercaWebhook`
  // (mismo POST, mismo Edge Function, mismo RPC `fn_evento_geocerca` con
  // sus reglas antifraude de siempre — máx. 1 bono/día, no si ya redimió
  // hoy). Si el sistema nativo YA hubiera dado el bono hoy por su cuenta,
  // este segundo intento simplemente no hace nada (fn_evento_geocerca lo
  // detecta y no duplica).
  //
  // "Fire and forget": la pantalla de bienvenida no debe esperar a esto ni
  // romperse si el GPS no responde, el usuario lo niega, o el dispositivo
  // no lo soporta (ej. abrió el link en un navegador de escritorio).
  useEffect(() => {
    const intentarBonoProximidad = async () => {
      if (!restauranteId) return;
      if (!('geolocation' in navigator)) return;

      try {
        // 1) Coordenadas y radio configurados de ESTE restaurante (misma
        // tabla y columnas que ya usa GeofencingProvider.jsx).
        const { data: conexion, error: errConexion } = await supabase
          .from('conexion')
          .select('latitud, longitud, radio_aviso')
          .eq('restaurante_id', restauranteId)
          .maybeSingle();

        if (errConexion || !conexion) return;
        const latRestaurante = parseFloat(conexion.latitud);
        const lonRestaurante = parseFloat(conexion.longitud);
        if (isNaN(latRestaurante) || isNaN(lonRestaurante)) return;
        const radio = parseInt(conexion.radio_aviso, 10) || 200; // 200m = default del negocio

        // 2) Posición actual del usuario, UNA sola vez (no un watch: ya
        // estamos parados en la pantalla de bienvenida, no hace falta
        // seguir monitoreando). obtenerPosicionActual() ya intenta alta
        // precisión primero y cae a baja precisión (red/Wi-Fi) si la
        // primera falla — ver su comentario arriba.
        const posicion = await obtenerPosicionActual();

        const distancia = distanciaMetros(
          posicion.coords.latitude,
          posicion.coords.longitude,
          latRestaurante,
          lonRestaurante
        );
        if (distancia > radio) return; // fuera de rango: no corresponde el bono

        // 3) Mismo deviceId que se vinculó en dispositivos_clientes durante
        // el registro (RegistrationForm.jsx) — getDeviceId() cachea, así
        // que esto no vuelve a pedir nada nuevo al SO.
        const deviceId = await getDeviceId();
        await enviarEventoGeocercaWebhook(deviceId, restauranteId, true);
      } catch (err) {
        // Sigue siendo NO bloqueante a propósito (el cliente ya se registró
        // bien, esto es solo un intento best-effort de darle el bono un
        // poco más rápido) — pero ya no se silencia el detalle: antes esto
        // solo decía "No se pudo..." sin decir POR QUÉ, y fue exactamente
        // lo que hizo imposible diagnosticar por qué a "Piere Steven" no le
        // llegaron los +200 (resultó ser un PC de escritorio sin GPS real,
        // ver el fix de obtenerPosicionActual arriba). console.error (no
        // warn) para que resalte en consola sin tener que filtrar logs.
        console.error(
          '[SuccessCard] No se pudo dar el bono de proximidad —',
          describirErrorGeolocalizacion(err)
        );
      }
    };
    intentarBonoProximidad();
  }, [restauranteId]);

  // Registrar referido si aplica
  useEffect(() => {
    const registrarReferido = async () => {
      if (!restauranteId || !clienteId) return;
      try {
        const { data: cliente } = await supabase
          .from('clientes').select('referidopor').eq('id', clienteId).maybeSingle();
        if (!cliente?.referidopor || cliente.referidopor === 'Directo (QR local)') return;

        const { data: referidor } = await supabase
          .from('clientes')
          .select('id, nombre')
          .eq('nombre', cliente.referidopor)
          .eq('restaurante_id', restauranteId)
          .maybeSingle();

        if (referidor) {
          // Antes esto hacía un UPDATE directo sobre `clientes.saldo_puntos`
          // desde el navegador — auditable en el error, pero también un
          // hueco de seguridad: cualquiera con la anon key podía llamar a
          // este mismo endpoint para acreditarse puntos a sí mismo o a
          // cualquier cliente_id, con cualquier monto. Insertar el registro
          // directamente en `transacciones_puntos` desde aquí tendría el
          // MISMO problema (solo que en otra tabla): el monto y el
          // cliente_id seguirían viniendo del navegador.
          //
          // Por eso esto llama a `fn_registrar_referido`, una función de
          // servidor (SECURITY DEFINER) que valida que el referidor
          // exista en esta sede, evita acreditar el mismo referido dos
          // veces, decide el monto de puntos ELLA MISMA (leyendo
          // `configuracion_restaurantes.puntos_por_referido`, no un valor
          // que mande el cliente) e inserta la fila 'REFERIDO' en el
          // ledger. El trigger centralizado se encarga de sumar el saldo.
          await supabase.rpc('fn_registrar_referido', {
            p_referidor_id:        referidor.id,
            p_restaurante_id:      restauranteId,
            p_cliente_referido_id: clienteId,
          });
        }
      } catch {}
    };
    registrarReferido();
  }, [restauranteId, clienteId]);

  const compartirWhatsApp = () => {
    const url = `${window.location.origin}/?r=${restauranteId}&ref=${encodeURIComponent(nombreCliente)}`;
    const msg =
      `🎉 ¡Me acabo de unir al club de *${nombreRestaurante}*!\n\n` +
      `Visítalos y acumula puntos para ganar premios. Usa mi enlace:\n${url}`;
    window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, '_blank');
  };

  return (
    <div style={styles.wrapper}>
      <div style={styles.card}>
        {/* Icono */}
        <div style={styles.iconWrap}>
          <span style={styles.icon}>🎉</span>
        </div>

        <h2 style={styles.heading}>
          ¡Bienvenido,<br />{nombreCliente?.split(' ')[0]}!
        </h2>
        <p style={styles.sub}>
          Ya eres parte del club <strong>{nombreRestaurante}</strong>.
        </p>

        {/* Puntos ganados */}
        <div style={styles.pointsBadge}>
          <span style={styles.pointsNum}>+{puntosActuales}</span>
          <span style={styles.pointsLabel}>puntos de bienvenida</span>
        </div>

        {/* Cómo funciona */}
        <div style={styles.stepsCard}>
          <p style={styles.stepsTitle}>¿Cómo funciona?</p>
          {[
            { icon: '📍', text: 'Visítanos y gana puntos solo por estar cerca' },
            { icon: '🧾', text: 'Pide en la barra con tu número de cédula para sumar más' },
            { icon: '🎁', text: `Al llegar a ${(montoMinimoRedencion ?? 15000).toLocaleString('es-CO')} pts, pagas con ellos como dinero real` },
          ].map(({ icon, text }) => (
            <div key={text} style={styles.stepRow}>
              <span style={styles.stepIcon}>{icon}</span>
              <span style={styles.stepText}>{text}</span>
            </div>
          ))}
        </div>

        {/* CTAs */}
        <button onClick={compartirWhatsApp} style={styles.btnWhatsapp}>
          📢 Compartir e invitar amigos
        </button>
        <button onClick={onClose} style={styles.btnSecondary}>
          Ver mi perfil →
        </button>
      </div>
    </div>
  );
};

const styles = {
  wrapper: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '100vh',
    padding: '1.5rem 1rem',
    background: 'var(--bg-subtle)',
  },
  card: {
    background: 'var(--bg-card)',
    borderRadius: 'var(--r-xl)',
    border: '1px solid var(--border)',
    boxShadow: 'var(--shadow-card)',
    padding: '2rem 1.75rem',
    width: '100%',
    maxWidth: 420,
    textAlign: 'center',
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
  },
  iconWrap: {
    width: 72, height: 72,
    background: 'var(--coral-light)',
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    margin: '0 auto',
  },
  icon:  { fontSize: '2rem' },
  heading: {
    fontFamily: 'var(--font-display)',
    fontSize: '1.6rem',
    fontWeight: 800,
    color: 'var(--text-h)',
    letterSpacing: '-0.02em',
    lineHeight: 1.15,
    margin: 0,
  },
  sub: { fontSize: '0.9rem', color: 'var(--text)', margin: 0 },
  pointsBadge: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    background: 'var(--coral-light)',
    border: '1px solid var(--coral-border)',
    borderRadius: 'var(--r-lg)',
    padding: '1rem',
    gap: 4,
  },
  pointsNum: {
    fontFamily: 'var(--font-display)',
    fontSize: '2.5rem',
    fontWeight: 800,
    color: 'var(--coral)',
    lineHeight: 1,
  },
  pointsLabel: { fontSize: '0.8rem', color: 'var(--text)', fontWeight: 500 },
  stepsCard: {
    background: 'var(--bg-subtle)',
    borderRadius: 'var(--r-lg)',
    padding: '1rem 1.25rem',
    textAlign: 'left',
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
  },
  stepsTitle: {
    fontSize: '10px',
    fontWeight: 700,
    letterSpacing: '0.1em',
    textTransform: 'uppercase',
    color: 'var(--text)',
    opacity: 0.5,
    margin: 0,
  },
  stepRow: { display: 'flex', alignItems: 'flex-start', gap: '10px' },
  stepIcon: { fontSize: '1rem', lineHeight: 1.4, flexShrink: 0 },
  stepText: { fontSize: '0.875rem', color: 'var(--text)', lineHeight: 1.45 },
  btnWhatsapp: {
    width: '100%',
    padding: '13px',
    background: '#25D366',
    color: 'white',
    border: 'none',
    borderRadius: 'var(--r-md)',
    fontFamily: 'var(--font-display)',
    fontWeight: 700,
    fontSize: '0.875rem',
    letterSpacing: '0.04em',
    cursor: 'pointer',
    textTransform: 'uppercase',
  },
  btnSecondary: {
    width: '100%',
    padding: '11px',
    background: 'var(--bg-subtle)',
    color: 'var(--text-h)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--r-md)',
    fontFamily: 'var(--font-body)',
    fontWeight: 600,
    fontSize: '0.875rem',
    cursor: 'pointer',
  },
};
