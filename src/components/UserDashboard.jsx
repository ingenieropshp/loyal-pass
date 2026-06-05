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

// ── Nivel según ciclos completados ─────────────────────────────────────────────
const calcularNivel = (ciclos = 0) => {
  if (ciclos >= 10) return { label: 'Oro',    emoji: '🥇', clase: 'nivel-oro',    next: null,  falta: 0   };
  if (ciclos >= 5)  return { label: 'Plata',  emoji: '🥈', clase: 'nivel-plata',  next: 'Oro',    falta: 10 - ciclos };
  return                   { label: 'Bronce', emoji: '🥉', clase: 'nivel-bronce', next: 'Plata',  falta: 5  - ciclos };
};

export const UserDashboard = ({ restauranteId, clienteId, nombreRestaurante, esCerca: inicialEsCerca }) => {
  const [cliente,       setCliente]       = useState(null);
  const [procesando,    setProcesando]    = useState(false);
  const [esCerca,       setEsCerca]       = useState(inicialEsCerca || false);
  const [mostrarPin,    setMostrarPin]    = useState(false);
  const [pinIngresado,  setPinIngresado]  = useState('');
  const [retos,         setRetos]         = useState([]);
  const [historial,     setHistorial]     = useState([]);
  const [vistaTab,      setVistaTab]      = useState('inicio'); // 'inicio' | 'retos' | 'historial'
  const [puntosBefore,  setPuntosBefore]  = useState(null); // para animación
  const pinInputRef = useRef(null);

  // ── Service Worker ───────────────────────────────────────────────────────────
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }
  }, []);

  // ── Cargar cliente ───────────────────────────────────────────────────────────
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

  // ── Realtime: escuchar cambios de puntos en tiempo real ──────────────────────
  useEffect(() => {
    if (!clienteId) return;
    const ch = supabase
      .channel(`cliente-rt-${clienteId}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'clientes', filter: `id=eq.${clienteId}` },
        (payload) => {
          setCliente(prev => {
            if (!prev) return payload.new;
            // guardar puntos anteriores para mostrar animación +N
            if (payload.new.puntos !== prev.puntos) {
              setPuntosBefore(prev.puntos);
              setTimeout(() => setPuntosBefore(null), 2500);
            }
            return { ...prev, ...payload.new };
          });
        }
      )
      .subscribe();
    return () => supabase.removeChannel(ch);
  }, [clienteId]);

  // ── Cargar retos activos del restaurante ─────────────────────────────────────
  useEffect(() => {
    if (!restauranteId) return;
    const fetchRetos = async () => {
      const hoy = new Date().toISOString();
      const { data } = await supabase
        .from('retos')
        .select('*')
        .eq('restaurante_id', restauranteId)
        .eq('activo', true)
        .or(`fecha_fin.is.null,fecha_fin.gt.${hoy}`)
        .order('created_at', { ascending: false });
      setRetos(data || []);
    };
    fetchRetos();
  }, [restauranteId]);

  // ── Cargar historial de visitas (metricas_proximidad) ────────────────────────
  useEffect(() => {
    if (!clienteId || !restauranteId) return;
    const fetchHistorial = async () => {
      const { data: cli } = await supabase
        .from('clientes').select('nombre').eq('id', clienteId).maybeSingle();
      if (!cli?.nombre) return;
      const { data } = await supabase
        .from('metricas_proximidad')
        .select('fecha, distancia, es_exito_total')
        .eq('restaurante_id', restauranteId)
        .eq('cliente', cli.nombre)
        .eq('es_exito_total', true)
        .order('fecha', { ascending: false })
        .limit(20);
      setHistorial(data || []);
    };
    fetchHistorial();
  }, [clienteId, restauranteId]);

  // ── Focus en pin input al abrir ──────────────────────────────────────────────
  useEffect(() => {
    if (mostrarPin) setTimeout(() => pinInputRef.current?.focus(), 100);
  }, [mostrarPin]);

  // ── Días restantes del cupón ─────────────────────────────────────────────────
  const diasRestantes = (() => {
    if (!cliente?.fecha_cumplimiento) return null;
    const vence = new Date(cliente.fecha_cumplimiento);
    vence.setDate(vence.getDate() + 30);
    return Math.ceil((vence - new Date()) / (1000 * 60 * 60 * 24));
  })();

  // Código de cupón: usa codigo_cupon si existe, si no genera uno del id
  const codigoCupon = cliente?.codigo_cupon || (clienteId ? clienteId.substring(0, 5).toUpperCase() : '');

  // ── Compartir cupón por WhatsApp ─────────────────────────────────────────────
  const enviarRecordatorioWhatsApp = () => {
    const msg =
      `*¡FELICIDADES!* 🎉\n\n` +
      `Has completado tus 20 puntos en *${nombreRestaurante}*.\n\n` +
      `🎫 *CUPÓN DE PREMIO*\nCódigo: ${codigoCupon}\n\n` +
      `⚠️ Preséntalo al mesero. Tienes ${diasRestantes} días.\n¡Te esperamos! 🍕`;
    window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, '_blank');
  };

  // ── Validar ubicación ────────────────────────────────────────────────────────
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
            cliente:           cliente?.nombre || 'Anónimo',
            restaurante:       nombreRestaurante,
            restaurante_id:    restauranteId,
            distancia:         Math.round(distM),
            dentro_del_rango_800: distM <= 800,
            es_exito_total:    distM <= radio,
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

  // ── Confirmar llegada con PIN ────────────────────────────────────────────────
  const manejarConfirmacion = async () => {
    setProcesando(true);
    try {
      const { data: db, error } = await supabase
        .from('clientes').select('pin_individual, puntos, ciclos_completados').eq('id', clienteId).single();
      if (error || !db) throw new Error();

      if (pinIngresado !== db.pin_individual) {
        alert('❌ PIN incorrecto. Solicita el código al mesero.');
        setProcesando(false);
        return;
      }

      const nuevosPuntos = (db.puntos || 0) + 2;
      const tienePremio  = nuevosPuntos >= TOTAL_PUNTOS;

      // Generar código de cupón único al alcanzar el premio
      const nuevoCodigo = tienePremio
        ? 'BC-' + Math.random().toString(36).substring(2, 7).toUpperCase()
        : null;

      const updates = {
        puntos:        nuevosPuntos,
        ultima_visita: new Date().toISOString(),
        ...(tienePremio && {
          reclamo_pendiente:  true,
          fecha_cumplimiento: new Date().toISOString(),
          codigo_cupon:       nuevoCodigo,
        }),
      };

      const { error: errUpdate } = await supabase
        .from('clientes').update(updates).eq('id', clienteId);
      if (errUpdate) throw errUpdate;

      setCliente(prev => ({ ...prev, ...updates, pin_individual: db.pin_individual }));

      if (tienePremio) alert(`🎉 ¡20 puntos! Muéstrale el código *${nuevoCodigo}* al mesero para reclamar tu premio.`);
      else alert(`✅ ¡+2 puntos! Ahora tienes ${nuevosPuntos} puntos.`);

      setMostrarPin(false);
      setPinIngresado('');
      setEsCerca(false);

      // Refrescar historial
      setHistorial(prev => [{
        fecha: new Date().toISOString(),
        distancia: 0,
        es_exito_total: true,
      }, ...prev].slice(0, 20));

    } catch {
      alert('Error al actualizar puntos. Intenta de nuevo.');
    }
    setProcesando(false);
  };

  // ── Compartir invitación ─────────────────────────────────────────────────────
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
  const ciclos     = cliente.ciclos_completados || 0;
  const nivel      = calcularNivel(ciclos);
  const progreso   = Math.min(puntos / TOTAL_PUNTOS, 1);
  const DOTS       = 10;
  const dotsLlenos = Math.floor((puntos / TOTAL_PUNTOS) * DOTS);

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <div className="dashboard-container animate-fade-in">

      {/* ── Header con nivel ── */}
      <div className="dash-header-row">
        <div>
          <div className="dash-welcome">Hola de nuevo,</div>
          <div className="dash-name">{cliente.nombre?.toUpperCase()}</div>
        </div>
        <div className={`nivel-badge-dash ${nivel.clase}`}>
          <span className="nivel-emoji">{nivel.emoji}</span>
          <div>
            <div className="nivel-label">{nivel.label}</div>
            <div className="nivel-ciclos">{ciclos} ciclo{ciclos !== 1 ? 's' : ''}</div>
          </div>
        </div>
      </div>

      {/* ── Animación de puntos ganados ── */}
      {puntosBefore !== null && (
        <div className="puntos-ganados-anim">
          +{puntos - puntosBefore} puntos 🎉
        </div>
      )}

      {/* ── Tabs de navegación ── */}
      <div className="dash-tabs">
        {[
          { id: 'inicio',   label: '🏠 Inicio' },
          { id: 'retos',    label: `🎯 Retos${retos.length > 0 ? ` (${retos.length})` : ''}` },
          { id: 'historial', label: '📅 Historial' },
        ].map(tab => (
          <button
            key={tab.id}
            className={`dash-tab-btn${vistaTab === tab.id ? ' active' : ''}`}
            onClick={() => setVistaTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* ══════════════ TAB INICIO ══════════════ */}
      {vistaTab === 'inicio' && (
        <>
          {/* Cupón activo */}
          {cliente.reclamo_pendiente && (
            <div className="coupon-card-container animate-bounce-slow">
              <div className="coupon-card">
                <div className="coupon-accent-bar" />
                <div className="coupon-body">
                  <div className="coupon-tag">Premio desbloqueado</div>
                  <div className="coupon-title">Vale por 1 premio</div>
                  <div className="coupon-sub">Presenta este código al mesero</div>
                  <div className="coupon-code">{codigoCupon}</div>
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

          {/* Info de nivel */}
          {nivel.next && (
            <div className="nivel-progress-info">
              <span>{nivel.emoji} {nivel.label}</span>
              <span className="nivel-falta">
                {nivel.falta} ciclo{nivel.falta !== 1 ? 's' : ''} más para {nivel.next === 'Plata' ? '🥈' : '🥇'} {nivel.next}
              </span>
            </div>
          )}

          {/* Acciones */}
          <div className="actions-stack">
            {!mostrarPin ? (
              <button onClick={validarUbicacion} disabled={procesando} className="btn-primary">
                {procesando ? 'Validando ubicación…' : '📍 Confirmar llegada (+2)'}
              </button>
            ) : (
              <div className="pin-container animate-fade-in">
                <span className="pin-label">PIN del mesero</span>
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
        </>
      )}

      {/* ══════════════ TAB RETOS ══════════════ */}
      {vistaTab === 'retos' && (
        <div className="retos-section">
          {retos.length === 0 ? (
            <div className="retos-empty">
              <div style={{ fontSize: '2.5rem' }}>🎯</div>
              <p>No hay retos activos por ahora.</p>
              <span>El restaurante publicará desafíos aquí con puntos extra.</span>
            </div>
          ) : (
            retos.map(r => {
              const vence = r.fecha_fin ? new Date(r.fecha_fin) : null;
              const diasReto = vence
                ? Math.max(0, Math.ceil((vence - new Date()) / (1000 * 60 * 60 * 24)))
                : null;
              return (
                <div key={r.id} className="reto-card">
                  <div className="reto-card-top">
                    <div className="reto-card-titulo">{r.titulo}</div>
                    <div className="reto-card-bonus">+{r.puntos_bonus} pts</div>
                  </div>
                  {r.descripcion && (
                    <div className="reto-card-desc">{r.descripcion}</div>
                  )}
                  <div className="reto-card-meta">
                    <span>🏁 {r.visitas_requeridas} visita{r.visitas_requeridas > 1 ? 's' : ''} requerida{r.visitas_requeridas > 1 ? 's' : ''}</span>
                    {diasReto !== null && (
                      <span className={diasReto <= 3 ? 'reto-urgente' : ''}>
                        ⏰ {diasReto === 0 ? 'Vence hoy' : `${diasReto}d restantes`}
                      </span>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}

      {/* ══════════════ TAB HISTORIAL ══════════════ */}
      {vistaTab === 'historial' && (
        <div className="historial-section">
          <div className="historial-resumen">
            <div className="hist-stat">
              <div className="hist-stat-num">{historial.length}</div>
              <div className="hist-stat-label">visitas registradas</div>
            </div>
            <div className="hist-stat">
              <div className="hist-stat-num">{ciclos}</div>
              <div className="hist-stat-label">premios ganados</div>
            </div>
            <div className="hist-stat">
              <div className="hist-stat-num">{puntos}</div>
              <div className="hist-stat-label">puntos actuales</div>
            </div>
          </div>

          {historial.length === 0 ? (
            <div className="retos-empty">
              <div style={{ fontSize: '2.5rem' }}>📅</div>
              <p>Aún no hay visitas registradas.</p>
              <span>Confirma tu llegada con GPS y PIN para que aparezcan aquí.</span>
            </div>
          ) : (
            <div className="historial-list">
              {historial.map((v, i) => (
                <div key={i} className="historial-item">
                  <div className="hist-icon">📍</div>
                  <div className="hist-info">
                    <div className="hist-fecha">
                      {new Date(v.fecha).toLocaleDateString('es-CO', {
                        weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
                      })}
                    </div>
                    <div className="hist-hora">
                      {new Date(v.fecha).toLocaleTimeString('es-CO', {
                        hour: '2-digit', minute: '2-digit',
                      })}
                    </div>
                  </div>
                  <div className="hist-puntos">+2 pts</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

    </div>
  );
};
