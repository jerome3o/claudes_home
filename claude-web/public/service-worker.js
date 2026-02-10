// Claude Agent PWA Service Worker
// Increment CACHE_NAME to bust cache on deployments
const CACHE_NAME = 'claude-v26';

const PRECACHE_URLS = [
  '/',
  '/chat',
  '/styles.css',
  '/app.js',
  '/manifest.json',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  'https://cdn.jsdelivr.net/npm/marked@11.1.1/marked.min.js',
];

// INSTALL: Pre-cache the app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting()) // Activate immediately
  );
});

// ACTIVATE: Clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim()) // Take control immediately
  );
});

// FETCH: Route-based caching strategy
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Skip non-GET requests
  if (event.request.method !== 'GET') return;

  // Skip API requests — always network
  if (url.pathname.startsWith('/api/')) return;

  // Skip VNC proxy — always network
  if (url.pathname.startsWith('/vnc/')) return;

  // Skip WebSocket upgrade requests
  if (event.request.headers.get('upgrade') === 'websocket') return;

  // CDN resources (marked.js): cache-first (version-locked URL)
  if (url.hostname === 'cdn.jsdelivr.net') {
    event.respondWith(
      caches.match(event.request)
        .then((cached) => {
          if (cached) return cached;
          return fetch(event.request).then((response) => {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
            return response;
          });
        })
    );
    return;
  }

  // Static assets (CSS, JS, images, manifest): stale-while-revalidate
  if (url.pathname.match(/\.(css|js|svg|png|json|ico)$/)) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        const fetchPromise = fetch(event.request)
          .then((response) => {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
            return response;
          })
          .catch(() => cached); // Network failure: use cache if available

        return cached || fetchPromise;
      })
    );
    return;
  }

  // Navigation requests (HTML): network-first with cache fallback
  if (event.request.mode === 'navigate' || url.pathname === '/') {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          return response;
        })
        .catch(() => caches.match('/')) // Offline: serve cached shell
    );
    return;
  }
});
