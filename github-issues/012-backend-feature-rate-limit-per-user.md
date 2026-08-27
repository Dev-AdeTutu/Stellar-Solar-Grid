---
name: Feature Request
about: Propose a new feature or improvement
title: "[Feature] Implement per-user rate limiting"
labels: enhancement
assignees: ''
---

## Problem Statement

Current rate limiting in `rateLimits.ts` is IP-based. In environments with shared IPs (corporate networks, mobile carriers), legitimate users get blocked when one user exceeds limits. Authenticated requests should be rate-limited by user ID instead.

## Proposed Solution

Implement dual-mode rate limiting:
- **Anonymous endpoints**: IP-based (current behavior)
- **Authenticated endpoints** (payment, meter management): Rate limit by `payer` address from request body

Use separate limiters with different thresholds:
- IP-based: 100 req/15min (general protection)
- User-based: 50 payments/hour (prevent abuse)

Store rate limit state in Redis (for multi-instance deployments) or in-memory Map (single instance).

## Alternatives Considered

- JWT-based authentication: More complex, not needed for current stateless API
- Blockchain-based proof of work: Too slow for UX

## Affected Component(s)

- [ ] Frontend (React / TypeScript)
- [x] Backend / IoT bridge (Node.js)
- [ ] Smart contracts (Soroban / Rust)
- [x] Documentation
- [ ] Other

## Additional Context

Requires parsing request bodies before rate limit middleware, which may have performance implications.
