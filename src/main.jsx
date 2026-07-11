import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

// ── Registro del Service Worker ───────────────────────────────────────────────
// Se registra FUERA de React para que viva independiente del ciclo de vida
// de los componentes y funcione incluso con la app cerrada.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then((reg) => {
        console.log('[SW] Registrado correctamente. Scope:', reg.scope);

        // Detectar actualizaciones del SW en segundo plano
        reg.addEventListener('updatefound', () => {
          const newSW = reg.installing;
          newSW?.addEventListener('statechange', () => {
            if (newSW.state === 'installed' && navigator.serviceWorker.controller) {
              console.log('[SW] Nueva versión disponible.');
              // Opcional: mostrar un banner "Actualizar app"
            }
          });
        });
      })
      .catch((err) => console.error('[SW] Error al registrar:', err));
  });
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
