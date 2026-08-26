# SolarGrid Smart Contract

## Event Schema

The contract emits Soroban events for real-time monitoring by backend and frontend systems.

### Event Topics

All events use the namespace `solargrid` (EVT_NS) as the second topic.

#### meter_registered
- **Topic 0:** `mtr_reg` (symbol_short)
- **Topic 1:** `solargrid` (EVT_NS)
- **Topic 2:** `meter_id` (Symbol)
- **Data:** `owner` (Address)

Emitted when a new meter is registered.

#### payment_received
- **Topic 0:** `pmt_rcvd` (symbol_short)
- **Topic 1:** `solargrid` (EVT_NS)
- **Topic 2:** `meter_id` (Symbol)
- **Data:** `(payer: Address, token_address: Address, amount: i128, plan: PaymentPlan)`

Emitted when a payment is made to top up a meter's balance.

#### meter_activated
- **Topic 0:** `mtr_actv` (symbol_short)
- **Topic 1:** `solargrid` (EVT_NS)
- **Topic 2:** `meter_id` (Symbol)
- **Data:** `()` (empty)

Emitted when a meter is activated (via `make_payment` or `set_active(true)`).

#### usage_updated
- **Topic 0:** `usg_upd` (symbol_short)
- **Topic 1:** `solargrid` (EVT_NS)
- **Topic 2:** `meter_id` (Symbol)
- **Data:** `(units: u64, cost: i128)`

Emitted when energy usage is recorded and cost deducted from balance.

#### meter_deactivated
- **Topic 0:** `mtr_deact` (symbol_short)
- **Topic 1:** `solargrid` (EVT_NS)
- **Topic 2:** `meter_id` (Symbol)
- **Data:** `()` (empty)

Emitted when a meter is deactivated (balance drained to zero or via `set_active(false)`).

#### batch_skip
- **Topic 0:** `btch_skip` (symbol_short)
- **Topic 1:** `solargrid` (EVT_NS)
- **Topic 2:** `meter_id` (Symbol)
- **Data:** `()` (empty)

Emitted when a meter ID in `batch_update_usage` is not found and skipped.

#### revenue_withdrawn
- **Topic 0:** `rev_wdrl` (symbol_short)
- **Topic 1:** `solargrid` (EVT_NS)
- **Topic 2:** `provider` (Address)
- **Data:** `(token_address: Address, amount: i128)`

Emitted when the provider withdraws accumulated revenue.

#### discount_created / discount_revoked / discount_applied

Closes #687 — promotional discount codes.

- `discount_created` — topics `(solargrid, disc_new, code: String)`, data `(discount_pct: u32, valid_until: u64, max_uses: u32)`. Emitted by `admin_create_discount`.
- `discount_revoked` — topics `(solargrid, disc_rvk, code: String)`, no data. Emitted by `admin_revoke_discount`.
- `discount_applied` — topics `(solargrid, disc_appl, code: String)`, data `(meter_id: String, amount: i128, final_cost: i128, discount_pct: u32)`. Emitted by `make_payment_with_discount`.

#### withdrawal_announced / emergency_withdrawal / withdrawal_cancelled

Closes #686 — timelocked emergency admin withdrawal. `emergency_withdraw(amount, recipient)` is a two-step call: the first call announces (starts a 48h timelock), and calling again with the same `amount`/`recipient` after the timelock elapses executes the transfer.

- `withdrawal_announced` — topics `(solargrid, wd_ann)`, data `(recipient: Address, amount: i128, announced_at: u64)`. Emitted on the announcing call.
- `emergency_withdrawal` — topics `(solargrid, emrg_wd)`, data `(recipient: Address, amount: i128)`. Emitted on the executing call, once the 48h timelock has elapsed. `amount` here is the actual amount transferred, capped at the contract's token balance.
- `withdrawal_cancelled` — topics `(solargrid, wd_cncl)`, no data. Emitted by `cancel_emergency_withdrawal`.

`emergency_withdraw` requires the contract to be frozen (`freeze_contract`) and caps `amount` at `TOTAL_REVENUE` — cumulative gross revenue ever collected via `make_payment`/`make_payment_with_discount` — so a compromised admin key can't drain more than customers have actually paid in, regardless of the contract's raw token balance.

## Backend Event Listener

The backend can subscribe to these events via the Stellar RPC `getEvents` endpoint:

```javascript
// Example: Listen for payment_received events
const events = await rpc.getEvents({
  filters: [
    {
      type: 'contract',
      contractIds: [CONTRACT_ID],
      topics: [['pmt_rcvd', 'solargrid']]
    }
  ]
});
```

## Testing

