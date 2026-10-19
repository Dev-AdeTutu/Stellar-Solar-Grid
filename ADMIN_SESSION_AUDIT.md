# Admin Login — Session Handling Audit (#549)

## Storage mechanism (confirmed)

The admin credential is **not** stored in `localStorage` and is **not** a
cookie. It's a JWT stored in `sessionStorage`:

- `frontend/src/app/admin/login/page.tsx` — on successful `POST
  /api/admin/login`, the returned `token` is written to
  `sessionStorage.setItem("admin_token", ...)`.
- `frontend/src/services/allowlistService.ts` — reads it back out of
  `sessionStorage` and attaches it as `Authorization: Bearer <token>` on
  subsequent admin API calls.
- `frontend/src/app/admin/page.tsx` — gates the admin page client-side on
  the presence of that same `sessionStorage` key.

`sessionStorage` is scoped to a single tab and cleared when the tab closes
(no persistence across browser restarts, no sharing across tabs) — narrower
blast radius than `localStorage`, though both are equally readable by any
script running on the page.

## CSRF applicability: not applicable

CSRF exploits *ambient* credentials the browser attaches automatically
(cookies). Here, the admin token lives in `sessionStorage` and is only sent
because frontend JS explicitly reads it and sets an `Authorization` header —
a cross-site page cannot make the victim's browser attach it. **No CSRF
protection is warranted as long as the credential stays out of a cookie.**
Moving to an httpOnly cookie, as the issue's proposed solution suggests as
one option, would *introduce* CSRF exposure that doesn't exist today in
exchange for XSS-read protection the app doesn't otherwise need (see below).
Recommendation: keep the bearer-token-in-sessionStorage approach; do not
move to a cookie.

## XSS exposure: present, inherent to any JS-readable storage

If an attacker achieves script injection, `sessionStorage` is readable by
that script just like `localStorage` — this risk isn't eliminated by the
current choice, only bounded (per-tab, session-lived, 8h JWT expiry so a
stolen token has a capped lifetime). The app already sets a restrictive CSP
(`default-src 'none'`, `script-src 'self'`) in `backend/src/index.ts`, which
is the actual first line of defense against the script injection this would
require.

## Bugs found while confirming the actual implementation

The audit surfaced that the login flow was non-functional, independent of
the CSRF question:

1. `adminLoginRouter` (`backend/src/routes/adminLogin.ts`) was never mounted
   on the Express app — `POST /api/admin/login` 404'd. **Fixed**: mounted at
   `/api/admin/login` in `backend/src/index.ts` (behind `writeLimiter` to
   bound brute-force attempts against the admin secret).
2. The login route validated the submitted secret against `ADMIN_SECRET`, an
   env var that doesn't exist anywhere else in the codebase or
   `.env.example` — it could never have been configured correctly.
   **Fixed**: validates against `ADMIN_API_KEY`, the same var already used
   by the rest of the admin-gating middleware.
3. The JWT issued at login was never verified by anything. The middleware
   guarding admin routes (`requireAdminKey`, used by allowlist/collaborators
   /provider/meters) only checked a static `X-Admin-Key` header against
   `ADMIN_API_KEY` — it never looked at the `Authorization: Bearer <JWT>`
   header the frontend actually sends after login. In practice, logging in
   via the UI produced a token that every subsequent admin request would
   reject as `401 Unauthorized`. **Fixed**: `requireAdminKey` now also
   accepts a valid `Authorization: Bearer <JWT>` signed with the same secret
   and carrying `role: "admin"`, in addition to the existing direct
   `X-Admin-Key` path (kept for server-to-server callers).

## Conclusion

- Storage: `sessionStorage`, not `localStorage` — already the more
  conservative choice.
- Session transport: `Authorization` header, not a cookie — CSRF protection
  is not applicable and should not be added unless the transport changes to
  a cookie.
- Mitigated: the login flow is now actually wired up and its issued session
  token is the credential enforced by admin routes.
