/**
 * sw.js — Bistro Connect Service Worker v2.0
 *
 * Responsabilidades:
 *  1. Cache de assets estáticos (estrategia cache-first)
 *  2. Recibir push notifications con payload dinámico del restaurante
 *  3. Manejar clics en notificaciones (abrir URL del menú)
 *  4. Responder a mensajes del cliente (skip-waiting)
 */

const CACHE_NAME   = 'bistro-v2';
const STATIC_ASSETS = ['/', '/index.html', '/manifest.json', '/icons/icon-192.png'];

// ── Instalación: pre-cachear assets críticos ──────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// ── Activación: limpiar caches viejos ────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ── Fetch: cache-first para estáticos, network-first para API ─────────────────
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);

  // Peticiones a Supabase o APIs externas: siempre red
  if (url.hostname.includes('supabase.co') || url.pathname.startsWith('/api/')) return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (!response || response.status !== 200 || response.type !== 'basic') return response;
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        return response;
      });
    })
  );
});

// ── Push: recibir payload dinámico del backend ────────────────────────────────
self.addEventListener('push', (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = {
      restauranteNombre: 'Bistro Connect',
      titulo:   '¡Estás cerca!',
      cuerpo:   'Confirma tu llegada y suma puntos.',
      urlMenu:  '/',
      icono:    '/icons/icon-192.png',
    };
  }

  /**
   * Estructura esperada del payload (enviado desde la Edge Function):
   * {
   *   restauranteId:    string,
   *   restauranteNombre: string,
   *   titulo:           string,   // ej: "¡Estás cerca de 101 Bistro!"
   *   cuerpo:           string,   // ej: "Entra y confirma tu llegada para ganar 7 puntos"
   *   urlMenu:          string,   // ej: "https://bistro-app.pages.dev/?r=uuid"
   *   icono:            string,   // URL del logo del restaurante (opcional)
   *   badge:            string,   // URL del badge monocromático (opcional)
   *   puntosLlegada:    number,
   * }
   */
  const {
    titulo           = '¡Estás cerca!',
    cuerpo           = 'Confirma tu llegada y suma puntos.',
    urlMenu          = '/',
    restauranteNombre = 'Bistro Connect',
    icono            = '/icons/icon-192.png',
    badge            = '/icons/badge-72.png',
    puntosLlegada    = 2,
  } = payload;

  const options = {
    body: cuerpo,
    icon: icono,
    badge,
    tag:  `geofence-${payload.restauranteId || 'global'}`, // evita notifs duplicadas
    renotify:         false,
    requireInteraction: false,
    vibrate:          [200, 100, 200],
    timestamp:        Date.now(),
    data: {
      url:              urlMenu,
      restauranteId:    payload.restauranteId,
      restauranteNombre,
    },
    actions: [
      {
        action: 'ver-menu',
        title:  `Ver menú ☕ (+${puntosLlegada} pts)`,
        icon:   '/icons/icon-96.png',
      },
      {
        action: 'dismiss',
        title:  'Ahora no',
      },
    ],
  };

  event.waitUntil(
    self.registration.showNotification(titulo, options)
  );
});

// ── Clic en notificación ──────────────────────────────────────────────────────
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const { url, restauranteId } = event.notification.data || {};
  const destino = url || '/';

  if (event.action === 'dismiss') return;

  // "ver-menu" o clic en el cuerpo: abrir o enfocar la app
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      // Si ya hay una pestaña/ventana abierta, la enfoca y navega
      for (const client of clients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.postMessage({ type: 'GEOFENCE_CLICK', restauranteId, url: destino });
          return client.focus();
        }
      }
      // Si no hay ninguna, abre una nueva
      if (self.clients.openWindow) {
        return self.clients.openWindow(destino);
      }
    })
  );
});

// ── Cierre de notificación (telemetría opcional) ──────────────────────────────
self.addEventListener('notificationclose', (event) => {
  // Aquí podrías registrar en analytics que el usuario descartó la notif
  console.log('[SW] Notificación cerrada sin interacción:', event.notification.tag);
});

// ── Mensajes del cliente ──────────────────────────────────────────────────────
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
