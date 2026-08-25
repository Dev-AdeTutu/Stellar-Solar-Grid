---
name: Feature Request
about: Propose a new feature or improvement
title: "[Feature] Add bulk meter deactivation function to smart contract"
labels: enhancement
assignees: ''
---

## Problem Statement

Energy providers need to deactivate multiple meters simultaneously (e.g., during maintenance windows, emergency shutdowns, or batch non-payment enforcement). Currently, `deactivate_meter` only supports one meter at a time, requiring multiple transactions.

## Proposed Solution

Add a new contract function `batch_deactivate_meters(meter_ids: Vec<String>)` that:
- Accepts a vector of meter IDs
- Deactivates all specified meters in a single transaction
- Emits events for each deactivated meter
- Returns a summary of successful/failed deactivations
- Is admin-restricted like the current `deactivate_meter` function

## Alternatives Considered

- Client-side batch processing: High gas costs and slow
- Off-chain bulk operations: Defeats purpose of on-chain audit trail

## Affected Component(s)

- [ ] Frontend (React / TypeScript)
- [ ] Backend / IoT bridge (Node.js)
- [x] Smart contracts (Soroban / Rust)
- [ ] Documentation
- [ ] Other

## Additional Context

This would mirror the existing `batch_update_usage` pattern and significantly reduce operational costs during mass deactivation scenarios.
