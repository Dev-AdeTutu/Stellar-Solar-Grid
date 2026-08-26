# API Versioning Strategy

Closes #679.

## Scheme

URL-based major versioning:

```
GET  /api/v1/meters/:id/balance
POST /api/v1/payments
```

`/api/*` (unversioned) remains an alias for the **latest** stable version —
currently `v1` — so existing clients and deployments keep working without
changes:

```
GET  /api/meters/:id/balance   →  same handler as /api/v1/meters/:id/balance
POST /api/payments              →  same handler as /api/v1/payments
```

## Rules

- A new version is only introduced for **breaking** changes (removed/renamed
  fields, changed status codes, changed auth). Additive, backwards-compatible
  changes (new optional fields, new endpoints) ship into the current version.
- Each version is mounted as its own Express router (see `backend/src/index.ts`)
  so old and new handlers can run side by side during a migration window.
- `/api/*` always points at the latest version. When `v2` ships, `/api/*` is
  repointed to `v2` and `/api/v1/*` keeps serving its existing handlers.
- A deprecated version stays available for a **minimum of 6 months** after its
  successor ships, and responds with a `Sunset` header (RFC 8594) naming the
  date it will be removed.
- The OpenAPI spec (when added) documents every supported version separately.

## Alternative: `Accept-Version` header

Clients that prefer header-based negotiation may send:

```
Accept-Version: v1
```

The server currently has only one version, so this header is a no-op today.
It is reserved for when `v2` ships, at which point it will route to the same
handlers as the equivalent `/api/v{n}/*` path.
