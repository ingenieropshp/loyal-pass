/* =====================================================
   BISTRO CONNECT — Service Worker v3.0
   - Recibe ubicación del cliente vía postMessage
   - Verifica geofence internamente (sin Edge Function)
   - Muestra notificación en segundo plano
   - Periodic Background Sync para app cerrada (Chrome Android)
   -----------------------------------------------------
   NOTA (LoyalPass v5.0): este archivo NO se modificó. Con
   useGeofencing.js v5, este SW solo se registra/usa cuando
   Capacitor.isNativePlatform() === false, es decir, cuando la
   PWA corre en un navegador web tradicional. En Android/iOS
   nativos (WebView de Capacitor) el geofencing en 2do plano lo
   maneja @capacitor-community/background-geolocation y las
   notificaciones las dispara @capacitor/local-notifications
   directamente desde useGeofencing.js — este SW nunca entra en
   juego en esos casos.
   ===================================================== */

const CACHE_NAME = 'bistro-connect-v3';
const STATIC_ASSETS = ['/', '/index.html'];

// ── Almacén en memoria del SW (persiste mientras el SW está vivo) ─────────────
let restaurantesCacheados = [];   // recibidos desde la página
let estadoRango = {};             // { [restaurante_id]: true/false } estado ANTERIOR

// ── Haversine ─────────────────────────────────────────────────────────────────
function distanciaM(lat1, lon1, lat2, lon2) {
  const R    = 6_371_000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
    Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Mostrar notificación ──────────────────────────────────────────────────────
async function mostrarNotifGeofence(resto) {
  const puntosLlegada = resto.puntos_llegada ?? 2;
  const urlApp        = resto.urlApp || '/';

  await self.registration.showNotification(`📍 Estás cerca de ${resto.nombre}`, {
    body:     resto.mensaje_geofence?.trim()
              || resto.mensaje_promo?.trim()
              || `Confirma tu llegada y gana +${puntosLlegada} puntos`,
    icon:     '/icons/icon-192.png',
    badge:    '/icons/badge-72.png',
    tag:      `bistro-cerca-${resto.restaurante_id}`,
    renotify: true,   // true = reemplaza la anterior si ya existe
    vibrate:  [200, 100, 200],
    data: { url: urlApp, restauranteId: resto.restaurante_id },
    actions: [
      { action: 'confirmar', title: `Confirmar llegada (+${puntosLlegada} pts) ✅` },
      { action: 'dismiss',   title: 'Ahora no' },
    ],
  });
  console.log(`[SW] 🔔 Notificación enviada: ${resto.nombre}`);
}

// ── Avisar a la página (React) que se detectó una entrada ────────────────────
// El SW es la única fuente de verdad para el borde fuera→dentro (usa
// estadoRango para no repetir). Le avisamos a todas las pestañas/ventanas
// abiertas para que reproduzcan el sonido ping.mp3 en el momento exacto en
// que ESTA notificación se muestra — así el audio queda sincronizado con la
// notificación real y no se duplica el disparo de la detección de borde.
async function notificarClientesEntrada(resto) {
  const clientesAbiertos = await self.clients.matchAll({
    type: 'window',
    includeUncontrolled: true,
  });
  clientesAbiertos.forEach((cliente) => {
    cliente.postMessage({
      type: 'GEOFENCE_ENTERED',
      payload: {
        restaurante_id: resto.restaurante_id,
        nombre:         resto.nombre,
      },
    });
  });
}

// ── Verificar geofence contra una posición ────────────────────────────────────
async function verificarGeofence(uLat, uLon) {
  if (restaurantesCacheados.length === 0) return;

  for (const resto of restaurantesCacheados) {
    const rLat  = parseFloat(resto.latitud);
    const rLon  = parseFloat(resto.longitud);
    const radio = parseInt(resto.radio_aviso) || 200;
    const rId   = resto.restaurante_id;

    if (isNaN(rLat) || isNaN(rLon) || !rId) continue;

    const distM       = distanciaM(uLat, uLon, rLat, rLon);
    const dentroAhora = distM <= radio;
    const estabaAntes = estadoRango[rId] === true;

    // ── Detección de BORDE: solo notificar al ENTRAR (fuera → dentro) ─────────
    // Esto reemplaza el cooldown de 2 horas:
    // - Si el usuario sale y vuelve a entrar → notifica
    // - Si el usuario ya estaba dentro → no repite
    if (dentroAhora && !estabaAntes) {
      console.log(`[SW] 🟢 Entró al rango de ${resto.nombre} (${Math.round(distM)}m)`);
      await mostrarNotifGeofence(resto);
      await notificarClientesEntrada(resto); // → dispara el ping.mp3 en la página
    }

    if (!dentroAhora && estabaAntes) {
      console.log(`[SW] 🔴 Salió del rango de ${resto.nombre}`);
    }

    // Actualizar estado para la próxima comparación
    estadoRango[rId] = dentroAhora;
  }
}

// ── Install ───────────────────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// ── Activate ──────────────────────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ── Fetch: cache-first para assets estáticos ──────────────────────────────────
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.hostname.includes('supabase.co')) return;
  if (url.protocol === 'chrome-extension:') return;
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request.clone()).then((response) => {
        if (response && response.ok && response.status === 200 && response.type === 'basic') {
          const responseToCache = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseToCache));
        }
        return response;
      }).catch(() => {
        if (event.request.mode === 'navigate') return caches.match('/index.html');
      });
    })
  );
});

