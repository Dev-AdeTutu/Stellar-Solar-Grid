---
name: Feature Request
about: Propose a new feature or improvement
title: "[Feature] Allow users to set custom meter nicknames"
labels: enhancement
assignees: ''
---

## Problem Statement

Users with multiple meters (e.g., house + shop) see only technical meter IDs like "METER001", "METER002". They need friendly names to quickly identify which meter they're managing.

## Proposed Solution

Add nickname feature:
- Input field in MeterCard component: "Set nickname"
- Store nicknames in localStorage (client-side only)
- Display nickname prominently with meter ID as subtitle
- Max length: 30 characters
- Fallback to meter ID if no nickname set

Example display:
```
Home Solar ☀️
METER001
```

Optional future enhancement: Store nicknames on-chain or backend for cross-device sync.

## Alternatives Considered

- On-chain nicknames: Costs gas, not worth it
- Backend storage: Requires authentication, more complex

## Affected Component(s)

- [x] Frontend (React / TypeScript)
- [ ] Backend / IoT bridge (Node.js)
- [ ] Smart contracts (Soroban / Rust)
- [ ] Documentation
- [ ] Other

## Additional Context

Use emoji picker for fun UX touch (users love personalizing their meters).
