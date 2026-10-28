/* ==========================================================================
   Service Worker for Offline AI Assistant
   Handles full offline caching of app shell, CDN scripts, WASM, and model assets
   ========================================================================== */

const CACHE_NAME = 'offline-ai-cache-v1';

// Static files required for the application shell
const APP_SHELL = [
  './',
  './index.html',
  './style.css',
  './script.js',
  './sw.js'
];

// URLs of external runtime libraries to pre-cache when online
const EXTERNAL_DEPENDENCIES = [
  'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.3.3',
  'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.3.3/dist/transformers.min.js'
];

// Install Event: Cache App Shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[SW] Caching Application Shell...');
      return cache.addAll(APP_SHELL).catch((err) => {
        console.warn('[SW] Non-critical cache error on install:', err);
      });
    }).then(() => {
      return self.skipWaiting();
    })
  );
});

// Activate Event: Clean old caches and claim clients immediately
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME && !key.startsWith('transformers-cache')) {
            console.log('[SW] Removing deprecated cache:', key);
            return caches.delete(key);
          }
        })
      );
    }).then(() => {
      return self.clients.claim();
    })
  );
});

// Fetch Event: Cache-First for static assets and models with Network Fallback & Dynamic Cache
self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // Skip non-GET requests
  if (request.method !== 'GET') {
    return;
  }

  // Handle Chrome extension schemes or non-HTTP(S)
  if (!url.protocol.startsWith('http')) {
    return;
  }

  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      if (cachedResponse) {
        // Return from cache immediately (Offline hit!)
        return cachedResponse;
      }

      // Check transformers-cache if available
      return caches.open('transformers-cache').then((modelCache) => {
        return modelCache.match(request).then((modelMatch) => {
          if (modelMatch) {
            return modelMatch;
          }

          // If not in cache, fetch from network and dynamically cache
          return fetch(request).then((networkResponse) => {
            // Only cache valid or opaque responses
            if (networkResponse && (networkResponse.status === 200 || networkResponse.type === 'opaque')) {
              const responseToCache = networkResponse.clone();
              
              // Decide which cache to store it in
              const targetCacheName = (url.hostname.includes('huggingface.co'))
                ? 'transformers-cache'
                : CACHE_NAME;

              caches.open(targetCacheName).then((cache) => {
                cache.put(request, responseToCache).catch((err) => {
                  console.warn('[SW] Could not dynamically cache request:', url.href, err);
                });
              });
            }
            return networkResponse;
          }).catch((fetchError) => {
            console.warn('[SW] Fetch failed for', url.href, 'Operating Offline.');
            
            // If requesting HTML page offline, return cached root/index.html
            if (request.mode === 'navigate') {
              return caches.match('./index.html');
            }

            // Return custom offline error JSON or error response
            return new Response(
              JSON.stringify({
                error: 'Offline mode: Resource not found in local cache.',
                url: url.href
              }),
              {
                status: 503,
                statusText: 'Service Unavailable (Offline)',
                headers: { 'Content-Type': 'application/json' }
              }
            );
          });
        });
      });
    })
  );
});

// Message listener for explicit pre-caching from main script
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'PRECACHE_RESOURCES') {
    const urls = event.data.urls || [];
    caches.open(CACHE_NAME).then((cache) => {
      return Promise.all(
        urls.map((url) => {
          return fetch(url, { mode: 'cors' })
            .then((res) => cache.put(url, res))
            .catch((err) => console.warn('[SW] Failed to precache:', url, err));
        })
      );
    }).then(() => {
      event.ports[0]?.postMessage({ status: 'done' });
    });
  }
});

