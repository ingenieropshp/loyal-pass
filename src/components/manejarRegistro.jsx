import { useEffect, useRef } from 'react';
import { supabase } from '../services/supabaseClient';

// --- LÓGICA DE REGISTRO ACTUALIZADA CON VALIDACIÓN POR SEDE ---
export const manejarRegistro = async (datosFormulario) => {
  try {
    // 1. Verificar si el teléfono ya existe para evitar duplicados en esta sede específica
    const { data: clienteExistente } = await supabase
      .from('clientes')
      .select('id, nombre, puntos')
      .eq('telefono', datosFormulario.telefono)
      .eq('restaurante_id', datosFormulario.restaurantId) // Validación por sede
      .maybeSingle();

    if (clienteExistente) {
      console.log("El cliente ya existe en esta sede, cargando datos...");
      return clienteExistente;
    }

    // 2. Crear registro nuevo con puntos de bienvenida y datos de referencia
    const { data: nuevoCliente, error } = await supabase
      .from('clientes')
      .insert([{
        nombre: datosFormulario.nombre,
        telefono: datosFormulario.telefono,
        puntos: 2, // Regalo inicial
        restaurante_id: datosFormulario.restaurantId,
        referido_por: datosFormulario.referidoPor || null,
        origen: 'Registro Web'
      }])
      .select()
      .single();

    if (error) throw error;
    return nuevoCliente;
  } catch (error) {
    console.error("Error en el proceso de registro:", error);
    return null;
  }
};

// --- FUNCIÓN DE CÁLCULO DE DISTANCIA (Haversine) ---
export const calcularDistancia = (lat1, lon1, lat2, lon2) => {
  const R = 6371; // Radio de la Tierra en km
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a = 
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) * 
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c; 
};

// --- COMPONENTE SUCCESS CARD ---
export const SuccessCard = ({ 
  restauranteId, 
  nombreRestaurante, 
  nombreCliente, 
  clienteId, 
  puntosActuales = 0,
  onClose 
}) => {
  const ejecutadoRef = useRef(false);

  const manejarLlegada = async (id) => {
    if (ejecutadoRef.current || !id) return;
    
    console.log("1. Iniciando validación de llegada...");
    
    try {
      const { data: restData, error: errorRest } = await supabase
        .from('conexion') 
        .select('latitud, longitud, radio_aviso')
        .eq('restaurante_id', restauranteId) // Cambiado a restaurante_id para consistencia
        .maybeSingle();

      if (errorRest || !restData) {
        console.error("2. Error al obtener datos del restaurante:", errorRest);
        return;
      }

      const { latitud: restLat, longitud: restLon, radio_aviso = 200 } = restData;
      
      navigator.geolocation.getCurrentPosition(async (position) => {
        try {
          const userLat = position.coords.latitude;
          const userLon = position.coords.longitude;
          const rLat = parseFloat(restLat);
          const rLon = parseFloat(restLon);

          const distanciaKm = calcularDistancia(userLat, userLon, rLat, rLon);
          const distanciaMetros = distanciaKm * 1000;

          console.log(`Distancia: ${distanciaMetros.toFixed(2)}m. Radio permitido: ${radio_aviso}m.`);

          if (distanciaMetros <= radio_aviso) {
            ejecutadoRef.current = true; 

            const { data: clienteDB } = await supabase
              .from('clientes')
              .select('puntos')
              .eq('id', id)
              .single();

            const puntosBase = clienteDB ? (Number(clienteDB.puntos) || 0) : Number(puntosActuales);
            const nuevosPuntos = puntosBase + 2;
            const tienePremio = nuevosPuntos >= 20;

            const { error: errorUpdate } = await supabase
              .from('clientes')
              .update({
                puntos: nuevosPuntos,
                ultima_visita: new Date().toISOString(),
                reclamo_pendiente: tienePremio 
              })
              .eq('id', id);

            if (errorUpdate) throw errorUpdate;
            
            if (nuevosPuntos >= 18 && nuevosPuntos < 20) {
              alert("¡Estás a solo una visita de tu premio! 🌟");
            } else if (tienePremio) {
              alert("¡FELICIDADES! 🎉 Tienes 20 puntos. Avisa al personal para canjear tu premio.");
            } else {
              alert(`¡Sumaste 2 puntos por tu visita! Total: ${nuevosPuntos} puntos.`);
            }
          } else {
            console.log("📍 Fuera del radio. No se suman puntos de visita.");
          }
        } catch (err) {
          console.error("❌ Error en actualización:", err.message);
        }
      }, (error) => {
        console.warn("❌ GPS desactivado o bloqueado.");
      }, { enableHighAccuracy: true, timeout: 15000 });

    } catch (err) {
      console.error("Error general:", err);
    }
  };

  useEffect(() => {
    if (clienteId && restauranteId && !ejecutadoRef.current) {
      manejarLlegada(clienteId);
    }
  }, [clienteId, restauranteId]);

  const handleCompartir = async () => {
    const nombreRef = encodeURIComponent(nombreCliente);
    const urlReferido = `${window.location.origin}/?r=${restauranteId}&ref=${nombreRef}`;
    const shareData = {
      title: `¡Regístrate en ${nombreRestaurante}!`,
      text: `¡Hola! Te invito a registrarte en ${nombreRestaurante}. Si vas de mi parte, ambos recibimos beneficios. 👇`,
      url: urlReferido,
    };

    try {
      if (navigator.share) {
        await navigator.share(shareData);
      } else {
        const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(shareData.text + " " + urlReferido)}`;
        window.open(whatsappUrl, '_blank');
      }
    } catch (err) {
      console.log("Error al compartir:", err);
    }
  };

  return (
    <div className="success-card-container animate-fade-in" style={{ 
      textAlign: 'center', 
      padding: '2.5rem 1.5rem',
      borderRadius: '15px',
      boxShadow: '0 10px 25px rgba(0,0,0,0.1)',
      backgroundColor: '#fff',
      maxWidth: '400px',
      margin: '20px auto',
      fontFamily: 'sans-serif'
    }}>
      <div style={{ fontSize: '4.5rem', marginBottom: '1rem' }}>🎁</div>
      
      <h2 style={{ color: '#3b82f6', marginBottom: '0.5rem', fontSize: '1.8rem' }}>
        ¡LISTO, {nombreCliente?.toUpperCase()}!
      </h2>
      
      <p style={{ marginBottom: '1.5rem', lineHeight: '1.6', color: '#475569' }}>
        Ahora eres embajador de <strong>{nombreRestaurante || "nuestro restaurante"}</strong>.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <button 
          onClick={handleCompartir}
          className="btn-whatsapp"
          style={{ 
            background: '#25D366', 
            color: 'white',
            display: 'flex', 
            alignItems: 'center', 
            justifyContent: 'center', 
            gap: '10px',
            boxShadow: '0 4px 15px rgba(37, 211, 102, 0.3)',
            border: 'none',
            borderRadius: '8px',
            padding: '14px',
            fontWeight: 'bold',
            cursor: 'pointer',
            fontSize: '1rem'
          }}
        >
          <span style={{ fontSize: '1.2rem' }}>📢</span> INVITAR UN AMIGO
        </button>

        <button 
          onClick={onClose || (() => window.location.reload())} 
          style={{ 
            background: '#3b82f6', 
            color: 'white',
            border: 'none', 
            borderRadius: '8px',
            padding: '12px',
            fontWeight: 'bold',
            cursor: 'pointer',
            fontSize: '0.9rem',
            marginTop: '0.5rem'
          }}
        >
          CONTINUAR
        </button>
      </div>
    </div>
  );
};

export default SuccessCard;