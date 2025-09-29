/* global self, caches, fetch */
// -----------------------------------------------------------------------------
// Spin – Enhanced Service Worker (rev-2025-09-bg)
// -----------------------------------------------------------------------------
const VER          = 'v3'; // Bump version for background features
const CACHE_STATIC = `mfb-static-${VER}`;
const CACHE_RUNTIME = `mfb-runtime-${VER}`;
const BG_SYNC_TAG = 'mfb-background-sync';

// Everything we want available offline on first install
const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/css/style.css',
  '/js/app.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.js'
];

// Background sync queue for emergency alerts
let backgroundQueue = [];

// -----------------------------------------------------------------------------
// Install – fill static cache
// -----------------------------------------------------------------------------
self.addEventListener('install', e => {
  self.skipWaiting(); // take over immediately for first-time users
  e.waitUntil(
    caches.open(CACHE_STATIC)
          .then(cache => cache.addAll(PRECACHE_ASSETS))
          .then(() => {
            console.log('MotoFindBack Service Worker installed');
          })
  );
});

// -----------------------------------------------------------------------------
// Activate – delete outdated caches and set up background sync
// -----------------------------------------------------------------------------
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
          .then(names => Promise.all(
            names.map(n => (n !== CACHE_STATIC && n !== CACHE_RUNTIME) && caches.delete(n))
          ))
          .then(() => self.clients.claim())
          .then(() => {
            console.log('MotoFindBack Service Worker activated with background features');
            // Register background sync
            if ('sync' in self.registration) {
              self.registration.sync.register(BG_SYNC_TAG)
                .then(() => console.log('Background sync registered'))
                .catch(err => console.log('Background sync registration failed:', err));
            }
          })
  );
});

// -----------------------------------------------------------------------------
// Background Sync for emergency alerts and data sync
// -----------------------------------------------------------------------------
self.addEventListener('sync', e => {
  if (e.tag === BG_SYNC_TAG) {
    console.log('Background sync triggered');
    e.waitUntil(
      processBackgroundQueue()
        .then(() => {
          console.log('Background queue processed successfully');
          // Notify all clients
          return self.clients.matchAll().then(clients => {
            clients.forEach(client => {
              client.postMessage({
                type: 'BACKGROUND_SYNC_COMPLETE',
                timestamp: Date.now()
              });
            });
          });
        })
        .catch(err => {
          console.error('Background sync failed:', err);
        })
    );
  }
});

// -----------------------------------------------------------------------------
// Periodic Background Sync (if supported)
// -----------------------------------------------------------------------------
self.addEventListener('periodicsync', e => {
  if (e.tag === 'mfb-periodic-sync') {
    e.waitUntil(
      performPeriodicBackgroundWork()
    );
  }
});

// -----------------------------------------------------------------------------
// Fetch – cache-first for same-origin GET, network-first for APIs
// -----------------------------------------------------------------------------
self.addEventListener('fetch', e => {
  const { request } = e;
  const url = new URL(request.url);

  // Handle background data storage
  if (url.pathname.includes('/api/background/') && request.method === 'POST') {
    e.respondWith(handleBackgroundData(request));
    return;
  }

  // Handle emergency alerts
  if (url.pathname.includes('/api/emergency/') && request.method === 'POST') {
    e.respondWith(handleEmergencyAlert(request));
    return;
  }

  // Non-GET or cross-origin (except known CDNs) → network only
  if (request.method !== 'GET') { return; }
  if (!url.origin.includes(self.location.origin) &&
      !url.host.includes('unpkg.com') &&
      !url.host.includes('cdn.jsdelivr.net')) { return; }

  // Runtime assets (tiles, user media, etc.) → network-first + cache fallback
  if (url.pathname.includes('/tile/') || url.pathname.includes('data:image')) {
    e.respondWith(networkFirst(request, CACHE_RUNTIME));
    return;
  }

  // Everything else → cache-first + network fallback
  e.respondWith(cacheFirst(request, CACHE_STATIC));
});

// -----------------------------------------------------------------------------
// Message handling from main app
// -----------------------------------------------------------------------------
self.addEventListener('message', e => {
  const { data } = e;

  switch (data.type) {
    case 'STORE_BACKGROUND_DATA':
      storeBackgroundData(data.payload);
      e.ports[0]?.postMessage({ success: true });
      break;

    case 'QUEUE_EMERGENCY_ALERT':
      queueEmergencyAlert(data.payload);
      e.ports[0]?.postMessage({ success: true });
      break;

    case 'GET_BACKGROUND_DATA':
      getBackgroundData().then(backgroundData => {
        e.ports[0]?.postMessage({ success: true, data: backgroundData });
      });
      break;

    case 'CLEAR_BACKGROUND_DATA':
      clearBackgroundData();
      e.ports[0]?.postMessage({ success: true });
      break;

    case 'TRIGGER_BACKGROUND_SYNC':
      if ('sync' in self.registration) {
        self.registration.sync.register(BG_SYNC_TAG)
          .then(() => console.log('Manual background sync triggered'))
          .catch(err => console.log('Manual sync failed:', err));
      }
      break;
  }
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
          .catch(() => null);
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
      .catch(() => cache.match(req))
    );
}

