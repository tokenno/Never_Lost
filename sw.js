/* global self, caches, fetch */
// -----------------------------------------------------------------------------
// Spin – Service Worker  (rev-2025-09)
// -----------------------------------------------------------------------------
const VER          = 'v2';                       // bump to invalidate old caches
const CACHE_STATIC = `mfb-static-${VER}`;
const CACHE_RUNTIME= `mfb-runtime-${VER}`;

// Everything we want available offline on first install
const PRECACHE_ASSETS = [
  '/',                       // index.html (same as '/')
  '/manifest.json',          // PWA manifest
  '/css/style.css',          // your own CSS
  '/js/app.js',              // your own JS (minified or not)
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.js'
];

// -----------------------------------------------------------------------------
// Install – fill static cache
// -----------------------------------------------------------------------------
self.addEventListener('install', e => {
  self.skipWaiting(); // take over immediately for first-time users
  e.waitUntil(
    caches.open(CACHE_STATIC)
          .then(cache => cache.addAll(PRECACHE_ASSETS))
  );
});

// -----------------------------------------------------------------------------
// Activate – delete outdated caches
// -----------------------------------------------------------------------------
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
          .then(names => Promise.all(
            names.map(n => (n !== CACHE_STATIC && n !== CACHE_RUNTIME) && caches.delete(n))
          ))
          .then(() => self.clients.claim()) // control pages straight away
  );
});

// -----------------------------------------------------------------------------
// Fetch – cache-first for same-origin GET, network-first for APIs, generic fallback
// -----------------------------------------------------------------------------
self.addEventListener('fetch', e => {
  const { request } = e;
  const url = new URL(request.url);

  // 1. Non-GET or cross-origin (except known CDNs) → network only
  if (request.method !== 'GET') { return; }
  if (!url.origin.includes(self.location.origin) &&
      !url.host.includes('unpkg.com') &&
      !url.host.includes('cdn.jsdelivr.net')) { return; }

  // 2. Runtime assets (tiles, user media, etc.) → network-first + cache fallback
  if (url.pathname.includes('/tile/') || url.pathname.includes('data:image')) {
    e.respondWith(networkFirst(request, CACHE_RUNTIME));
    return;
  }

  // 3. Everything else → cache-first + network fallback (and update cache)
  e.respondWith(cacheFirst(request, CACHE_STATIC));
});

// -----------------------------------------------------------------------------
// Strategy helpers
// -----------------------------------------------------------------------------
function cacheFirst(req, cacheName) {
  return caches.open(cacheName)
    .then(cache => cache.match(req)
      .then(res => {
        const fetchPromise = fetch(req)
          .then(netRes => {
            if (netRes.ok) cache.put(req, netRes.clone());
            return netRes;
          })
          .catch(() => null); // swallow network errors here; will fall back to res
        return res || fetchPromise;
      })
    );
}

function networkFirst(req, cacheName) {
  return caches.open(cacheName)
    .then(cache => fetch(req)
      .then(netRes => {
        if (netRes.ok) cache.put(req, netRes.clone());
        return netRes;
      })
      .catch(() => cache.match(req)) // offline → try cache
    );
}
