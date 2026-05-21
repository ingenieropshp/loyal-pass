import { useState, useEffect, useRef } from 'react';
import { supabase } from '../services/supabaseClient';
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

const TOTAL_PUNTOS = 20;

export const UserDashboard = ({ restauranteId, clienteId, nombreRestaurante, esCerca: inicialEsCerca }) => {
  const [cliente,      setCliente]      = useState(null);
  const [procesando,   setProcesando]   = useState(false);
  const [esCerca,      setEsCerca]      = useState(inicialEsCerca || false);
  const [mostrarPin,   setMostrarPin]   = useState(false);
  const [pinIngresado, setPinIngresado] = useState('');
  const pinInputRef = useRef(null);

  // ── Service Worker ──────────────────────────────────────────────────────
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }
  }, []);

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
      `Has completado tus 20 puntos en *${nombreRestaurante}*.\n\n` +
      `🎫 *CUPÓN DE PREMIO*\nCódigo: ${clienteId.substring(0, 5).toUpperCase()}\n\n` +
      `⚠️ Preséntalo al mesero. Tienes ${diasRestantes} días.\n¡Te esperamos! 🍕`;
    window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, '_blank');
  };

  // ── Validar ubicación ──────────────────────────────────────────────────
  const validarUbicacion = async () => {
    if (procesando) return;
    setProcesando(true);
    try {
      const { data: restData, error } = await supabase
        .from('conexion').select('latitud, longitud, radio_aviso')
        .eq('restaurante_id', restauranteId).maybeSingle();
      if (error || !restData) { alert('No se pudo obtener la ubicación de esta sede.'); return; }

      const rLat = parseFloat(restData.latitud);
      const rLon = parseFloat(restData.longitud);
      const radio = restData.radio_aviso || 200;

      navigator.geolocation.getCurrentPosition(
        async (pos) => {
          const { latitude: uLat, longitude: uLon } = pos.coords;
          const distM = calcularDistancia(uLat, uLon, rLat, rLon) * 1000;

          supabase.from('metricas_proximidad').insert([{
            cliente: cliente?.nombre || 'Anónimo',
            restaurante: nombreRestaurante,
            restaurante_id: restauranteId,
            distancia: Math.round(distM),
            dentro_del_rango_800: distM <= 800,
            es_exito_total: distM <= radio,
          }]).catch(() => {});

          if (distM <= radio) {
            setEsCerca(true);
            setMostrarPin(true);
          } else {
            alert(`📍 Estás a ${Math.round(distM)}m. Debes estar a menos de ${radio}m.`);
          }
          setProcesando(false);
        },
        (err) => {
          const msgs = { 1: 'Permite el acceso a tu ubicación.', 3: 'Señal GPS débil. Intenta en espacio abierto.' };
          alert(msgs[err.code] || 'Activa el GPS para confirmar tu llegada.');
          setProcesando(false);
        },
        { enableHighAccuracy: true, timeout: 15000 }
      );
    } catch { setProcesando(false); }
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
        setProcesando(false);
        return;
      }

      const nuevosPuntos = (db.puntos || 0) + 2;
      const tienePremio  = nuevosPuntos >= TOTAL_PUNTOS;

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

      if (tienePremio) alert('🎉 ¡20 puntos! Muéstrale esto al mesero para reclamar tu premio.');
      else alert(`✅ ¡+2 puntos! Ahora tienes ${nuevosPuntos} puntos.`);

      setMostrarPin(false);
      setPinIngresado('');
      setEsCerca(false);
    } catch {
      alert('Error al actualizar puntos. Intenta de nuevo.');
    }
    setProcesando(false);
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

  const puntos    = cliente.puntos || 0;
  const progreso  = Math.min(puntos / TOTAL_PUNTOS, 1);
  const DOTS      = 10;
  const dotsLlenos = Math.floor((puntos / TOTAL_PUNTOS) * DOTS);

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
          <span className="progress-count">{puntos} / {TOTAL_PUNTOS} pts</span>
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

      {/* Acciones */}
      <div className="actions-stack">
        {!mostrarPin ? (
          <button onClick={validarUbicacion} disabled={procesando} className="btn-primary">
            {procesando ? 'Validando ubicación…' : '📍 Confirmar llegada (+2)'}
          </button>
        ) : (
          <div className="pin-container animate-fade-in">
            <span className="pin-label">PIN del mesero</span>

            {/* Cajas visuales */}
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

            {/* Input real invisible para teclado nativo */}
            <input
              ref={pinInputRef}
              type="tel"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={4}
              value={pinIngresado}
              onChange={(e) => setPinIngresado(e.target.value.replace(/\D/g, '').slice(0, 4))}
              className="pin-input-hidden"
              aria-label="Ingresa PIN de 4 dígitos"
            />

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
    </div>
  );
};
