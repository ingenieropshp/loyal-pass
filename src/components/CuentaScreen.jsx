/**
 * CuentaScreen.jsx
 * Contenido de la pestaña "Cuenta" en la barra inferior: avatar,
 * saludo con el nombre del cliente, y el panel de perfil (correo/teléfono
 * + botón "Cerrar sesión") que antes vivía escondido detrás del ícono ⚙️
 * en el Inicio. Ahora es su propia pantalla, siempre visible.
 */

import { useState, useEffect } from 'react';
import { supabase } from '../services/supabaseClient';
import './UserDashboard.css';

function obtenerIniciales(nombreCompleto) {
  const partes = (nombreCompleto || '').trim().split(/\s+/).filter(Boolean);
  if (partes.length === 0) return '👤';
  return partes.slice(0, 2).map(p => p[0].toUpperCase()).join('') || '👤';
}

export function CuentaScreen({ clienteId, nombreCliente, onLogout }) {
  // Traemos email/teléfono directo de `clientes` — App.jsx solo conoce el
  // nombre (nombreCliente), no el resto del contacto.
  const [cliente, setCliente] = useState(null);

  useEffect(() => {
    if (!clienteId) return;
    supabase
      .from('clientes')
      .select('nombre, email, telefono')
      .eq('id', clienteId)
      .maybeSingle()
      .then(({ data }) => setCliente(data));
  }, [clienteId]);

  const nombre   = cliente?.nombre || nombreCliente || '';
  const contacto = cliente?.email || cliente?.telefono || '';

  return (
    <div style={{ width: '100%', paddingTop: '2rem' }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: '1.75rem' }}>
        <div style={{
          width: 72, height: 72, borderRadius: '50%',
          background: 'var(--coral)', color: 'white',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: '1.4rem',
          marginBottom: 12,
        }}>
          {obtenerIniciales(nombre)}
        </div>
        <p className="dash-welcome" style={{ textAlign: 'center' }}>Hola de nuevo,</p>
        <p className="dash-name" style={{ textAlign: 'center', marginBottom: 0 }}>
          {nombre ? nombre.toUpperCase() : '—'}
        </p>
      </div>

      {onLogout && (
        <div className="perfil-panel">
          <span className="perfil-email" title={contacto}>
            {contacto || '—'}
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
    </div>
  );
}
