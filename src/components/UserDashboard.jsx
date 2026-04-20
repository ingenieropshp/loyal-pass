import { useState, useEffect } from 'react';
import { supabase } from '../services/supabaseClient'; 
import './UserDashboard.css'; 

const calcularDistancia = (lat1, lon1, lat2, lon2) => {
  const R = 6371; 
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
};

export const UserDashboard = ({ 
  restauranteId, 
  clienteId, 
  nombreRestaurante,
  distancia, 
  esCerca: inicialEsCerca 
}) => {
  const [cliente, setCliente] = useState(null);
  const [procesando, setProcesando] = useState(false);
  const [esCerca, setEsCerca] = useState(inicialEsCerca || false);
  const [mostrarPin, setMostrarPin] = useState(false);
  const [pinIngresado, setPinIngresado] = useState("");

  useEffect(() => {
    const fetchCliente = async () => {
      if (!clienteId) return;
      try {
        const { data, error } = await supabase
          .from('clientes')
          .select('*')
          .eq('id', clienteId)
          .maybeSingle();

        if (error) throw error;

        if (data) {
          setCliente(data);
        } else {
          console.warn("Cliente no encontrado en Supabase. Limpiando datos obsoletos...");
          const registros = JSON.parse(localStorage.getItem("bistro_multisede") || "{}");
          delete registros[restauranteId];
          localStorage.setItem("bistro_multisede", JSON.stringify(registros));
          window.location.reload();
        }
      } catch (error) {
        console.error("Error al cargar perfil:", error);
        alert("Error de conexión. Por favor, recarga la página.");
      }
    };
    fetchCliente();
  }, [clienteId, restauranteId]);

  const obtenerDiasRestantes = () => {
    if (!cliente || !cliente.fecha_cumplimiento) return null;
    const fechaInicio = new Date(cliente.fecha_cumplimiento);
    const fechaVencimiento = new Date(fechaInicio);
    fechaVencimiento.setDate(fechaInicio.getDate() + 30); 
    const hoy = new Date();
    const diferencia = fechaVencimiento - hoy;
    return Math.ceil(diferencia / (1000 * 60 * 60 * 24));
  };

  const diasRestantes = obtenerDiasRestantes();

  const enviarRecordatorioWhatsApp = () => {
    const mensaje = 
      `*¡FELICIDADES!* 🎉\n\n` +
      `Has completado tus 20 puntos en *${nombreRestaurante}*.\n\n` +
      `🎫 *CUPÓN DE PREMIO*\n` +
      `Código: ${clienteId.substring(0, 5).toUpperCase()}\n\n` +
      `⚠️ *No olvides presentar este mensaje* al mesero para reclamar tu beneficio.\n\n` +
      `Tienes ${diasRestantes} días a partir de hoy. ¡Te esperamos! 🍕`;

    const url = `https://wa.me/?text=${encodeURIComponent(mensaje)}`;
    window.open(url, '_blank');
  };

  const validarUbicacion = async () => {
    if (procesando) return;
    setProcesando(true);
    try {
      const { data: restData, error } = await supabase
        .from('conexion') 
        .select('latitud, longitud, radio_aviso')
        .eq('restaurante_id', restauranteId)
        .maybeSingle();

      if (error || !restData) {
        alert("No se pudo obtener la ubicación de esta sede.");
        setProcesando(false);
        return;
      }

      const rLat = parseFloat(restData.latitud);
      const rLon = parseFloat(restData.longitud);
      const radioPermitido = restData.radio_aviso || 200;

      navigator.geolocation.getCurrentPosition(async (pos) => {
        const userLat = pos.coords.latitude;
        const userLon = pos.coords.longitude;

        const distKm = calcularDistancia(userLat, userLon, rLat, rLon);
        const distMetros = distKm * 1000;
        const esExito = distMetros <= radioPermitido;

        try {
          await supabase.from('metricas_proximidad').insert([{
            cliente: cliente?.nombre || "Anónimo",
            restaurante: nombreRestaurante,
            restaurante_id: restauranteId,
            distancia: Math.round(distMetros),
            dentro_del_rango_800: distMetros <= 800,
            es_exito_total: esExito
          }]);
        } catch (err) {
          console.error("Error al guardar métricas:", err);
        }

        if (esExito) {
          setEsCerca(true);
          setMostrarPin(true);
        } else {
          alert(`📍 Estás a ${Math.round(distMetros)}m. \n\nPara confirmar tu llegada y sumar puntos, debes estar a menos de ${radioPermitido}m de ${nombreRestaurante}.`);
        }
        setProcesando(false);
      }, (err) => {
        let msg = "Por favor activa el GPS para confirmar tu llegada.";
        if (err.code === 1) msg = "Debes permitir el acceso a la ubicación en tu navegador.";
        if (err.code === 3) msg = "La señal del GPS es débil. Intenta de nuevo en un espacio abierto.";
        alert(msg);
        setProcesando(false);
      }, { enableHighAccuracy: true, timeout: 15000 });

    } catch (e) {
      console.error(e);
      setProcesando(false);
    }
  };

  const manejarConfirmacionFinal = async () => {
    setProcesando(true);
    
    try {
      // --- NUEVO: CONSULTA EN TIEMPO REAL DEL PIN ---
      const { data: dbCliente, error: dbError } = await supabase
        .from('clientes')
        .select('pin_individual, puntos')
        .eq('id', clienteId)
        .single();

      if (dbError || !dbCliente) throw new Error("Error al verificar el PIN.");

      // Validamos contra el dato recién traído de la base de datos
      if (pinIngresado !== dbCliente.pin_individual) {
        alert(`❌ PIN incorrecto. Solicita el código actualizado al mesero.`);
        setProcesando(false);
        return;
      }

      const nuevosPuntos = (dbCliente.puntos || 0) + 2;
      const updates = {
        puntos: nuevosPuntos,
        ultima_visita: new Date().toISOString(),
      };

      if (nuevosPuntos >= 20) {
        updates.reclamo_pendiente = true;
        updates.fecha_cumplimiento = new Date().toISOString();
      }

      const { error } = await supabase
        .from('clientes')
        .update(updates)
        .eq('id', clienteId);

      if (error) throw error;

      setCliente(prev => ({ 
        ...prev, 
        ...updates,
        pin_individual: dbCliente.pin_individual // Sincronizamos el nuevo PIN en el estado local
      }));
      
      if (nuevosPuntos >= 20) {
        alert("🎉 ¡FELICIDADES! Has llegado a 20 puntos.");
      } else {
        alert("✅ ¡Puntos sumados correctamente!");
      }
      
      setMostrarPin(false);
      setPinIngresado("");
      setEsCerca(false);
    } catch (error) {
      console.error("Error en validación:", error);
      alert("Error al actualizar puntos.");
    }
    setProcesando(false);
  };

  const compartirInvitacion = async () => {
    const shareData = {
      title: `¡Únete a ${nombreRestaurante}!`,
      text: `¡Hola! Me registré en ${nombreRestaurante}. Usa mi enlace para que ambos recibamos beneficios:`,
      url: `${window.location.origin}/?r=${restauranteId}&ref=${encodeURIComponent(cliente?.nombre || 'Amigo')}`
    };
    try {
      if (navigator.share) await navigator.share(shareData);
      else window.open(`https://wa.me/?text=${encodeURIComponent(shareData.text + " " + shareData.url)}`, '_blank');
    } catch (err) { console.log(err); }
  };

  if (!cliente) return <div className="loading-container">Sincronizando...</div>;

  return (
    <div className="dashboard-container animate-fade-in">
      <span className="gift-icon">🎁</span>
      <h2 className="welcome-title">¡LISTO, {cliente.nombre?.toUpperCase()}!</h2>
      <p className="subtitle">Ahora eres embajador de <strong>{nombreRestaurante}</strong>.</p>

      {cliente.reclamo_pendiente && (
        <div className="coupon-card-container animate-bounce-slow">
          <div className="coupon-card">
            <div className="coupon-left">
              <span className="coupon-brand">{nombreRestaurante}</span>
              <div className="coupon-main-content">
                <h3>¡VALE POR 1 PREMIO!</h3>
                <p>Presenta este código en caja</p>
              </div>
              <div className="coupon-footer">
                <span>{diasRestantes > 0 ? `Vence en: ${diasRestantes} días` : "⚠️ CUPÓN VENCIDO"}</span>
              </div>
            </div>
            <div className="coupon-right">
              <div className="coupon-id">{clienteId.toString().substring(0, 5).toUpperCase()}</div>
            </div>
            <div className="punch-hole-top"></div>
            <div className="punch-hole-bottom"></div>
          </div>
          <button onClick={enviarRecordatorioWhatsApp} className="btn-whatsapp-remind">
            📩 Guardar cupón en WhatsApp
          </button>
        </div>
      )}

      <div className="points-card">
        <span className="points-label">TUS PUNTOS ACTUALES</span>
        <span className="points-value">{cliente.puntos || 0}</span>
      </div>

      <div className="actions-stack">
        {!mostrarPin ? (
          <button onClick={validarUbicacion} disabled={procesando} className="btn-primary">
            {procesando ? "VALIDANDO UBICACIÓN..." : "📍 CONFIRMAR LLEGADA (+2)"}
          </button>
        ) : (
          <div className="pin-container animate-fade-in bg-white p-6 rounded-2xl shadow-inner border-2 border-indigo-100 mt-4">
            <p className="text-xs font-bold text-indigo-400 uppercase tracking-widest mb-3 text-center">Validación de Consumo</p>
            <input
              type="tel" pattern="[0-9]*" maxLength="4"
              value={pinIngresado}
              autoFocus
              onChange={(e) => setPinIngresado(e.target.value.replace(/\D/g, ""))}
              placeholder="0000"
              className="w-full text-center text-4xl font-black tracking-[1rem] py-3 border-b-4 border-indigo-500 focus:outline-none bg-transparent mb-6"
            />
            <div className="flex gap-3">
              <button onClick={() => {setMostrarPin(false); setPinIngresado("");}} className="flex-1 py-3 text-gray-400 font-semibold">Cancelar</button>
              <button onClick={manejarConfirmacionFinal} disabled={pinIngresado.length < 4 || procesando} className="flex-[2] py-3 bg-green-500 text-white rounded-xl font-bold shadow-lg disabled:opacity-50">
                {procesando ? "VERIFICANDO..." : "CONFIRMAR"}
              </button>
            </div>
          </div>
        )}

        <button onClick={compartirInvitacion} className="btn-share" style={{ marginTop: mostrarPin ? '1.5rem' : '0' }}>
          📢 INVITAR UN AMIGO
        </button>
      </div>

      <p className="footer-text">Cada vez que nos visites, confirma tu llegada para ganar premios.</p>
    </div>
  );
};