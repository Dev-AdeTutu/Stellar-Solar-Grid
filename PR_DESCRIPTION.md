## Summary
This PR delivers two user-facing improvements:

1. Proactive low-balance browser push notifications for meter owners.
2. A pagination reliability fix for payment history (including Safari behavior where paging could stop responding after deep scroll).

## Problem
Users only discovered low balances after manually checking dashboards, causing avoidable service interruptions. In addition, payment history pagination could become non-functional after scrolling in Safari, with no API request fired and URL page state not updating consistently.

## What Changed
### Frontend
- Added Web Push client setup service:
  - Requests notification permission on first dashboard visit.
  - Registers service worker and subscribes browser via PushManager.
  - Persists subscription endpoint in localStorage to avoid duplicate registration calls.
- Added service worker to:
  - Render push notifications.
  - Handle notification click/action and route users to top-up flow.
- Added push notification icons.
- Updated User Dashboard polling flow to trigger subscription registration once low-balance condition is observed.
- Fixed payment history pagination flow:
  - Uses URL page param as the source of truth.
  - Uses explicit page-change handler for next/prev.
  - Scrolls to top of history section on page change.
  - Prevents stale disabled-state behavior on pagination buttons.
- Fixed a pre-existing production build failure:
  - `/history` and `/dashboard/provider` used `useSearchParams()` without a `Suspense` boundary, which made `next build` fail with a prerender/export error (unrelated to this PR's business logic, but blocking any build that touches these routes). Wrapped both pages' bodies in `Suspense` so the build succeeds again.

### Backend
- Added push subscription persistence layer (SQLite-backed table):
  - Upsert subscriptions by endpoint.
  - Delete stale/unsubscribed endpoints.
- Added Web Push delivery module using VAPID configuration.
- Added new push API endpoints:
  - `GET /api/push/config`
  - `POST /api/push/subscribe`
  - `POST /api/push/unsubscribe`
- Integrated low-balance push send in IoT bridge low-balance pipeline.
- Upgraded low-balance threshold logic to requested rule:
  - `threshold = 10% of typical weekly usage (last 7 days)`
  - Falls back to `LOW_BALANCE_THRESHOLD` when insufficient history exists.
- Exposed low-balance metadata in meter balance responses for frontend gating.

### Docs / Config
- Updated backend API docs to include push endpoints and dynamic threshold behavior.
- Added required/optional Web Push env vars to backend `.env.example`.
- Added frontend backend URL env example for push API usage.

## Files of Interest
- Frontend:
  - `src/app/history/page.tsx`
  - `src/app/dashboard/user/page.tsx`
  - `src/services/pushService.ts`
  - `public/sw.js`
  - `public/icons/push-warning.svg`
  - `public/icons/push-badge.svg`
- Backend:
  - `../backend/src/routes/pushSubscriptions.ts`
  - `../backend/src/lib/pushNotifications.ts`
  - `../backend/src/lib/pushSubscriptions.ts`
  - `../backend/src/iot/bridge.ts`
  - `../backend/src/lib/usageEvents.ts`
  - `../backend/src/routes/meters.ts`
  - `../backend/src/index.ts`

## Testing / Validation
- Backend TypeScript build passes: `cd backend && npm run build`.
- Backend dependencies verified installed and loadable (`web-push`).
- Frontend type check passes for all application source (`cd frontend && npx tsc --noEmit`, excluding pre-existing test-file type errors from missing Jest type defs, unrelated to this change).
- Frontend production build passes end-to-end (`cd frontend && npm run build`, exit code 0) after the Suspense fix.
- `frontend/npm test` run: pre-existing failures in `OfflinePaymentModal.test.tsx` and `AllowlistPanel.test.tsx` (missing unrelated modules `@/hooks/useOffline`, `@/services/allowlistService`) are unaffected by this change; all other suites pass (19/19 tests).

## Operational Notes
- To enable push notifications in deployed environments, set:
  - `WEB_PUSH_VAPID_SUBJECT`
  - `WEB_PUSH_VAPID_PUBLIC_KEY`
  - `WEB_PUSH_VAPID_PRIVATE_KEY`
- Without these vars, push endpoints remain available but sending is effectively disabled (safe no-op behavior with warning logs).

## Risk Assessment
- Low-to-medium risk due to new notification pipeline and persistence table.
- Mitigations:
  - Invalid/stale subscriptions are removed on 404/410 push responses.
  - Existing webhook path remains intact.
  - Fallback threshold preserves behavior when history data is unavailable.

## Follow-ups
- Add targeted unit/integration tests for:
  - Push subscription route validation.
  - Threshold computation edge cases.
  - Safari regression on pagination URL/button state.
