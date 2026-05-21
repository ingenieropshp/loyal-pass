/* =====================================================
   BISTRO CONNECT — Service Worker v1.0
   Estrategia: Cache-First para assets, Network-First para API
   ===================================================== */

const CACHE_NAME   = 'bistro-connect-v1';
const STATIC_ASSETS = [
  '/',
  '/index.html',
];

// ─── Instalación: cachear assets estáticos ────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// ─── Activación: limpiar caches viejos ───────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// ─── Fetch: Network-First para Supabase, Cache-First para el resto ────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // No interceptar peticiones a Supabase (siempre red)
  if (url.hostname.includes('supabase.co')) return;

  // No interceptar extensiones de navegador
  if (url.protocol === 'chrome-extension:') return;

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        // Cachear solo respuestas válidas de nuestro mismo origen
        if (
          response.ok &&
          response.type === 'basic' &&
          request.method === 'GET'
        ) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return response;
      });
    }).catch(() => {
      // Fallback offline para navegación
      if (request.mode === 'navigate') {
        return caches.match('/index.html');
      }
    })
  );
});

// ─── Push Notifications ───────────────────────────────────────────────────────
self.addEventListener('push', (event) => {
  if (!event.data) return;

  let data = {};
  try { data = event.data.json(); }
  catch { data = { title: 'Bistro Connect', body: event.data.text() }; }

  const options = {
    body:    data.body    || '¡Tienes una notificación de tu restaurante favorito!',
    icon:    data.icon    || '/icon-192.png',
    badge:   data.badge   || '/icon-72.png',
    data:    data.url     || '/',
    actions: [
      { action: 'open',    title: 'Abrir' },
      { action: 'dismiss', title: 'Cerrar' },
    ],
    vibrate: [100, 50, 100],
  };

  event.waitUntil(
    self.registration.showNotification(data.title || 'Bistro Connect', options)
  );
});

// ─── Click en notificación ────────────────────────────────────────────────────
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  if (event.action === 'dismiss') return;

  const targetUrl = event.notification.data || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      const existing = clientList.find((c) => c.url === targetUrl && 'focus' in c);
      if (existing) return existing.focus();
      return clients.openWindow(targetUrl);
    })
  );
});
