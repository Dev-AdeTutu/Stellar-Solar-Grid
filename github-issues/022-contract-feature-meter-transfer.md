---
name: Feature Request
about: Propose a new feature or improvement
title: "[Feature] Add meter ownership transfer function"
labels: enhancement
assignees: ''
---

## Problem Statement

When a household moves or sells property, the new occupant should be able to take over the existing meter. Currently, there's no way to transfer ownership, requiring meter deactivation and re-registration.

## Proposed Solution

Add `transfer_meter(meter_id: String, new_owner: Address)` function that:
- Verifies caller is current owner OR admin
- Updates meter owner to `new_owner`
- Preserves meter balance (new owner inherits remaining credit)
- Emits `meter_transferred` event with old/new owner addresses
- Resets `units_used` for new owner (fresh start)
- Maintains ownership history for audit

Optional: require new owner's signature for consent.

## Alternatives Considered

- Deactivate and re-register: Loses payment history
- Off-chain transfer only: No blockchain audit trail

## Affected Component(s)

- [x] Frontend (React / TypeScript)
- [ ] Backend / IoT bridge (Node.js)
- [x] Smart contracts (Soroban / Rust)
- [x] Documentation
- [ ] Other

## Additional Context

Consider adding a small transfer fee (e.g., 0.1 XLM) to prevent abuse via rapid ownership cycling.
