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
self.addEventListener("install", () => {
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
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  if (!event.data) return;

  let payload = {};
  try {
    payload = event.data.json();
  } catch {
    return;
  }

  const title = payload.title || "Stellar SolarGrid";
  const options = {
    body: payload.body,
    icon: payload.icon || "/icons/push-warning.svg",
    badge: payload.badge || "/icons/push-badge.svg",
    tag: payload.tag || "solargrid-alert",
    data: payload.data || {},
    actions: payload.actions || [],
    renotify: true,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  const action = event.action;
  const topUpPath = event.notification?.data?.topUpPath || "/pay";
  event.notification.close();

  if (action === "top-up" || !action) {
    event.waitUntil(
      self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
        const matchingClient = clients.find((client) => client.url.includes(topUpPath));
        if (matchingClient) {
          matchingClient.focus();
          return matchingClient.navigate(topUpPath);
        }
        return self.clients.openWindow(topUpPath);
      }),
    );
  }
});
