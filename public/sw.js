/* =====================================================
   BISTRO CONNECT — Service Worker v2.1
   Fix: Response body clone race condition corregido
   ===================================================== */

const CACHE_NAME    = 'bistro-connect-v2';
const STATIC_ASSETS = ['/', '/index.html'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Nunca interceptar: Supabase, extensiones, no-GET
  if (url.hostname.includes('supabase.co')) return;
  if (url.protocol === 'chrome-extension:') return;
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;

      // ── FIX: clonar ANTES de leer, no después ─────────────────────────────
      return fetch(event.request.clone()).then((response) => {
        // Solo cachear respuestas válidas del mismo origen
        if (
          response &&
          response.ok &&
          response.status === 200 &&
          response.type === 'basic'
        ) {
          // Clonar INMEDIATAMENTE antes de cualquier otra operación
          const responseToCache = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return response;
      }).catch(() => {
        if (event.request.mode === 'navigate') {
          return caches.match('/index.html');
        }
      });
    })
  );
});

// ── Push: funciona aunque la app esté CERRADA ─────────────────────────────────
self.addEventListener('push', (event) => {
  if (!event.data) return;

  let payload = {};
  try { payload = event.data.json(); }
  catch { payload = { titulo: 'Bistro Connect', cuerpo: event.data.text() }; }

  const options = {
    body:    payload.cuerpo   || '¡Tu restaurante favorito te espera!',
    icon:    payload.icono    || '/icons/icon-192.png',
    badge:                       '/icons/icon-72.png',
    tag:    `bistro-${payload.restauranteId || 'global'}`,
    renotify: false,
    vibrate: [200, 100, 200],
    data: {
      url:           payload.urlMenu       || '/',
      restauranteId: payload.restauranteId || null,
    },
    actions: [
      { action: 'ver-menu', title: `Ver Menú ☕ (+${payload.puntosLlegada ?? 2} pts)` },
      { action: 'dismiss',  title: 'Ahora no' },
    ],
  };

  event.waitUntil(
    self.registration.showNotification(payload.titulo || 'Bistro Connect', options)
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  if (event.action === 'dismiss') return;

  const destino = event.notification.data?.url || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) {
          client.postMessage({ type: 'GEOFENCE_CLICK', url: destino });
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(destino);
    })
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
