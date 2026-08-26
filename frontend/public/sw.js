// SolarGrid service worker — offline support (see docs/OFFLINE_MODE.md).
//
// - Cache-first for static build assets (JS/CSS/images/fonts): fast, and
//   they're content-hashed so a stale cache is never wrong.
// - Network-first with cache fallback for pages and API GET requests: always
//   prefer fresh data, but fall back to the last known-good response when
//   offline so the dashboard still shows the last known balance/history.
// - Non-GET requests (e.g. payment submission) are never cached and are left
//   to the page itself to queue (see src/lib/offlineQueue.ts) — a mutating
//   request can't be safely "replayed" from a generic cache layer.

const VERSION = "v1";
const STATIC_CACHE = `solargrid-static-${VERSION}`;
const API_CACHE = `solargrid-api-${VERSION}`;

const STATIC_ASSET_RE = /\.(?:js|css|png|jpg|jpeg|svg|webp|gif|ico|woff2?|ttf)$/;

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name !== STATIC_CACHE && name !== API_CACHE)
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(STATIC_CACHE);
    cache.put(request, response.clone());
  }
  return response;
}

async function networkFirst(request, cacheName) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await caches.match(request);
    if (cached) return cached;
    throw err;
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Only intercept GET — mutating requests are queued/retried by the page.
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  if (url.origin === self.location.origin && STATIC_ASSET_RE.test(url.pathname)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request, STATIC_CACHE));
    return;
  }

  // Matches API GET requests whether the backend is same-origin or a
  // separately-hosted service (NEXT_PUBLIC_BACKEND_URL points elsewhere).
  if (url.pathname.includes("/api/")) {
    event.respondWith(networkFirst(request, API_CACHE));
  }
});
