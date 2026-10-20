# Multi-Signature Transaction Batching

`execute_batch(actions: Vec<AdminAction>) -> u32` bundles several admin
operations into one contract invocation.

## Actions

| Variant | Equivalent call |
|---|---|
| `SetActive(meter_id, bool)` | `set_active` |
| `SetDailyLimit(meter_id, i128)` | `set_daily_limit` |
| `AllowlistAdd(address)` | `allowlist_add` |
| `AllowlistRemove(address)` | `allowlist_remove` |
| `SetOracle(address)` | `set_oracle` |

Limits: 1 – 25 actions (`BatchEmpty` / `BatchTooLarge`).

## Multi-sig approval

The contract admin can be a Stellar multi-sig account (signer weights +
thresholds). Because the whole batch is one transaction requiring one
`admin.require_auth()`, signers collect the threshold of signatures **once**
for the entire bundle instead of once per action.

## Atomicity

Actions run in order. If any action fails (e.g. unknown meter), the
invocation returns an error and Soroban discards every storage write and
event from the batch — all or nothing.

## Gas savings

Per transaction you pay the base fee, signature verification, envelope
footprint and admin auth once. For *n* actions this removes *n − 1* of each,
plus *n − 1* signing rounds among the multi-sig signers. Instance storage
(allowlist, oracle) is loaded once per batch rather than per transaction.

## Usage

- **Backend:** `POST /api/batch { "actions": [{ "type": "AllowlistAdd", "address": "G…" }, …] }`
  (`backend/src/routes/batch.ts` encodes the enum and submits `execute_batch`).
- **Frontend:** `/admin/batch` — batch builder UI to compose, review and submit.

Tests: `batch_and_market_tests` in `solar_grid/src/test.rs`.
