---
name: Feature Request
about: Propose a new feature or improvement
title: "[Feature] Add offline mode with service worker caching"
labels: enhancement
assignees: ''
---

## Problem Statement

Users in areas with intermittent internet connectivity cannot access the dashboard when offline. They need to view cached data (last known balance, recent payments) even without network connection.

## Proposed Solution

Implement progressive web app (PWA) capabilities:
- Service worker for offline caching
- Cache-first strategy for static assets (CSS, JS, images)
- Network-first with cache fallback for API data
- Show "Offline Mode" banner with last sync timestamp
- Queue payment transactions for submission when back online
- Persist queued actions in IndexedDB

Next.js 14 has built-in PWA support via `next-pwa` plugin.

## Alternatives Considered

- Full offline functionality: Too complex for blockchain app
- No offline support: Poor UX for target markets

## Affected Component(s)

- [x] Frontend (React / TypeScript)
- [ ] Backend / IoT bridge (Node.js)
- [ ] Smart contracts (Soroban / Rust)
- [x] Documentation
- [ ] Other

## Additional Context

Requires `manifest.json` for "Add to Home Screen" functionality on mobile devices.
