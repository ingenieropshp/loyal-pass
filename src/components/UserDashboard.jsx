import { useState, useEffect, useRef } from 'react';
import { supabase } from '../services/supabaseClient';
import { useIOS } from '../hooks/useIOS';
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

// ─── Badge de distancia ────────────────────────────────────────────────────────
const DistanciaBadge = ({ distancia, esCerca }) => {
  if (typeof distancia !== 'number') return null;

  const texto = esCerca
    ? 'Estás aquí'
    : distancia >= 1000
      ? `${(distancia / 1000).toFixed(1)} km`
      : `${Math.round(distancia)} m`;

  return (
    <div
      style={{
        display:        'flex',
        alignItems:     'center',
        gap:            '8px',
        padding:        '10px 16px',
        borderRadius:   '12px',
        background:     esCerca ? 'rgba(34,197,94,0.12)' : 'rgba(220,80,50,0.10)',
        border:         `1px solid ${esCerca ? 'rgba(34,197,94,0.3)' : 'rgba(220,80,50,0.25)'}`,
        marginBottom:   '12px',
        fontSize:       '0.88rem',
        fontWeight:     600,
        color:          esCerca ? '#16a34a' : '#e04a2f',
        transition:     'all 0.4s ease',
      }}
    >
      <span style={{ fontSize: '1.1rem' }}>{esCerca ? '✓' : '📍'}</span>
      <div>
        <div style={{ fontSize: '0.72rem', fontWeight: 500, opacity: 0.7, marginBottom: '1px' }}>
          {esCerca ? '¡Bienvenido!' : 'Estás a'}
        </div>
        <div>{texto}</div>
      </div>
    </div>
  );
};

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
  // Configuración dinámica del restaurante (se lee de conexion al montar)
  const [puntosLlegada,  setPuntosLlegada]  = useState(2);
  const [metaPuntos,     setMetaPuntos]     = useState(20);
  const pinInputRef = useRef(null);
  const { isIOS } = useIOS(); // en iOS el aviso automático de cercanía no funciona en 2do plano

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

  // ── Días restantes del cupón ───────────────────────────────────────────
  const diasRestantes = (() => {
    if (!cliente?.fecha_cumplimiento) return null;
    const vence = new Date(cliente.fecha_cumplimiento);
    vence.setDate(vence.getDate() + 30);
    return Math.ceil((vence - new Date()) / (1000 * 60 * 60 * 24));
  })();

  // ── Compartir cupón por WhatsApp ───────────────────────────────────────
  const enviarRecordatorioWhatsApp = () => {
    const msg =
      `*¡FELICIDADES!* 🎉\n\n` +
      `Has completado tus ${metaPuntos} puntos en *${nombreRestaurante}*.\n\n` +
      `🎫 *CUPÓN DE PREMIO*\nCódigo: ${clienteId.substring(0, 5).toUpperCase()}\n\n` +
      `⚠️ Preséntalo al mesero. Tienes ${diasRestantes} días.\n¡Te esperamos! 🍕`;
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
        timeout: 8000,
        maximumAge: 10000,
      });
    } catch (err) {
      if (err.code === 1) throw err; // permiso denegado: no reintentar
      return await obtenerPosicion({
        enableHighAccuracy: false,
        timeout: 10000,
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

      // Red de seguridad: si tras 12s no hay ni éxito ni error, forzamos el rechazo
      // para que el botón NUNCA se quede colgado, sin importar el navegador.
      const timeoutDuro = new Promise((_, reject) =>
        setTimeout(() => reject({ code: 'TIMEOUT_DURO' }), 12000)
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
        } else {
          alert(
            '📡 No se pudo obtener tu ubicación.\n' +
            'Asegúrate de tener GPS o WiFi activos e inténtalo de nuevo.'
          );
        }
        return;
      }

      const { latitude: uLat, longitude: uLon } = pos.coords;
      const distM = calcularDistancia(uLat, uLon, rLat, rLon) * 1000;

      const { error: insertError } = await supabase.from('metricas_proximidad').insert([{
        cliente:              cliente?.nombre || 'Anónimo',
        restaurante:          nombreRestaurante,
        restaurante_id:       restauranteId,
        distancia:            Math.round(distM),
        dentro_del_rango_800: distM <= 800,
        es_exito_total:       distM <= radio,
      }]);

      if (insertError) {
        // No detiene el flujo del usuario (la confirmación de llegada no depende
        // de la métrica), pero queda registrado para diagnosticar problemas de
        // RLS/permisos en la tabla metricas_proximidad sin afectar al cliente.
        console.error('[validarUbicacion] Error al insertar en metricas_proximidad:', insertError);
      }

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
        ...(tienePremio && {
          reclamo_pendiente:  true,
          fecha_cumplimiento: new Date().toISOString(),
        }),
      };

      const { error: errUpdate } = await supabase
        .from('clientes').update(updates).eq('id', clienteId);
      if (errUpdate) throw errUpdate;

      setCliente(prev => ({ ...prev, ...updates, pin_individual: db.pin_individual }));

      if (tienePremio) alert(`🎉 ¡${metaPuntos} puntos! Muéstrale esto al mesero para reclamar tu premio.`);
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
  const progreso   = Math.min(puntos / metaPuntos, 1);
  const DOTS       = 10;
  const dotsLlenos = Math.floor((puntos / metaPuntos) * DOTS);

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <div className="dashboard-container animate-fade-in">
      {/* Header */}
      <div className="dash-welcome">Hola de nuevo,</div>
      <div className="dash-name">{cliente.nombre?.toUpperCase()}</div>

      {/* Cupón activo */}
      {cliente.reclamo_pendiente && (
        <div className="coupon-card-container animate-bounce-slow">
          <div className="coupon-card">
            <div className="coupon-accent-bar" />
            <div className="coupon-body">
              <div className="coupon-tag">Premio desbloqueado</div>
              <div className="coupon-title">Vale por 1 premio</div>
              <div className="coupon-sub">Presenta este código al mesero</div>
              <div className="coupon-code">{clienteId.substring(0, 5).toUpperCase()}</div>
            </div>
            <div className="coupon-days-col">
              <div className="coupon-days-num">{diasRestantes > 0 ? diasRestantes : '!'}</div>
              <div className="coupon-days-label">{diasRestantes > 0 ? 'días' : 'vencido'}</div>
            </div>
          </div>
          <button onClick={enviarRecordatorioWhatsApp} className="btn-whatsapp-remind">
            📩 Guardar cupón en WhatsApp
          </button>
        </div>
      )}

      {/* Progress */}
      <div className="progress-section">
        <div className="progress-header">
          <span className="progress-label">Progreso hacia tu premio</span>
          <span className="progress-count">{puntos} / {metaPuntos} pts</span>
        </div>
        <div className="progress-track">
          <div className="progress-fill" style={{ width: `${progreso * 100}%` }} />
        </div>
        <div className="progress-dots">
          {Array.from({ length: DOTS }).map((_, i) => (
            <div
              key={i}
              className={`progress-dot${i < dotsLlenos ? ' filled' : i === dotsLlenos && puntos % 2 !== 0 ? ' current' : ''}`}
            />
          ))}
        </div>
      </div>

      {/* ── BUG 2 CORREGIDO: badge de distancia en tiempo real ── */}
      <DistanciaBadge distancia={distancia} esCerca={esCerca} />

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

      {/* Solo iPhone: el aviso automático de cercanía no funciona con la app
          cerrada o el celular bloqueado (limitación de iOS, no de la app).
          Se lo explicamos para que no piensen que está fallando. */}
      {isIOS && (
        <p className="footer-text" style={{ opacity: 0.65, marginTop: 4 }}>
          📍 En iPhone, abre la app al llegar para confirmar tu visita —
          el aviso automático solo funciona con la app abierta.
        </p>
      )}
    </div>
  );
};
