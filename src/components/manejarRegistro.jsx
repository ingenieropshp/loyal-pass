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
 * obtenerCiudadYLocalidad
 * ────────────────────────────────────────────────────────────────────────
 * Geocodificación inversa (pedido explícito del usuario — sept 2026):
 * convierte unas coordenadas GPS en nombre de ciudad/municipio y de
 * barrio/vereda, usando Nominatim (OpenStreetMap) — servicio GRATUITO, sin
 * API key ni cuenta (el usuario eligió esta opción sobre Google Maps de
 * pago). `addressdetails=1` es lo que hace que la respuesta traiga el
 * objeto `address` desglosado en vez de solo un texto plano.
 *
 * Nominatim no siempre usa el mismo nombre de campo para "ciudad" — varía
 * según qué tan grande sea el lugar (una capital trae `city`, un municipio
 * chico como Apartadó puede traer `town` o `municipality`) — por eso se
 * prueban varios campos en cascada. Lo mismo para "localidad"
 * (barrio/vereda): `suburb`/`neighbourhood` en zona urbana,
 * `village`/`hamlet` en zona rural.
 *
 * Nunca lanza: si la consulta falla (sin internet, Nominatim caído, etc.)
 * devuelve { ciudad: null, localidad: null } para que el llamador guarde
 * NULL en vez de romper el flujo de bienvenida.
 */