// ── Mensajes desde la página React ───────────────────────────────────────────
self.addEventListener('message', async (event) => {
  const { type, payload } = event.data || {};

  switch (type) {

    // La página envía los restaurantes al montar GeofencingProvider
    case 'CACHE_RESTAURANTS':
      restaurantesCacheados = payload.restaurantes || [];
      console.log(`[SW] 📦 ${restaurantesCacheados.length} restaurantes cacheados`);
      break;

    // La página envía la posición GPS en cada actualización de watchPosition
    case 'LOCATION_UPDATE':
      await verificarGeofence(payload.lat, payload.lon);
      break;

    // Forzar actualización del SW
    case 'SKIP_WAITING':
      self.skipWaiting();
      break;
  }
});

// ── Push: recibir notificación del servidor (app cerrada) ─────────────────────
self.addEventListener('push', (event) => {
  if (!event.data) return;
  let payload = {};
  try { payload = event.data.json(); }
  catch { payload = { titulo: 'Bistro Connect', cuerpo: event.data.text() }; }

  const options = {
    body:     payload.cuerpo   || '¡Tu restaurante favorito te espera!',
    icon:     payload.icono    || '/icons/icon-192.png',
    badge:                        '/icons/badge-72.png',
    tag:     `bistro-${payload.restauranteId || 'global'}`,
    renotify: true,
    vibrate:  [200, 100, 200],
    data: { url: payload.urlMenu || '/', restauranteId: payload.restauranteId || null },
    actions: [
      { action: 'confirmar', title: `Confirmar llegada (+${payload.puntosLlegada ?? 2} pts) ✅` },
      { action: 'dismiss',   title: 'Ahora no' },
    ],
  };
  event.waitUntil(
    self.registration.showNotification(payload.titulo || 'Bistro Connect', options)
  );
});

// ── Clic en notificación ──────────────────────────────────────────────────────
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

// ── Periodic Background Sync (Chrome Android con PWA instalada) ───────────────
// Se registra desde useGeofencing con tag 'geofence-check'
// Nota: solo funciona con PWA instalada y Chrome en Android
self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'geofence-check') {
    // No podemos pedir GPS directamente desde el SW
    // Pero podemos despertar la app para que ella lo haga
    event.waitUntil(
      self.clients.matchAll({ type: 'window' }).then((clients) => {
        if (clients.length > 0) {
          // App abierta en background: pedirle que envíe su posición
          clients.forEach(c => c.postMessage({ type: 'REQUEST_LOCATION' }));
        }
        // Si no hay clientes abiertos: no hay forma de pedir GPS (limitación web)
      })
    );
  }
});
