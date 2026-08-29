---
name: Feature Request
about: Propose a new feature or improvement
title: "[Feature] Make CORS origins configurable via environment variable"
labels: enhancement
assignees: ''
---

## Problem Statement

CORS configuration is hardcoded in the backend. When deploying to different environments (staging, production, custom domains), developers must modify code to update allowed origins.

## Proposed Solution

Replace hardcoded CORS origins with environment variable:

```bash
# .env
CORS_ORIGINS=https://app.solargrid.io,https://staging.solargrid.io,http://localhost:3000
```

Parse comma-separated list in backend:

```typescript
const allowedOrigins = process.env.CORS_ORIGINS?.split(',') || ['http://localhost:3000'];
```

Apply to CORS middleware with origin validation function.

## Alternatives Considered

- Wildcard (*) CORS: Security risk, not recommended
- Config file (JSON/YAML): More complex than env var

## Affected Component(s)

- [ ] Frontend (React / TypeScript)
- [x] Backend / IoT bridge (Node.js)
- [ ] Smart contracts (Soroban / Rust)
- [x] Documentation
- [ ] Other

## Additional Context

Should validate origin format (must start with http:// or https://) and reject malformed entries at startup.