async function obtenerCiudadYLocalidad(lat, lon) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&addressdetails=1&accept-language=es&zoom=16`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return { ciudad: null, localidad: null };
    const data = await res.json();
    const addr = data?.address || {};
    const ciudad =
      addr.city || addr.town || addr.municipality || addr.county || null;
    const localidad =
      addr.suburb || addr.neighbourhood || addr.quarter || addr.village || addr.hamlet || null;
    return { ciudad, localidad };
  } catch {
    return { ciudad: null, localidad: null };
  }
}

/**
 * SuccessCard — pantalla mostrada justo después de un registro exitoso.
 * Props:
 *   restauranteId, nombreRestaurante, nombreCliente,
 *   clienteId, puntosActuales, onClose
 *   esReingreso → true cuando esto no fue un registro nuevo sino la
 *                 reactivación de una desvinculación anterior (ver
 *                 fn_cliente_reingresa_restaurante en supabaseClient.js).
 *                 Cambia el mensaje de bienvenida — nunca hay un segundo
 *                 bono de bienvenida en este caso, así que no tendría
 *                 sentido mostrar "+0 puntos de bienvenida".
 */
export const SuccessCard = ({
  restauranteId,
  nombreRestaurante,
  nombreCliente,
  clienteId,
  puntosActuales = 500,
  esReingreso = false,
  onClose,
}) => {
  // Monto mínimo de redención real de este restaurante, para el paso
  // "¿Cómo funciona?" — se consulta aparte porque este componente no recibe
  // config como prop desde App.jsx.
  const [montoMinimoRedencion, setMontoMinimoRedencion] = useState(15000);
  useEffect(() => {
    if (!restauranteId) return;
    // FIX: mismo patrón que CatalogoRecompensas.jsx/HistorialPuntos.jsx —
    // este `.then()` no tenía `.catch()`. No es crítico (montoMinimoRedencion
    // ya tiene un valor por defecto de 15000 vía useState), pero un rechazo
    // sin manejar igual aparecía en consola como "Uncaught (in promise) ▶
    // Object" en esta misma pantalla (SuccessCard, justo después de
    // registrarse), sumándose a los otros casos reportados.
    supabase
      .from('configuracion_restaurantes')
      .select('monto_minimo_redencion')
      .eq('restaurante_id', restauranteId)
      .maybeSingle()
      .then(({ data, error }) => {
        if (error) {
          console.warn('[SuccessCard] No se pudo cargar el monto mínimo de redención, se usa el valor por defecto:', error.message);
          return;
        }
        if (data?.monto_minimo_redencion) setMontoMinimoRedencion(data.monto_minimo_redencion);
      })
      .catch((err) => {
        console.warn('[SuccessCard] Error inesperado cargando el monto mínimo de redención:', err?.message || err);
      });
  }, [restauranteId]);

  // Notificación de bienvenida (best-effort)
  useEffect(() => {
    const enviarNotificacion = async () => {
      if (!('Notification' in window)) return;
      if (Notification.permission !== 'granted') return;
      try {
        const reg = await navigator.serviceWorker.ready;
        reg.showNotification(
          esReingreso ? `¡Bienvenido de vuelta a ${nombreRestaurante}! 🎉` : `¡Bienvenido a ${nombreRestaurante}! 🎉`,
          {
            body: esReingreso
              ? 'Tu perfil de fidelización quedó activo de nuevo. ¡Sigue visitándonos!'
              : `Has ganado tus primeros ${puntosActuales} puntos. ¡Sigue visitándonos!`,
            icon:    '/icon-192.png',
            badge:   '/icon-72.png',
            vibrate: [100, 50, 100],
          }
        );
      } catch {}
    };
    enviarNotificacion();
  }, [nombreRestaurante, puntosActuales, esReingreso]);

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

  // Captura de ciudad/localidad (pedido explícito del usuario — sept 2026)
  // ──────────────────────────────────────────────────────────────────────
  // A propósito es un efecto INDEPENDIENTE del de arriba (bono de
  // proximidad), aunque los dos piden GPS: ese efecto puede cortar temprano
  // si no logra leer la config de geocerca del restaurante (`conexion`), y
  // esta captura de ubicación no debería depender de eso — el objetivo acá
  // es simplemente saber de dónde es el cliente, sin importar si está cerca
  // o lejos del local en este momento (alguien puede registrarse desde su
  // casa, en otro barrio o incluso otro municipio).
  //
  // 100% "fire and forget", igual que el bono de proximidad: nunca bloquea
  // la pantalla de bienvenida, nunca muestra un error al cliente. Si no da
  // permiso de ubicación, o el dispositivo no tiene GPS (ej. escritorio),
  // o falla la consulta a Nominatim, `clientes.ciudad`/`localidad`
  // simplemente quedan en NULL — el panel admin ya maneja ese caso como
  // "Sin ubicación" en vez de inventar un dato.
  useEffect(() => {
    const capturarUbicacionRegistro = async () => {
      if (!clienteId) return;
      if (!('geolocation' in navigator)) return;
      try {
        const posicion = await obtenerPosicionActual();
        const { ciudad, localidad } = await obtenerCiudadYLocalidad(
          posicion.coords.latitude,
          posicion.coords.longitude
        );
        if (!ciudad && !localidad) return; // nada que guardar
        const { error } = await supabase
          .from('clientes')
          .update({ ciudad, localidad })
          .eq('id', clienteId);
        if (error) {
          console.warn('[SuccessCard] No se pudo guardar ciudad/localidad:', error.message);
        }
      } catch (err) {
        // Best-effort, igual que el bono de proximidad — no bloquea nada.
        console.warn('[SuccessCard] No se pudo capturar ciudad/localidad —', describirErrorGeolocalizacion(err));
      }
    };
    capturarUbicacionRegistro();
  }, [clienteId]);

  // Registrar referido si aplica
  useEffect(() => {
    const registrarReferido = async () => {
      if (!restauranteId || !clienteId) return;
      try {
        const { data: cliente } = await supabase
          .from('clientes').select('referidopor').eq('id', clienteId).maybeSingle();
        if (!cliente?.referidopor || cliente.referidopor === 'Directo (QR local)') return;

        // FIX seguridad: antes esto leía la fila de OTRO cliente directamente
        // (`.from('clientes').select('id, nombre')...`), lo cual solo
        // funcionaba porque la política de RLS "Clientes ven su propio
        // perfil" tenía un `OR cedula IS NOT NULL` demasiado amplio — dejaba
        // que cualquier cliente autenticado leyera la fila de cualquier
        // otro. Esa política ya se eliminó (ver migración
        // acotar_rls_clientes_y_rpc_referidor_seguro), así que ahora se
        // resuelve el referidor con una función de servidor (SECURITY
        // DEFINER) que SOLO devuelve id + nombre — nunca teléfono, cédula,
        // fecha de nacimiento ni saldo — y mantiene el mismo alcance que ya
        // tenía este código (mismo restaurante, coincidencia de nombre).
        const { data: referidorRows, error: errorReferidor } = await supabase.rpc(
          'fn_buscar_referidor_seguro',
          { p_restaurante_id: restauranteId, p_nombre: cliente.referidopor }
        );
        if (errorReferidor) {
          console.warn('[manejarRegistro] Error buscando referidor:', errorReferidor.message);
        }
        const referidor = referidorRows?.[0]
          ? { id: referidorRows[0].cliente_id, nombre: referidorRows[0].nombre_publico }
          : null;

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
          {esReingreso ? (
            <>¡Bienvenido de vuelta,<br />{nombreCliente?.split(' ')[0]}!</>
          ) : (
            <>¡Bienvenido,<br />{nombreCliente?.split(' ')[0]}!</>
          )}
        </h2>
        <p style={styles.sub}>
          Ya eres parte del club <strong>{nombreRestaurante}</strong>.
        </p>

        {/* Puntos ganados — en un reingreso nunca hay un segundo bono de
            bienvenida (ver fn_bono_bienvenida/columna bono_bienvenida_aplicado
            en Supabase), así que en vez del badge de "+puntos" se explica
            que el saldo arranca en 0. */}
        {esReingreso ? (
          <div style={styles.pointsBadge}>
            <span style={{ ...styles.pointsLabel, fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-h)' }}>
              ¡Bienvenido de vuelta! Recuerda que al unirte nuevamente tu saldo inicia en 0 puntos.
            </span>
          </div>
        ) : (
          <div style={styles.pointsBadge}>
            <span style={styles.pointsNum}>+{puntosActuales}</span>
            <span style={styles.pointsLabel}>puntos de bienvenida</span>
          </div>
        )}

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
