---
name: Feature Request
about: Propose a new feature or improvement
title: "[Feature] Implement API versioning strategy"
labels: enhancement
assignees: ''
---

## Problem Statement

As the API evolves, breaking changes to endpoints will break existing frontend deployments and third-party integrations. There's currently no versioning strategy.

## Proposed Solution

Implement URL-based API versioning:

**Current endpoints:**
```
GET /api/meters/:id/balance
POST /api/payments
```

**Versioned endpoints:**
```
GET /api/v1/meters/:id/balance
POST /api/v1/payments
```

Strategy:
- Keep `/api/*` as alias to latest version (v1 initially)
- Add `Accept-Version` header support as alternative
- Document deprecation timeline (minimum 6 months)
- Return `Sunset` header on deprecated versions
- Version includes major breaking changes only

## Alternatives Considered

- Header-based versioning: Less visible in logs/debugging
- No versioning: Breaks client apps on updates

## Affected Component(s)

- [x] Frontend (React / TypeScript)
- [x] Backend / IoT bridge (Node.js)
- [ ] Smart contracts (Soroban / Rust)
- [x] Documentation
- [ ] Other

## Additional Context

OpenAPI spec should document all versions. Consider automated version detection in client SDK.
