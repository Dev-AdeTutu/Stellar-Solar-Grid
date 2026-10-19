---
name: Feature Request
about: Propose a new feature or improvement
title: "[Feature] Implement exponential backoff for webhook retries"
labels: enhancement
assignees: ''
---

## Problem Statement

Low-balance webhook notifications currently retry immediately on failure. If the provider's endpoint is temporarily down, this generates unnecessary traffic and doesn't give the service time to recover.

## Proposed Solution

Implement exponential backoff retry strategy:
- 1st retry: after 1 second
- 2nd retry: after 2 seconds
- 3rd retry: after 4 seconds
- 4th retry: after 8 seconds
- 5th retry: after 16 seconds
- Max retries: 5
- Give up after 31 seconds total

Log each retry attempt with timestamp and response status for debugging.

## Alternatives Considered

- Fixed interval retries: Doesn't adapt to transient issues
- Retry queue with background worker: More complex infrastructure

## Affected Component(s)

- [ ] Frontend (React / TypeScript)
- [x] Backend / IoT bridge (Node.js)
- [ ] Smart contracts (Soroban / Rust)
- [x] Documentation
- [ ] Other

## Additional Context

Consider adding circuit breaker pattern if webhook fails consistently (e.g., 10 consecutive failures → pause notifications for 5 minutes).
