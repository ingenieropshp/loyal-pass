/* =====================================================
   BISTRO CONNECT — Service Worker v2.0
   Funciona en SEGUNDO PLANO, incluso con la app cerrada.
   ===================================================== */

const CACHE_NAME    = 'bistro-connect-v2';
const STATIC_ASSETS = ['/', '/index.html', '/manifest.json'];

// ── Instalación ───────────────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting(); // Activa el SW nuevo inmediatamente sin esperar
});

// ── Activación: limpiar caches viejos ────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim(); // Toma control de todas las pestañas abiertas
});

// ── Fetch: Cache-First para assets, red para Supabase ────────────────────────
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.hostname.includes('supabase.co')) return;
  if (url.protocol === 'chrome-extension:') return;
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (response.ok && response.type === 'basic') {
          caches.open(CACHE_NAME).then((cache) =>
            cache.put(event.request, response.clone())
          );
        }
        return response;
      });
    }).catch(() => {
      if (event.request.mode === 'navigate') return caches.match('/index.html');
    })
  );
});

// ── Push: recibir notificación del servidor ───────────────────────────────────
// Este evento se dispara AUNQUE la app esté cerrada
self.addEventListener('push', (event) => {
  if (!event.data) return;

  let payload = {};
  try {
    payload = event.data.json();
  } catch {
    payload = { titulo: 'Bistro Connect', cuerpo: event.data.text() };
  }

  /* Estructura del payload que envía la Edge Function check-geofence:
   * {
   *   restauranteId:     string,
   *   restauranteNombre: string,
   *   titulo:            string,  ej: "¡Estás cerca de 101 Bistro!"
   *   cuerpo:            string,  ej: "Confirma tu llegada y gana +7 puntos"
   *   urlMenu:           string,  ej: "https://bistro-app.pages.dev/?r=uuid"
   *   icono:             string,
   *   puntosLlegada:     number,
   * }
   */
  const options = {
    body:    payload.cuerpo   || '¡Tu restaurante favorito te espera!',
    icon:    payload.icono    || '/icons/icon-192.png',
    badge:                       '/icons/badge-72.png',
    tag:     `bistro-${payload.restauranteId || 'global'}`, // evita duplicados
    renotify: false,
    vibrate: [200, 100, 200],
    data: {
      url:           payload.urlMenu        || '/',
      restauranteId: payload.restauranteId  || null,
    },
    actions: [
      {
        action: 'ver-menu',
        title:  `Ver Menú ☕ (+${payload.puntosLlegada ?? 2} pts)`,
      },
      {
        action: 'dismiss',
        title:  'Ahora no',
      },
    ],
  };

  event.waitUntil(
    self.registration.showNotification(
      payload.titulo || 'Bistro Connect',
      options
    )
  );
});

// ── Clic en notificación ──────────────────────────────────────────────────────
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  if (event.action === 'dismiss') return;

  const destino = event.notification.data?.url || '/';

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        // Si la app ya está abierta, enfocarla y navegar
        for (const client of clientList) {
          if ('focus' in client) {
            client.postMessage({
              type:          'GEOFENCE_CLICK',
              restauranteId: event.notification.data?.restauranteId,
              url:           destino,
            });
            return client.focus();
          }
        }
        // Si la app está cerrada, abrirla
        if (self.clients.openWindow) return self.clients.openWindow(destino);
      })
  );
});

// ── Mensajes desde el cliente React ──────────────────────────────────────────
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
