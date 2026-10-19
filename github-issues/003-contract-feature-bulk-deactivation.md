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

## Resolution

**Status:** ✅ **RESOLVED** (closes #664)

### Implementation

Added `batch_deactivate_meters(meter_ids: Vec<String>)` to `contracts/solar_grid/src/lib.rs`:

- Accepts a `Vec<String>` of meter IDs (max 50, matching `batch_update_usage`)
- Admin-only access (mirrors `deactivate_meter`)
- Emits `mtr_deact` for each meter successfully deactivated
- Emits `btch_skip` for each meter skipped (not found or already inactive)
- Returns `BatchDeactivateSummary { total, deactivated, skipped, results }` with per-meter success/failure details
- New types: `BatchDeactivateResult` and `BatchDeactivateSummary`

### Tests Added
- `test_batch_deactivate_all_active` — deactivates 3 active meters
- `test_batch_deactivate_skips_inactive` — skips already-inactive meters
- `test_batch_deactivate_skips_nonexistent` — skips meters that don't exist
- `test_batch_deactivate_mixed` — mix of active, inactive, and nonexistent
- `test_batch_deactivate_empty` — empty vector returns zero counts
- `test_batch_deactivate_too_large` — rejects batches over 50 entries
- `test_batch_deactivate_emits_events` — verifies mtr_deact events

### Files Changed
- `contracts/solar_grid/src/lib.rs` — added `BatchDeactivateResult`, `BatchDeactivateSummary` types and `batch_deactivate_meters` function + tests
- `contracts/README.md` — documented batch_skip event for batch_deactivate_meters, added test list
- `README.md` — added `batch_deactivate_meters` to contract functions table
