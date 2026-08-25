---
name: Feature Request
about: Propose a new feature or improvement
title: "[Feature] Add payment refund function for admin"
labels: enhancement
assignees: ''
---

## Problem Statement

Occasionally, users make duplicate payments by mistake or payments fail to grant access due to contract errors. Currently, there's no way to refund payments on-chain, requiring manual off-chain resolution.

## Proposed Solution

Add admin-restricted function `refund_payment(meter_id: String, amount: i128, recipient: Address)` that:
- Verifies admin privileges
- Transfers `amount` back to `recipient` from contract balance
- Emits `payment_refunded` event with details
- Updates meter balance appropriately
- Logs reason for audit trail

Require refund amount ≤ total payments received from that address to prevent abuse.

## Alternatives Considered

- Off-chain refunds: No audit trail, trust issues
- Automatic refund on duplicate detection: Too complex, edge cases

## Affected Component(s)

- [ ] Frontend (React / TypeScript)
- [ ] Backend / IoT bridge (Node.js)
- [x] Smart contracts (Soroban / Rust)
- [x] Documentation
- [ ] Other

## Additional Context

Should include maximum refund limits per time period to prevent contract balance drainage attacks.
