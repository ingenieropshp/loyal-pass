import { useState } from 'react';
import { supabase } from '../services/supabaseClient'; // Importación de tu cliente Supabase

// Recibe onSuccess, restaurantId y referidoPor desde App.js
export const RegistrationForm = ({ onSuccess, restaurantId, referidoPor }) => {
  const [formData, setFormData] = useState({
    nombre: '',
    telefono: '',
    fechaNacimiento: ''
  });
  const [loading, setLoading] = useState(false);

  // --- ESTADO PARA EL MODAL DE TÉRMINOS ---
  const [mostrarTerminos, setMostrarTerminos] = useState(false);

  // --- LÓGICA DE RANGO DE FECHAS ---
  const hoy = new Date();
  const fechaMaxima = hoy.toISOString().split("T")[0];
  const hace90Anios = new Date();
  hace90Anios.setFullYear(hoy.getFullYear() - 90);
  const fechaMinima = hace90Anios.toISOString().split("T")[0];

  // Manejador genérico de inputs
  const handleChange = (e) => {
    const { id, value } = e.target;
    
    let fieldName = id;
    if (id === 'whatsapp') fieldName = 'telefono';
    if (id === 'nacimiento') fieldName = 'fechaNacimiento';

    setFormData(prev => ({ ...prev, [fieldName]: value }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (loading) return;
    
    // 1. Validaciones básicas
    if (!formData.nombre.trim() || !formData.telefono.trim() || !formData.fechaNacimiento) {
      alert("Por favor, completa todos los campos.");
      return;
    }

    setLoading(true);

    try {
      // 2. BUSCAR SI EL CLIENTE YA EXISTE (Por teléfono)
      const { data: existente, error: errorBusqueda } = await supabase
        .from('clientes')
        .select('id, nombre, puntos')
        .eq('telefono', formData.telefono.trim())
        .maybeSingle();

      if (errorBusqueda) throw errorBusqueda;

      if (existente) {
        // --- SI EXISTE, NO CREAMOS OTRO, USAMOS EL MISMO ---
        console.log("Cliente ya registrado. Redirigiendo a éxito...");
        
        if (onSuccess) {
          // MODIFICACIÓN: Pasamos también los puntos actuales
          onSuccess(existente.id, existente.nombre, existente.puntos); 
        }
        setLoading(false);
        return; 
      }

      // 3. SI NO EXISTE, PROCEDER CON EL REGISTRO NORMAL
      const { data, error: errorInsert } = await supabase
        .from('clientes')
        .insert([
          {
            nombre: formData.nombre.trim(),
            telefono: formData.telefono.trim(),
            fecha_nacimiento: formData.fechaNacimiento,
            puntos: 2, 
            origen: 'Registro Web',
            restaurante_id: restaurantId,
            referidopor: referidoPor || "Directo (QR local)",
            fecha_registro: new Date().toISOString()
          }
        ])
        .select()
        .single();
      
      if (errorInsert) throw errorInsert;

      if (onSuccess) {
        // MODIFICACIÓN: Pasamos los 2 puntos iniciales del nuevo registro
        onSuccess(data.id, formData.nombre.trim(), 2); 
      }

    } catch (error) {
      console.error("Error detallado:", error);
      alert("Hubo un problema al procesar los datos.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="registration-card animate-fade-in">
      <header className="form-header">
        <h2 className="form-title">Crea tu Perfil</h2>
        <p className="form-subtitle">Únete y recibe beneficios exclusivos de Bistro.</p>
      </header>

      <div className="form-group">
        <label htmlFor="nombre">Nombre Completo</label>
        <input 
          id="nombre"
          type="text" 
          required
          placeholder="Ej: Juan Pérez"
          className="form-input"
          value={formData.nombre}
          onChange={handleChange}
        />
      </div>

      <div className="form-group">
        <label htmlFor="whatsapp">Teléfono / WhatsApp</label>
        <input 
          id="whatsapp"
          type="tel" 
          required
          pattern="[0-9]{10}"
          placeholder="Ej: 3206587850"
          className="form-input"
          value={formData.telefono}
          onChange={handleChange}
        />
      </div>

      <div className="form-group">
        <label htmlFor="nacimiento">Fecha de Nacimiento</label>
        <input 
          id="nacimiento"
          type="date" 
          required
          min={fechaMinima}
          max={fechaMaxima}
          className="form-input"
          value={formData.fechaNacimiento}
          onChange={handleChange}
        />
      </div>

      <button 
        type="submit" 
        disabled={loading}
        className="btn-submit"
        style={{ marginBottom: '15px' }}
      >
        {loading ? (
          <div className="loader-container">
            <div className="spinner"></div>
            <span>Procesando...</span>
          </div>
        ) : (
          'Unirme al Club'
        )}
      </button>

      {/* --- SECCIÓN DE BENEFICIOS Y TÉRMINOS --- */}
      <div style={{ 
        backgroundColor: '#f3f4f6', 
        borderRadius: '15px', 
        padding: '16px', 
        marginTop: '10px',
        textAlign: 'left',
        border: '1px solid #e5e7eb'
      }}>
        <p style={{ fontSize: '0.85rem', fontWeight: 'bold', color: '#374151', marginBottom: '10px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          ✨ Beneficios de Registro
        </p>
        
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div style={{ display: 'flex', alignItems: 'start', gap: '10px' }}>
            <span style={{ fontSize: '1rem' }}>🎁</span>
            <p style={{ fontSize: '0.75rem', color: '#4b5563', margin: 0 }}>
              Gana <strong>2 puntos</strong> hoy mismo por registrarte y visitar el local.
            </p>
          </div>

          <div style={{ display: 'flex', alignItems: 'start', gap: '10px' }}>
            <span style={{ fontSize: '1rem' }}>🎫</span>
            <p style={{ fontSize: '0.75rem', color: '#4b5563', margin: 0 }}>
              Al completar <strong>20 puntos</strong>, reclama tu premio sorpresa en caja.
            </p>
          </div>

          <div style={{ display: 'flex', alignItems: 'start', gap: '10px' }}>
            <span style={{ fontSize: '1rem' }}>⏳</span>
            <p style={{ fontSize: '0.75rem', color: '#4b5563', margin: 0 }}>
              ¡No pierdas tus puntos! Expiran si no visitas el local en <strong>30 días</strong>.
            </p>
          </div>
        </div>

        {/* --- BOTÓN PARA ABRIR TÉRMINOS --- */}
        <p 
          onClick={() => setMostrarTerminos(true)}
          style={{ 
            fontSize: '0.65rem', 
            color: '#6366f1', 
            marginTop: '12px', 
            fontStyle: 'italic', 
            cursor: 'pointer',
            textDecoration: 'underline'
          }}
        >
          * Al unirte, aceptas los Términos y Condiciones.
        </p>
      </div>
      
      <footer className="form-footer-note" style={{ marginTop: '15px' }}>
        <span>🔒 Tus datos están protegidos</span>
      </footer>

      {/* --- MODAL DE TÉRMINOS Y CONDICIONES --- */}
      {mostrarTerminos && (
        <div style={{
          position: 'fixed',
          top: 0, left: 0,
          width: '100%', height: '100%',
          backgroundColor: 'rgba(0,0,0,0.5)',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          zIndex: 1000,
          padding: '20px'
        }}>
          <div style={{
            backgroundColor: 'white',
            padding: '25px',
            borderRadius: '20px',
            maxWidth: '500px',
            width: '100%',
            maxHeight: '80vh',
            overflowY: 'auto',
            boxShadow: '0 10px 25px rgba(0,0,0,0.1)'
          }}>
            <h3 style={{ marginBottom: '15px', color: '#1e293b' }}>📜 Términos y Condiciones</h3>
            
            <div style={{ fontSize: '0.85rem', color: '#475569', lineHeight: '1.6', textAlign: 'left' }}>
              <p><strong>1. Acumulación de Puntos:</strong> Recibirás 2 puntos por cada visita confirmada mediante la validación del PIN por parte del personal del restaurante.</p>
              
              <p style={{ marginTop: '10px' }}><strong>2. Premios:</strong> Al completar 20 puntos, se activará un cupón de premio. Este debe ser presentado al mesero para su redención.</p>
              
              <p style={{ marginTop: '10px' }}><strong>3. Vencimiento:</strong> Tus puntos acumulados tienen una validez de 30 días calendario. Si no registras una nueva visita en este periodo, el contador volverá a cero.</p>
              
              <p style={{ marginTop: '10px' }}><strong>4. Uso de Datos:</strong> Al registrarte, autorizas el tratamiento de tus datos básicos únicamente para la gestión de este programa de fidelización.</p>
            </div>

            <button 
              type="button"
              onClick={() => setMostrarTerminos(false)}
              style={{
                marginTop: '20px',
                width: '100%',
                padding: '12px',
                backgroundColor: '#6366f1',
                color: 'white',
                border: 'none',
                borderRadius: '10px',
                fontWeight: 'bold',
                cursor: 'pointer'
              }}
            >
              Cerrar y Aceptar
            </button>
          </div>
        </div>
      )}
    </form>
  );
};