// -----------------------------------------------------------------------------
// Background data management
// -----------------------------------------------------------------------------
async function storeBackgroundData(data) {
  try {
    const existingData = await getBackgroundData();
    existingData.push({
      ...data,
      storedAt: Date.now(),
      id: generateId()
    });
    
    // Keep only last 200 entries to prevent storage bloat
    if (existingData.length > 200) {
      existingData.splice(0, existingData.length - 200);
    }
    
    const cache = await caches.open(CACHE_RUNTIME);
    const response = new Response(JSON.stringify(existingData));
    await cache.put('/api/background/data', response);
    
    console.log('Background data stored:', data.type);
  } catch (err) {
    console.error('Failed to store background data:', err);
  }
}

async function getBackgroundData() {
  try {
    const cache = await caches.open(CACHE_RUNTIME);
    const response = await cache.match('/api/background/data');
    if (response) {
      return await response.json();
    }
    return [];
  } catch (err) {
    console.error('Failed to get background data:', err);
    return [];
  }
}

async function clearBackgroundData() {
  try {
    const cache = await caches.open(CACHE_RUNTIME);
    await cache.delete('/api/background/data');
    console.log('Background data cleared');
  } catch (err) {
    console.error('Failed to clear background data:', err);
  }
}

// -----------------------------------------------------------------------------
// Emergency alert handling
// -----------------------------------------------------------------------------
async function queueEmergencyAlert(alertData) {
  try {
    const existingQueue = await getEmergencyQueue();
    existingQueue.push({
      ...alertData,
      queuedAt: Date.now(),
      id: generateId(),
      attempts: 0
    });
    
    const cache = await caches.open(CACHE_RUNTIME);
    const response = new Response(JSON.stringify(existingQueue));
    await cache.put('/api/emergency/queue', response);
    
    console.log('Emergency alert queued:', alertData.type);
    
    // Trigger immediate sync if possible
    if ('sync' in self.registration) {
      self.registration.sync.register(BG_SYNC_TAG);
    }
  } catch (err) {
    console.error('Failed to queue emergency alert:', err);
  }
}

async function getEmergencyQueue() {
  try {
    const cache = await caches.open(CACHE_RUNTIME);
    const response = await cache.match('/api/emergency/queue');
    if (response) {
      return await response.json();
    }
    return [];
  } catch (err) {
    console.error('Failed to get emergency queue:', err);
    return [];
  }
}

// -----------------------------------------------------------------------------
// Background sync processing
// -----------------------------------------------------------------------------
async function processBackgroundQueue() {
  const emergencyQueue = await getEmergencyQueue();
  const successfulSends = [];
  
  for (const alert of emergencyQueue) {
    if (alert.attempts >= 3) {
      console.log('Alert max attempts reached, giving up:', alert.id);
      continue;
    }
    
    try {
      // Simulate sending emergency alert
      // In real implementation, this would send SMS or API call
      await simulateEmergencySend(alert);
      successfulSends.push(alert.id);
      console.log('Emergency alert sent successfully:', alert.id);
    } catch (err) {
      console.error('Failed to send emergency alert:', alert.id, err);
      alert.attempts = (alert.attempts || 0) + 1;
    }
  }
  
  // Remove successfully sent alerts
  const updatedQueue = emergencyQueue.filter(alert => 
    !successfulSends.includes(alert.id)
  );
  
  // Update queue
  const cache = await caches.open(CACHE_RUNTIME);
  const response = new Response(JSON.stringify(updatedQueue));
  await cache.put('/api/emergency/queue', response);
  
  return successfulSends.length;
}

async function performPeriodicBackgroundWork() {
  console.log('Performing periodic background work');
  
  // Process any pending background data
  const backgroundData = await getBackgroundData();
  if (backgroundData.length > 0) {
    console.log(`Processing ${backgroundData.length} background data entries`);
    // Here you could upload to server, process analytics, etc.
  }
  
  // Notify clients that periodic work completed
  const clients = await self.clients.matchAll();
  clients.forEach(client => {
    client.postMessage({
      type: 'PERIODIC_SYNC_COMPLETE',
      timestamp: Date.now(),
      processedItems: backgroundData.length
    });
  });
}

// -----------------------------------------------------------------------------
// API handlers
// -----------------------------------------------------------------------------
async function handleBackgroundData(request) {
  try {
    const data = await request.json();
    await storeBackgroundData(data);
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function handleEmergencyAlert(request) {
  try {
    const alertData = await request.json();
    await queueEmergencyAlert(alertData);
    return new Response(JSON.stringify({ success: true, queued: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// -----------------------------------------------------------------------------
// Utility functions
// -----------------------------------------------------------------------------
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

async function simulateEmergencySend(alert) {
  // Simulate network delay
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  // Simulate 90% success rate for testing
  if (Math.random() < 0.1) {
    throw new Error('Simulated network failure');
  }
  
  return { success: true, sentAt: Date.now() };
}