All event emissions are covered by unit tests:
- `test_event_meter_registered`
- `test_event_payment_received_and_meter_activated`
- `test_event_usage_updated_and_meter_deactivated`
- `test_event_meter_deactivated_via_set_active`
- `test_event_meter_activated_via_set_active`
- `test_batch_update_usage_skips_invalid_meter` (includes batch_skip event)
- `test_emergency_withdraw_announce_then_execute_after_timelock`, `test_emergency_withdraw_requires_frozen`, `test_emergency_withdraw_capped_at_total_revenue`, `test_emergency_withdraw_capped_at_current_balance_if_lower`, `test_cancel_emergency_withdrawal`, `test_emergency_withdraw_reannounce_restarts_timelock` (issue #686)
- `test_admin_create_and_get_discount`, `test_make_payment_with_discount_applies_percent_off`, `test_make_payment_with_discount_respects_max_uses`, `test_make_payment_with_discount_respects_expiry`, `test_admin_revoke_discount` (issue #687)

**Note:** the crate's test module currently fails to compile on `main` for reasons unrelated to these two features (many pre-existing tests pass a `Symbol` where the `meter_id: String` parameters now expect a `String`, plus a `ContractEvents::iter` API drift) — `cargo test` cannot run for this crate until that's fixed. The new code above was verified with `cargo check` (library) and `cargo build --target wasm32v1-none --release` (both clean), and its own test functions were confirmed to produce zero compiler errors by cross-referencing `cargo check --tests` output against their line ranges.

## Contract Upgrades & Storage Migration

The `Meter` struct carries a `version: u32` field (currently `1`). When the struct layout changes in a future release, existing persistent storage entries must be migrated before they can be read by the new code.

### Migration flow

1. Deploy the new contract WASM (old entries remain in persistent storage).
2. For each registered meter, call the admin-only `migrate_meter(meter_id)` function.  
   It reads the entry as the previous schema (`LegacyMeter`) and writes it back as the current `Meter` v1.
3. Once all entries are migrated, the `LegacyMeter` type and `migrate_meter_v0` helper can be removed in a subsequent release.

```bash
# Migrate a single meter via Stellar CLI
stellar contract invoke \
  --id <CONTRACT_ID> \
  --source <ADMIN_SECRET> \
  --network testnet \
  -- migrate_meter --meter_id METER1
```

> `migrate_meter` is idempotent — calling it on an already-migrated meter overwrites with the same data. Always test on testnet before mainnet.

### Struct version history

| Version | Fields added / changed |
|---------|------------------------|
| 1 | Initial layout: `owner`, `active`, `units_used`, `plan`, `last_payment`, `expires_at` |


## WASM Build Hash Verification

To prevent supply-chain or configuration drift issues, the CI pipeline computes a SHA-256 hash of the locally built `solar_grid.wasm` artifact and compares it against the hash stored on-chain after every deploy.  A mismatch causes the workflow to exit non-zero, blocking the release.

### How it works

1. **Build** — `cargo build --target wasm32-unknown-unknown --release` produces `contracts/target/wasm32-unknown-unknown/release/solar_grid.wasm`.
2. **Hash artifact** — `sha256sum` computes the digest, which is written to `wasm-hash.txt` and echoed to the GitHub Actions step summary.
3. **Deploy** — the WASM is deployed to Stellar Testnet; the new contract ID is captured as a step output.
4. **Verify on-chain** — `stellar contract info --id <CONTRACT_ID> --network testnet` returns JSON containing a `hash` field (the SHA-256 of the WASM stored on-chain).  The CI step compares it against the local digest (case-insensitively) and exits 1 on any mismatch.

### verify_wasm_hash.sh

A standalone helper script is provided at `contracts/scripts/verify_wasm_hash.sh` for local verification or ad-hoc checks against an already-deployed contract.

```bash
# Print the local WASM hash only (no on-chain lookup)
./contracts/scripts/verify_wasm_hash.sh

# Verify against a deployed contract
CONTRACT_ID=<CONTRACT_ID> ./contracts/scripts/verify_wasm_hash.sh

# Override the WASM path or target network
WASM_FILE=path/to/custom.wasm CONTRACT_ID=<CONTRACT_ID> NETWORK=mainnet \
  ./contracts/scripts/verify_wasm_hash.sh
```

| Variable | Default | Description |
|---|---|---|
| `WASM_FILE` | `contracts/target/wasm32-unknown-unknown/release/solar_grid.wasm` | Path to the compiled WASM artifact |
| `CONTRACT_ID` | _(unset)_ | Deployed contract ID; triggers on-chain comparison when set |
| `NETWORK` | `testnet` | Stellar network passed to `stellar contract info` |

Exit codes: **0** — hashes match (or `CONTRACT_ID` not set), **1** — mismatch or prerequisite failure.

### CI integration

The verification runs automatically on every `contract-v*` tag push via `.github/workflows/contract-deploy.yml`.  Two steps are involved:

- **Hash WASM artifact** — runs immediately after `Build WASM`; records the digest in the step summary.
- **Verify on-chain WASM hash** — runs after `Deploy to testnet`; fetches the on-chain hash with `stellar contract info` and fails the job if it does not match the locally computed digest.
