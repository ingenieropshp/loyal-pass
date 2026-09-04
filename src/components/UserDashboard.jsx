import { useState, useEffect } from 'react';
import { supabase } from '../services/supabaseClient';
import { TarjetaFidelizacion }              from './TarjetaFidelizacion';
import { HistorialPuntos }                  from './HistorialPuntos';
import './UserDashboard.css';

// TOTAL_PUNTOS eliminado — ahora se lee de la tabla conexion (configurable por admin)

export const UserDashboard = ({
  restauranteId,
  clienteId,
  nombreRestaurante,
  distancia,        // ← NUEVO: metros desde App.jsx (se actualiza con watchPosition)
  esCerca: inicialEsCerca,
  onLogout,          // ← NUEVO: función de App.jsx para cerrar sesión (supabase.auth.signOut)
}) => {
  const [cliente,        setCliente]        = useState(null);
  const [mostrarPerfil,  setMostrarPerfil]  = useState(false); // panel de "Perfil / Cerrar sesión"

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
        const registros = JSON.parse(localStorage.getItem('loyalpass_multisede') || '{}');
        delete registros[restauranteId];
        localStorage.setItem('loyalpass_multisede', JSON.stringify(registros));
        window.location.reload();
      } else {
        setCliente(data);
      }
    };
    fetchCliente();
  }, [clienteId, restauranteId]);

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

      {/* Header nombre + acceso a perfil/configuración */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', width: '100%' }}>
        <div>
          <div className="dash-welcome">Hola de nuevo,</div>
          <div className="dash-name">{cliente.nombre?.toUpperCase()}</div>
        </div>
        {onLogout && (
          <button
            onClick={() => setMostrarPerfil(v => !v)}
            aria-label="Perfil y configuración"
            style={{
              background: 'var(--bg-subtle)',
              border: '1px solid var(--border)',
              borderRadius: '50%',
              width: 36, height: 36,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: '1rem', cursor: 'pointer', flexShrink: 0,
            }}
          >
            ⚙️
          </button>
        )}
      </div>

      {/* Panel de perfil / configuración (solo "Cerrar sesión" por ahora) */}
      {mostrarPerfil && onLogout && (
        <div className="perfil-panel">
          <span className="perfil-email" title={cliente.email || cliente.telefono}>
            {cliente.email || cliente.telefono}
          </span>
          <button
            className="btn-logout"
            onClick={() => {
              // Confirmación simple para evitar cierres de sesión accidentales.
              if (window.confirm('¿Cerrar sesión? Podrás volver a ingresar con tu teléfono y contraseña.')) {
                onLogout();
              }
            }}
          >
            Cerrar sesión
          </button>
        </div>
      )}

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
      {/* Se retiró "Confirmar llegada": con el nuevo flujo operacional el
          cliente ya no escanea ni valida códigos desde la app — solo dicta
          su cédula en caja y el cajero registra el consumo. */}
      <div className="actions-stack">
        <button onClick={compartirInvitacion} className="btn-share">
          📢 Invitar a un amigo
        </button>
      </div>

      {/* ── Historial de puntos ────────────────────────────────────────── */}
      <HistorialPuntos
        clienteId={clienteId}
        restauranteId={restauranteId}
      />
    </div>
  );
};
