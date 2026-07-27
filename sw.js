/**
 * Mobile-ETABS Service Worker
 * Strategy:
 *  - App shell (HTML/CSS/JS/icons): cache-first, versioned, precached on install.
 *  - Same-origin GET navigation: network-first with cache fallback (works offline after first load).
 *  - /api/* calls (FastAPI backend): network-first, falling back to last-known-good cached response
 *    for GET requests only. POST (analysis/design runs) is never cached — those require connectivity
 *    and the UI should queue/retry them via IndexedDB (see src/lib/offlineQueue.js, not in this file).
 *  - Local structural models are persisted client-side (IndexedDB/localForage), NOT in this cache —
 *    this worker only caches network responses.
 */

const SW_VERSION = "v1.0.0";
const APP_SHELL_CACHE = `mobile-etabs-shell-${SW_VERSION}`;
const RUNTIME_CACHE = `mobile-etabs-runtime-${SW_VERSION}`;
const API_CACHE = `mobile-etabs-api-${SW_VERSION}`;

// Core assets required for the app to boot fully offline.
// Build tooling (Vite) should inject hashed asset names here at build time;
// this static list covers the minimum PWABuilder expects to find precached.
const APP_SHELL_ASSETS = [
  "/",
  "/index.html",
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/offline.html",
];

const ALL_CACHES = [APP_SHELL_CACHE, RUNTIME_CACHE, API_CACHE];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(APP_SHELL_CACHE)
      .then((cache) => cache.addAll(APP_SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => !ALL_CACHES.includes(key))
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

function isApiRequest(url) {
  return url.pathname.startsWith("/api/");
}

function isNavigationRequest(request) {
  return request.mode === "navigate";
}

// Network-first, cache fallback — used for HTML navigations and API GETs.
async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const networkResponse = await fetch(request);
    if (networkResponse && networkResponse.status === 200) {
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    if (isNavigationRequest(request)) {
      const offlineShell = await caches.match("/offline.html");
      if (offlineShell) return offlineShell;
    }
    throw err;
  }
}

// Cache-first, network fallback — used for static/versioned assets.
async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const networkResponse = await fetch(request);
  if (networkResponse && networkResponse.status === 200) {
    cache.put(request, networkResponse.clone());
  }
  return networkResponse;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return; // POST /api/analyze etc. bypass the SW entirely
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (isApiRequest(url)) {
    event.respondWith(networkFirst(request, API_CACHE));
    return;
  }

  if (isNavigationRequest(request)) {
    event.respondWith(networkFirst(request, APP_SHELL_CACHE));
    return;
  }

  // Static assets: JS/CSS/fonts/images
  event.respondWith(cacheFirst(request, RUNTIME_CACHE));
});

// Allows the app to trigger an update prompt ("New version available")
self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") {
    self.skipWaiting();
  }
});
