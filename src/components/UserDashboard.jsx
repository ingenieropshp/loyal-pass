import { useState, useEffect, useRef } from 'react';
import { supabase } from '../services/supabaseClient';
import { TarjetaFidelizacion }              from './TarjetaFidelizacion';
import { CatalogoRecompensas, ModalCanje }  from './CatalogoRecompensas';
import { HistorialPuntos }                  from './HistorialPuntos';
import './UserDashboard.css';

const calcularDistancia = (lat1, lon1, lat2, lon2) => {
  const R    = 6371;
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) *
    Math.sin(dLon / 2) ** 2;
  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
};

// TOTAL_PUNTOS eliminado — ahora se lee de la tabla conexion (configurable por admin)

export const UserDashboard = ({
  restauranteId,
  clienteId,
  nombreRestaurante,
  distancia,        // ← NUEVO: metros desde App.jsx (se actualiza con watchPosition)
  esCerca: inicialEsCerca,
}) => {
  const [cliente,        setCliente]        = useState(null);
  const [procesando,     setProcesando]     = useState(false);
  const [esCerca,        setEsCerca]        = useState(inicialEsCerca || false);
  const [mostrarPin,     setMostrarPin]     = useState(false);
  const [pinIngresado,   setPinIngresado]   = useState('');
  const [puntosLlegada,  setPuntosLlegada]  = useState(2);
  const [metaPuntos,     setMetaPuntos]     = useState(20);
  // ── Nuevos estados para recompensas ───────────────────────────────────────
  const [recompensaACanjear, setRecompensaACanjear] = useState(null);
  const [historialKey,       setHistorialKey]       = useState(0); // fuerza re-render del historial
  const pinInputRef = useRef(null);

  // Sincronizar esCerca cuando cambia la distancia desde App.jsx
  useEffect(() => {
    setEsCerca(inicialEsCerca || false);
  }, [inicialEsCerca]);

  // ── Service Worker ──────────────────────────────────────────────────────
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }
  }, []);

  // ── Cargar configuración del restaurante (puntos y meta dinámica) ──────
  useEffect(() => {
    if (!restauranteId) return;
    supabase
      .from('conexion')
      .select('puntos_llegada, meta_puntos')
      .eq('restaurante_id', restauranteId)
      .maybeSingle()
      .then(({ data }) => {
        if (data) {
          if (data.puntos_llegada) setPuntosLlegada(data.puntos_llegada);
          if (data.meta_puntos)    setMetaPuntos(data.meta_puntos);
        }
      });
  }, [restauranteId]);

  // ── Cargar cliente ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!clienteId) return;
    const fetchCliente = async () => {
      const { data, error } = await supabase
        .from('clientes').select('*').eq('id', clienteId).maybeSingle();
      if (error || !data) {
        const registros = JSON.parse(localStorage.getItem('bistro_multisede') || '{}');
        delete registros[restauranteId];
        localStorage.setItem('bistro_multisede', JSON.stringify(registros));
        window.location.reload();
      } else {
        setCliente(data);
      }
    };
    fetchCliente();
  }, [clienteId, restauranteId]);

  // ── Focus en pin input al abrir ────────────────────────────────────────
  useEffect(() => {
    if (mostrarPin) setTimeout(() => pinInputRef.current?.focus(), 100);
  }, [mostrarPin]);

  // ── Cupones activos del cliente en este restaurante ─────────────────────
  const [cupones, setCupones] = useState([]);

  const cargarCupones = async () => {
    if (!clienteId) return;
    const { data } = await supabase
      .from('cupones')
      .select('*')
      .eq('cliente_id', clienteId)
      .eq('restaurante_id', restauranteId)
      .eq('estado', 'activo')
      .gt('fecha_vencimiento', new Date().toISOString())
      .order('fecha_canje', { ascending: false });
    setCupones(data || []);
  };

  useEffect(() => { cargarCupones(); }, [clienteId, restauranteId]);

  const diasRestantesDe = (fechaVencimiento) =>
    Math.ceil((new Date(fechaVencimiento) - new Date()) / (1000 * 60 * 60 * 24));

  // ── Compartir cupón por WhatsApp ───────────────────────────────────────
  const enviarRecordatorioWhatsApp = (cupon) => {
    const dias = diasRestantesDe(cupon.fecha_vencimiento);
    const msg =
      `*¡FELICIDADES!* 🎉\n\n` +
      `Tienes un premio activo en *${nombreRestaurante}*: ${cupon.nombre}\n\n` +
      `🎫 *CUPÓN DE PREMIO*\nCódigo: ${cupon.codigo}\n\n` +
      `⚠️ Preséntalo al mesero. Tienes ${dias > 0 ? dias : 0} días.\n¡Te esperamos! 🍕`;
    window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, '_blank');
  };

  // ── Validar ubicación ─────────────────────────────────────────────────
  // Estrategia en cascada:
  //   1. Alta precisión (GPS real, ideal en móvil) — timeout 8 s
  //   2. Si falla → baja precisión (WiFi / IP) — funciona en PC y móvil sin GPS claro
  //   3. finally garantiza que el botón siempre se desbloquea
  // Envuelve getCurrentPosition en una Promise simple y reutilizable
  const obtenerPosicion = (options) => {
    return new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, options);
    });
  };

  // Intento 1: alta precisión. Si falla (y no es por permiso denegado),
  // hace un Intento 2 SECUENCIAL (no anidado dentro del callback de error),
  // con baja precisión por WiFi/IP — más compatible con Safari/iOS y PWAs.
  const obtenerPosicionConFallback = async () => {
    try {
      return await obtenerPosicion({
        enableHighAccuracy: true,
        timeout: 6000,
        maximumAge: 15000,
      });
    } catch (err) {
      if (err.code === 1) throw err; // permiso denegado: no reintentar
      return await obtenerPosicion({
        enableHighAccuracy: false,
        timeout: 12000,
        maximumAge: 60000,
      });
    }
  };

  const validarUbicacion = async () => {
    if (procesando) return;
    setProcesando(true);
    try {
      const { data: restData, error } = await supabase
        .from('conexion').select('latitud, longitud, radio_aviso, puntos_llegada, meta_puntos')
        .eq('restaurante_id', restauranteId).maybeSingle();

      if (error || !restData) {
        alert('No se pudo obtener la ubicación de esta sede.');
        return;
      }

      const rLat  = parseFloat(restData.latitud);
      const rLon  = parseFloat(restData.longitud);
      const radio = restData.radio_aviso || 200;

      // Actualizar config dinámica en estado por si cambió desde que montó el componente
      if (restData.puntos_llegada) setPuntosLlegada(restData.puntos_llegada);
      if (restData.meta_puntos)    setMetaPuntos(restData.meta_puntos);

      // Red de seguridad: si tras 20s no hay ni éxito ni error, forzamos el
      // rechazo para que el botón NUNCA se quede colgado. 20s = margen real
      // para cubrir intento 1 (6s) + intento 2 (12s) sin cortar el fallback
      // de baja precisión antes de que termine (eso causaba falsos "no se
      // pudo obtener tu ubicación" estando dentro del rango).
      const timeoutDuro = new Promise((_, reject) =>
        setTimeout(() => reject({ code: 'TIMEOUT_DURO' }), 20000)
      );

      let pos;
      try {
        pos = await Promise.race([obtenerPosicionConFallback(), timeoutDuro]);
      } catch (err) {
        if (err.code === 1) {
          alert(
            '❌ Permiso de ubicación denegado.\n' +
            'Ve a Configuración del navegador → Privacidad → Ubicación\n' +
            'y permite el acceso para este sitio.'
          );
        } else if (err.code === 2) {
          alert(
            '📡 Tu teléfono no pudo obtener una señal de ubicación.\n' +
            'Revisa que la Ubicación esté activada en Ajustes del sistema ' +
            '(no solo el permiso del navegador) y que no esté en modo ahorro de batería.'
          );
        } else {
          alert(
            '⏱️ Se tardó demasiado en obtener tu ubicación.\n' +
            'Puede pasar por señal débil dentro del local.\n\n' +
            'Toca el botón de nuevo para intentarlo otra vez.'
          );
        }
        return;
      }

      const { latitude: uLat, longitude: uLon } = pos.coords;
      const distM = calcularDistancia(uLat, uLon, rLat, rLon) * 1000;

      // Fire-and-forget: no bloquea el flujo del usuario (la confirmación de
      // llegada no depende de esta métrica). Antes se hacía "await" y eso
      // sumaba un viaje de red completo antes de poder mostrar el PIN.
      supabase.from('metricas_proximidad').insert([{
        cliente:              cliente?.nombre || 'Anónimo',
        restaurante:          nombreRestaurante,
        restaurante_id:       restauranteId,
        distancia:            Math.round(distM),
        dentro_del_rango_800: distM <= 800,
        es_exito_total:       distM <= radio,
      }]).then(({ error: insertError }) => {
        if (insertError) {
          // Queda registrado para diagnosticar problemas de RLS/permisos
          // en la tabla metricas_proximidad sin afectar al cliente.
          console.error('[validarUbicacion] Error al insertar en metricas_proximidad:', insertError);
        }
      });

      if (distM <= radio) {
        setEsCerca(true);
        setMostrarPin(true);
      } else {
        alert(
          `📍 Estás a ${Math.round(distM)} m del restaurante.\n` +
          `Debes estar a menos de ${radio} m para confirmar tu llegada.`
        );
      }

    } catch (err) {
      console.error('[validarUbicacion] Error inesperado:', err);
      alert('Error inesperado. Intenta de nuevo.');
    } finally {
      setProcesando(false); // siempre desbloquea el botón
    }
  };

  // ── Confirmar llegada con PIN ───────────────────────────────────────────
  const manejarConfirmacion = async () => {
    setProcesando(true);
    try {
      const { data: db, error } = await supabase
        .from('clientes').select('pin_individual, puntos').eq('id', clienteId).single();
      if (error || !db) throw new Error();

      if (pinIngresado !== db.pin_individual) {
        alert('❌ PIN incorrecto. Solicita el código al mesero.');
        return;
      }

      const nuevosPuntos = (db.puntos || 0) + puntosLlegada;
      const tienePremio  = nuevosPuntos >= metaPuntos;

      const updates = {
        puntos:        nuevosPuntos,
        ultima_visita: new Date().toISOString(),
      };

      const { error: errUpdate } = await supabase
        .from('clientes').update(updates).eq('id', clienteId);
      if (errUpdate) throw errUpdate;

      setCliente(prev => ({ ...prev, ...updates, pin_individual: db.pin_individual }));

      // NOTA: antes aquí se generaba un cupón automático "Premio por visitas"
      // directo a la tabla `cupones`, sin recompensa asociada y sin pasar por
      // la función RPC de canje. Se eliminó porque quedó duplicado con el
      // catálogo de recompensas (CatalogoRecompensas.jsx / canjear_recompensa):
      // ahora, al llegar a la meta de puntos, el cliente simplemente ve
      // disponibles sus recompensas en el catálogo y las canjea desde ahí.

      // Registrar en historial de puntos — fire-and-forget: no bloquea la
      // alerta de éxito, que ya puede mostrarse con los puntos actualizados.
      supabase.from('historial_puntos').insert([{
        cliente_id:     clienteId,
        restaurante_id: restauranteId,
        tipo:           'visita',
        puntos:         puntosLlegada,
        descripcion:    `Visita confirmada en ${nombreRestaurante}`,
      }]).then(({ error: errHistorial }) => {
        if (errHistorial) console.error('[manejarConfirmacion] Error en historial_puntos:', errHistorial);
        setHistorialKey(k => k + 1); // refrescar historial cuando termine
      });

      if (tienePremio) alert(`🎉 ¡Llegaste a ${metaPuntos} puntos! Ya puedes canjear tu premio en el catálogo de recompensas.`);
      else alert(`✅ ¡+${puntosLlegada} puntos! Ahora tienes ${nuevosPuntos} puntos.`);

      setMostrarPin(false);
      setPinIngresado('');
      setEsCerca(false);
    } catch {
      alert('Error al actualizar puntos. Intenta de nuevo.');
    } finally {
      setProcesando(false);
    }
  };

  // ── Compartir invitación ───────────────────────────────────────────────
  const compartirInvitacion = async () => {
    const url  = `${window.location.origin}/?r=${restauranteId}&ref=${encodeURIComponent(cliente?.nombre || 'Amigo')}`;
    const text = `¡Hola! Me registré en ${nombreRestaurante}. Úsate mi enlace para que ambos ganemos beneficios:`;
    try {
      if (navigator.share) await navigator.share({ title: `Únete a ${nombreRestaurante}!`, text, url });
      else window.open(`https://wa.me/?text=${encodeURIComponent(text + ' ' + url)}`, '_blank');
    } catch {}
  };

  if (!cliente) return <div className="loading-container">Sincronizando…</div>;

  const puntos     = cliente.puntos || 0;

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <div className="dashboard-container animate-fade-in">

      {/* ── Tarjeta de fidelización con nivel ─────────────────────────── */}
      <TarjetaFidelizacion
        cliente={cliente}
        nombreRestaurante={nombreRestaurante}
        puntosTotales={puntos}
      />

      {/* Header nombre */}
      <div className="dash-welcome">Hola de nuevo,</div>
      <div className="dash-name">{cliente.nombre?.toUpperCase()}</div>

      {/* Cupones activos (premio por visitas + canjes del catálogo) */}
      {cupones.map(cupon => {
        const dias = diasRestantesDe(cupon.fecha_vencimiento);
        return (
          <div key={cupon.id} className="coupon-card-container animate-bounce-slow">
            <div className="coupon-card">
              <div className="coupon-accent-bar" />
              <div className="coupon-body">
                <div className="coupon-tag">Premio desbloqueado</div>
                <div className="coupon-title">{cupon.nombre}</div>
                <div className="coupon-sub">Presenta este código al mesero</div>
                <div className="coupon-code">{cupon.codigo}</div>
              </div>
              <div className="coupon-days-col">
                <div className="coupon-days-num">{dias > 0 ? dias : '!'}</div>
                <div className="coupon-days-label">{dias > 0 ? 'días' : 'vencido'}</div>
              </div>
            </div>
            <button onClick={() => enviarRecordatorioWhatsApp(cupon)} className="btn-whatsapp-remind">
              📩 Guardar cupón en WhatsApp
            </button>
          </div>
        );
      })}

      {/* Acciones */}
      <div className="actions-stack">
        {!mostrarPin ? (
          <button onClick={validarUbicacion} disabled={procesando} className="btn-primary">
            {procesando ? 'Validando ubicación…' : `📍 Confirmar llegada (+${puntosLlegada})`}
          </button>
        ) : (
          <div className="pin-container animate-fade-in">
            <span className="pin-label">PIN del mesero</span>

            {/* Cajas visuales + input real superpuesto (tocable en toda el área) */}
            <div
              className="pin-input-wrapper"
              onClick={() => pinInputRef.current?.focus()}
            >
              <div className="pin-boxes">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div
                    key={i}
                    className={`pin-box${i === pinIngresado.length ? ' active' : pinIngresado[i] ? '' : ' empty'}`}
                  >
                    {pinIngresado[i] ? '•' : ''}
                  </div>
                ))}
              </div>

              {/* Input real invisible para teclado nativo, superpuesto y tocable */}
              <input
                ref={pinInputRef}
                type="tel"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={4}
                autoComplete="one-time-code"
                value={pinIngresado}
                onChange={(e) => setPinIngresado(e.target.value.replace(/\D/g, '').slice(0, 4))}
                className="pin-input-hidden"
                aria-label="Ingresa PIN de 4 dígitos"
              />
            </div>

            <div className="pin-actions">
              <button onClick={() => { setMostrarPin(false); setPinIngresado(''); }} className="btn-cancel">
                Cancelar
              </button>
              <button
                onClick={manejarConfirmacion}
                disabled={pinIngresado.length < 4 || procesando}
                className="btn-verify"
              >
                {procesando ? 'Verificando…' : 'Confirmar'}
              </button>
            </div>
          </div>
        )}

        <button onClick={compartirInvitacion} className="btn-share">
          📢 Invitar a un amigo
        </button>
      </div>

      <p className="footer-text">
        Confirma tu llegada en cada visita para seguir sumando puntos y premios.
      </p>

      {/* ── Catálogo de recompensas ────────────────────────────────────── */}
      <CatalogoRecompensas
        restauranteId={restauranteId}
        puntosActuales={puntos}
        onCanjear={r => setRecompensaACanjear(r)}
      />

      {/* ── Historial de puntos ────────────────────────────────────────── */}
      <HistorialPuntos
        key={historialKey}
        clienteId={clienteId}
        restauranteId={restauranteId}
      />

      {/* ── Modal de canje ─────────────────────────────────────────────── */}
      {recompensaACanjear && (
        <ModalCanje
          recompensa={recompensaACanjear}
          clienteId={clienteId}
          puntosActuales={puntos}
          onExito={(nuevosPuntos) => {
            setCliente(prev => ({ ...prev, puntos: nuevosPuntos }));
            setHistorialKey(k => k + 1);
            setRecompensaACanjear(null);
            cargarCupones();
          }}
          onCerrar={() => setRecompensaACanjear(null)}
        />
      )}
    </div>
  );
};
