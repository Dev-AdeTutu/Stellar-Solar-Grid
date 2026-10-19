---
name: Feature Request
about: Propose a new feature or improvement
title: "[Feature] Add batch meter registration function"
labels: enhancement
assignees: ''
---

## Problem Statement

Energy providers onboarding new communities need to register hundreds of meters. Current `register_meter` function requires one transaction per meter, resulting in high costs and slow deployment.

## Proposed Solution

Add `batch_register_meters(meters: Vec<(String, Address)>)` that:
- Accepts vector of (meter_id, owner) tuples
- Registers all meters in single transaction
- Validates no duplicate meter IDs in batch
- Emits `meter_registered` event for each
- Returns array of results (success/failure per meter)
- Admin-only access

Max batch size: 100 meters (to stay under transaction limits).

## Alternatives Considered

- Client-side loop: Very slow and expensive
- Off-chain registration: Defeats on-chain audit purpose

## Affected Component(s)

- [ ] Frontend (React / TypeScript)
- [x] Backend / IoT bridge (Node.js)
- [x] Smart contracts (Soroban / Rust)
- [x] Documentation
- [ ] Other

## Additional Context

Similar to existing `batch_update_usage`. Consider adding CSV import tool in admin dashboard.
