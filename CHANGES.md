# Changes

## batch_update_usage, tx confirmation polling, Zod validation

### feat(contract): `batch_update_usage` (closes #160, #169)

Added `batch_update_usage(updates: Vec<(Symbol, u64, i128)>)` to the Soroban
contract. The IoT oracle previously called `update_usage` once per meter per
cycle, producing 100+ separate transactions for large deployments. The new
function processes up to 50 readings in a single transaction.

- Oracle-gated; rejects batches larger than 50 (`BatchTooLarge`)
- Skips unknown meter IDs and emits `batch_skip` rather than aborting the batch
- Deactivates meters whose balance reaches zero and emits `mtr_deact`
- IoT bridge buffers MQTT readings and flushes via `batch_update_usage` on a
  configurable interval (`BATCH_FLUSH_MS`, default 5 s)

### fix(backend): `adminInvoke` waits for on-chain confirmation (closes #170)

`server.sendTransaction()` returns immediately while the transaction is still
`PENDING`. `adminInvoke` now polls `server.getTransaction(hash)` until the
status is `SUCCESS` or `FAILED`, or until `TX_TIMEOUT_MS` (default 30 s) is
reached. A timeout error is thrown if the deadline is exceeded.

### feat(backend): Zod request validation on all API routes (closes #171)

A `validateRequest` middleware backed by Zod now guards every mutating route.
Invalid requests receive a structured `400` response with per-field error
details before any contract call is made.
