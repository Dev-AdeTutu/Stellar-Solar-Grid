# Offline Mode (PWA)

Closes #677.

The frontend registers a service worker (`frontend/public/sw.js`) that gives
the dashboard basic offline support without pulling in `next-pwa`:

- **Cache-first** for hashed static build assets (JS/CSS/images/fonts) — safe
  because their filenames change whenever content changes.
- **Network-first with cache fallback** for page navigations and `GET /api/*`
  calls — always shows fresh data when online, and falls back to the last
  successful response (e.g. last known meter balance, recent payments) when
  the network is unavailable.
- Mutating requests (`POST`/`PUT`/...) are **never** cached or replayed by
  the service worker itself — see queueing below.

## Offline banner

`src/components/OfflineBanner.tsx` listens for the browser's `online`/`offline`
events and shows a fixed "Offline Mode" banner with the last time the app was
online (persisted in `localStorage`).

## Add to Home Screen

`frontend/public/manifest.json` + `frontend/public/icon.svg` provide the PWA
manifest needed for "Add to Home Screen" on mobile; linked from the root
`<head>` via `metadata.manifest` in `src/app/layout.tsx`.

## Queued actions

`src/lib/offlineQueue.ts` persists a mutating request in IndexedDB
(`enqueueAction`) when a fetch fails while offline, and replays the queue
(`flushQueuedActions`) when the browser reports `online` again
(`src/components/ServiceWorkerRegister.tsx`). This is generic infrastructure
ready to wrap any mutating call (e.g. a future payment-submission endpoint);
note that Stellar transactions signed live against the wallet extension still
require network access to submit, so queueing applies to backend-side
mutations rather than the on-chain signing step itself.
