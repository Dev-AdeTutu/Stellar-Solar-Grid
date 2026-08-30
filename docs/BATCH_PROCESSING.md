# Usage Batch Processing

Closes #678.

The IoT bridge (`backend/src/iot/bridge.ts`) buffers meter usage readings and
periodically submits them to the `batch_update_usage` contract call. A large
backlog (e.g. built up while the MQTT broker was down) used to be submitted
as a single, unbounded batch — building one large in-memory payload and
risking a `JavaScript heap out of memory` crash, on top of the on-chain
contract already rejecting batches over 50 entries.

## Fix

- `MAX_BATCH_SIZE` env var (default **50**, hard-capped at 50 to match the
  contract's own limit — see `contracts/solar_grid/src/lib.rs`) bounds how
  many readings are submitted per `batch_update_usage` call.
- The flush loop now slices a large backlog into `MAX_BATCH_SIZE` chunks and
  submits/persists them one at a time, so memory for a processed chunk is
  released before the next chunk is sliced off, instead of holding the whole
  backlog in memory at once.
- As a short-term safety net, the backend's `start` script now runs with
  `--max-old-space-size=1024` (`backend/package.json`) to raise the default
  512MB Docker heap limit.

See `MAX_BATCH_SIZE` in `backend/.env.example`.
