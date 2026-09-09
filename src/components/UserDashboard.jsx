import { useState, useEffect } from 'react';
import { supabase } from '../services/supabaseClient';
import { TarjetaFidelizacion }              from './TarjetaFidelizacion';
import RedimirPuntosModal                   from './RedimirPuntosModal';
import { BarraProgresoPuntos }              from './BarraProgresoPuntos';
import { PuntosPorVencer }                  from './PuntosPorVencer';
import { useGeofencingContext }             from './GeofencingProvider';
import { dispararToastPush }                from './PushToast';
import './UserDashboard.css';
import './BarraProgresoPuntos.css';

// TOTAL_PUNTOS eliminado — ahora se lee de la tabla conexion (configurable por admin)

// El parámetro `restauranteId` puede llegar como el UUID real o, por un bug
// de la URL de invitación (`?r=101%20Bistro`), como el NOMBRE del
// restaurante. Cuando no es un UUID válido, cualquier filtro `.eq('restaurante_id', …)`
// contra columnas uuid no hace match y las consultas devuelven 0 filas.
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isValidUUID = (valor) => typeof valor === 'string' && UUID_REGEX.test(valor);

export const UserDashboard = ({
  restauranteId,
  clienteId,
  nombreRestaurante,
  distancia,        // ← NUEVO: metros desde App.jsx (se actualiza con watchPosition)
  esCerca: inicialEsCerca,
  onLogout,          // ← NUEVO: función de App.jsx para cerrar sesión (supabase.auth.signOut)
}) => {
  const [cliente,        setCliente]        = useState(null);
  const [mostrarRedimir, setMostrarRedimir] = useState(false); // modal "Pagar con puntos"
  const [puntosVigentes, setPuntosVigentes] = useState(null); // saldo mostrado en la tarjeta
  const [cargandoPuntos, setCargandoPuntos] = useState(true);

  // Bono real de check-in por geocerca para ESTE restaurante (dinámico,
  // configurado por el admin en la tabla `conexion` vía puntos_llegada;
  // default 2 si no fue configurado — ver GeofencingProvider.jsx). Se llama
  // aquí arriba, antes de cualquier `return` condicional, por las reglas de
  // hooks de React.
  const { restaurantes: restaurantesGeofencing } = useGeofencingContext();

  // ── Cargar saldo de puntos ───────────────────────────────────────────────
  // 1) Fuente de verdad simple: el campo `puntos` de la tabla `clientes`
  //    (filtrando por `id`, o por `auth_user_id` si el clienteId corresponde
  //    al usuario autenticado en vez del id de la fila de clientes).
  // 2) Si existe la vista `saldo_usuario` (resta puntos vencidos/redimidos
  //    vía FIFO), se usa ese valor más preciso — pero el filtro
  //    `restaurante_id` solo se aplica si `restauranteId` es un UUID válido,
  //    porque el enlace de invitación a veces envía el NOMBRE del
  //    restaurante (`?r=101%20Bistro`) en vez de su UUID.
  const cargarPuntos = async () => {
    if (!clienteId) return;
    setCargandoPuntos(true);

    const { data: filaCliente, error: errorCliente } = await supabase
      .from('clientes')
      .select('saldo_puntos')
      .or(`id.eq.${clienteId},auth_user_id.eq.${clienteId}`)
      .maybeSingle();

    let saldo = !errorCliente ? (filaCliente?.saldo_puntos ?? 0) : 0;

    let query = supabase
      .from('saldo_usuario')
      .select('puntos_vigentes')
      .eq('cliente_id', clienteId);

    if (isValidUUID(restauranteId)) {
      query = query.eq('restaurante_id', restauranteId);
    } else if (restauranteId) {
      console.warn(
        '[UserDashboard] restauranteId no es un UUID válido, se omite el filtro en saldo_usuario:',
        restauranteId
      );
    }

    const { data: filaSaldo, error: errorSaldo } = await query.maybeSingle();
    if (!errorSaldo && filaSaldo?.puntos_vigentes != null) {
      saldo = filaSaldo.puntos_vigentes;
    }

    setPuntosVigentes(saldo);
    setCargandoPuntos(false);
  };

  useEffect(() => { cargarPuntos(); }, [clienteId, restauranteId]);

  // ── Supabase Realtime: saldo de puntos en vivo ──────────────────────────
  // Se suscribe a `transacciones_puntos` (el Ledger — ver descripción del
  // proyecto) filtrado por este cliente. Tanto un ingreso (consumo,
  // geocerca, bono) como un egreso (redención aplicada en caja, Paso 2 del
  // flujo atómico) son un INSERT en esta tabla — trg_actualizar_saldo_
  // cliente_por_transaccion ya corre en el mismo commit y deja
  // clientes.saldo_puntos al día, así que basta con re-consultar (cargarPuntos)
  // cuando llega el evento, sin recalcular nada del lado del cliente.
  // La tabla `supabase_realtime` publication ya incluye transacciones_puntos
  // y clientes (verificado en Supabase — no hace falta el ALTER PUBLICATION).
  //
  // Mismo patrón (canal/postgres_changes/removeChannel) que ya usa App.jsx
  // para `conexion`/`configuracion`. El toast reutiliza PushToast.jsx (no
  // hay librería de toasts instalada en este proyecto — ver package.json)
  // en vez de la API `toast.success/.info` del pedido original.
  useEffect(() => {
    if (!clienteId) return;

    const canal = supabase
      .channel(`realtime-puntos-${clienteId}`)
      .on(
        'postgres_changes',
        {
          event:  'INSERT',
          schema: 'public',
          table:  'transacciones_puntos',
          filter: `cliente_id=eq.${clienteId}`,
        },
        (payload) => {
          cargarPuntos();
          const { puntos, tipo } = payload.new;
          if (puntos > 0) {
            dispararToastPush({
              titulo: '🎉 ¡Puntos sumados!',
              cuerpo: `+${puntos.toLocaleString('es-CO')} pts al instante${tipo ? ` (${tipo})` : ''}.`,
            });
          } else if (puntos < 0) {
            dispararToastPush({
              titulo: '🎟️ Puntos descontados',
              cuerpo: `${Math.abs(puntos).toLocaleString('es-CO')} pts descontados de tu saldo.`,
            });
          }
        }
      )
      .subscribe();

    return () => { supabase.removeChannel(canal); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clienteId, restauranteId]);

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

  const puntos     = puntosVigentes ?? cliente.saldo_puntos ?? 0;

  const restauranteActual = restaurantesGeofencing.find(
    r => r.restaurante_id === restauranteId
  );
  const puntosLlegada = restauranteActual?.puntos_llegada ?? null;
  const puntosGeocerca = restauranteActual?.puntos_geocerca ?? null;
  const mensajeIncentivoConsumo = restauranteActual?.mensaje_incentivo_consumo || null;
  const montoMinimoRedencion = restauranteActual?.meta_puntos ?? 15000;

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <div className="dashboard-container animate-fade-in">

      {/* ── Tarjeta de fidelización con nivel ─────────────────────────── */}
      <TarjetaFidelizacion
        cliente={cliente}
        nombreRestaurante={nombreRestaurante}
        puntosTotales={puntos}
        cargandoPuntos={cargandoPuntos}
      />

      {/* ── Mis Puntos: progreso hacia el mínimo de redención ─────────── */}
      <BarraProgresoPuntos
        puntosActual={puntos}
        cargando={cargandoPuntos}
        puntosLlegada={puntosLlegada}
        puntosGeocerca={puntosGeocerca}
        mensajeIncentivoConsumo={mensajeIncentivoConsumo}
        montoMinimoRedencion={montoMinimoRedencion}
        onPagarConPuntos={() => setMostrarRedimir(true)}
      />

      {/* ── Tus puntos por vencer (vigencia de 90 días) ──────────────── */}
      <PuntosPorVencer clienteId={clienteId} restauranteId={restauranteId} />

      {/* Nombre del cliente */}
      <div style={{ width: '100%' }}>
        <div className="dash-welcome">Hola de nuevo,</div>
        <div className="dash-name">{cliente.nombre?.toUpperCase()}</div>
      </div>

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

      {/* ── Modal: redención de monto libre para pagar en caja ─────────── */}
      <RedimirPuntosModal
        isOpen={mostrarRedimir}
        onClose={() => setMostrarRedimir(false)}
        cliente={cliente}
        restauranteId={restauranteId}
        montoMinimoRedencion={montoMinimoRedencion}
        onRedencionExitosa={(nuevoSaldo) => {
          setCliente(prev => (prev ? { ...prev, saldo_puntos: nuevoSaldo } : prev));
          setPuntosVigentes(nuevoSaldo);
        }}
      />
    </div>
  );
};
