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
- **Topic 2:** `meter_id` (String)
- **Data:** `MeterDeactivated` (`meter_id: String`, `reason: Symbol`, `timestamp: u64`)

Emitted when a meter is deactivated in any of the following scenarios:
- Balance depleted to zero (`balance_zero`) in `apply_usage()` or refund
- Administrative deactivation (`admin_action`) via `set_active(false)`, `set_meter_active(false)`, `deactivate_meter()`, or `batch_deactivate_meters()`
- Grace period expiry (`expiry`) in `apply_usage()`

#### meter_decommissioned
- **Topic 0:** `mtr_dcom` (symbol_short)
- **Topic 1:** `solargrid` (EVT_NS)
- **Topic 2:** `meter_id` (String)
- **Data:** `MeterDecommissioned` (`meter_id: String`, `owner: Address`, `refunded: i128`, `timestamp: u64`)

Emitted when an admin permanently decommissions a meter via `decommission_meter(meter_id)`.
Decommissioning is terminal: the meter's `decommissioned` flag is set to `true`, any
remaining balance is refunded to the meter owner, and all subsequent operations on the
meter are rejected with `ContractError::MeterDecommissioned`.

#### batch_skip
- **Topic 0:** `btch_skip` (symbol_short)
- **Topic 1:** `solargrid` (EVT_NS)
- **Topic 2:** `meter_id` (Symbol)
- **Data:** `()` (empty)

Emitted when a meter ID in `batch_update_usage` is not found and skipped.
Also emitted (with the same shape) by `batch_register_meters` for each entry
skipped because the meter ID already exists, is duplicated within the batch,
or the owner is not on the allowlist.
Also emitted by `batch_deactivate_meters` for each meter that is not found
or already inactive.

#### revenue_withdrawn
- **Topic 0:** `rev_wdrl` (symbol_short)
- **Topic 1:** `solargrid` (EVT_NS)
- **Topic 2:** `provider` (Address)
- **Data:** `(token_address: Address, amount: i128)`

Emitted when the provider withdraws accumulated revenue.

#### meter_transferred (MeterTransferred)
- **Topic 0:** `solargrid` (EVT_NS)
- **Topic 1:** `MeterTransferred`
- **Topic 2:** `meter_id` (String)
- **Data:** `(old_owner: Address, new_owner: Address, meter_id: String)`

Emitted when meter ownership is transferred via `transfer_meter(meter_id, new_owner)`. Updates `OwnerMeters` index for both old and new owners, resets `units_used` for the new owner, and requires authorization from the current owner or admin.

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

## Meter Sharing for Multi-Tenant Buildings (Issue #851)

Multi-tenant buildings can split a single meter's cost among multiple residents.
The meter owner registers co-payers and assigns each a `share_percentage`; usage
costs are then deducted proportionally from each co-payer's balance.

### `add_meter_share_holder(meter_id: String, co_payer: Address, share_percentage: u32)`

Callable by the meter owner (or admin). Adds `co_payer` to the meter's
shareholder set with the given `share_percentage` (in basis points, `0..=10000`).
The sum of all shareholders' percentages must not exceed `10000` (100%).
Requires authorization from the meter owner. Emits `share_holder_added`.

### `get_meter_shareholders(meter_id: String) -> Vec<(Address, u32)>`

Returns the list of `(co_payer, share_percentage)` pairs currently registered for
the meter. Returns an empty vector for meters with no shareholders.

### Proportional cost deduction

When usage is recorded via `apply_usage`/`batch_update_usage`, the computed cost
is split across shareholders: each co-payer is debited
`cost * share_percentage / 10000` from their own balance, and the meter owner is
debited the remainder. If a co-payer's balance is insufficient, the shortfall is
charged to the meter owner so the full cost is always collected.

#### share_holder_added
- **Topic 0:** `shr_add` (symbol_short)
- **Topic 1:** `solargrid` (EVT_NS)
- **Topic 2:** `meter_id` (String)
- **Data:** `(co_payer: Address, share_percentage: u32)`

Emitted when a co-payer is added to a meter via `add_meter_share_holder`.

## Family/Household Account Sharing (Issue #981)

Meter owners can delegate access to their meter account so family members can
operate it from their own wallets. Delegation is role-based: each delegate is
granted a permission bitmask and an optional expiry.

### `Delegate` struct

| Field               | Type      | Description                                                        |
|---------------------|-----------|--------------------------------------------------------------------|
| `delegated_address` | `Address` | Wallet granted access to the meter                               |
| `permissions`       | `u32`     | Bitmask of granted permissions (see below)                       |
| `expiry`            | `u64`     | Unix timestamp after which the delegation is invalid (`0` = never) |

Permission bits:

| Bit | Constant    | Meaning                                                       |
|-----|-------------|---------------------------------------------------------------|
| 0   | `PERM_VIEW` | Read-only access to meter state, usage and billing history    |
| 1   | `PERM_PAY`  | May top up the meter balance (`make_payment`)                 |
| 2   | `PERM_ADMIN`| Full administrative control over the meter (excluding transfer)|

### `add_delegate(meter_id: String, delegated_address: Address, permissions: u32, expiry: u64)`

Owner-only (or admin). Registers or replaces the delegation entry for
`delegated_address` on `meter_id`. Requires authorization from the meter owner.
Rejects unknown meters, zero permission masks, and expiry timestamps in the
past. Emits `DelegateAdded`.

### `remove_delegate(meter_id: String, delegated_address: Address)`

Owner-only (or admin). Removes the delegation entry for `delegated_address`.
Requires authorization from the meter owner. Emits `DelegateRemoved`.

### `get_delegates(meter_id: String) -> Vec<Delegate>`

Returns all active (non-expired) delegations registered for the meter. Returns
an empty vector for meters with no delegates.

### Permission checks

`check_delegate_permission(meter_id: String, caller: Address, required: u32) -> bool`
returns `true` when `caller` is the meter owner, the admin, or a delegate whose
entry has not expired and whose `permissions` mask contains all bits in
`required`. Operations such as `make_payment` and admin-only meter mutations
call this helper before proceeding.

#### delegate_added
- **Topic 0:** `dlg_add` (symbol_short)
- **Topic 1:** `solargrid` (EVT_NS)
- **Topic 2:** `meter_id` (String)
- **Data:** `(delegated_address: Address, permissions: u32, expiry: u64)`

Emitted when a delegation is created or updated via `add_delegate`.

#### delegate_removed
- **Topic 0:** `dlg_rmv` (symbol_short)
- **Topic 1:** `solargrid` (EVT_NS)
- **Topic 2:** `meter_id` (String)
- **Data:** `(delegated_address: Address)`

Emitted when a delegation is removed via `remove_delegate`.

## Seasonal Pricing (Issue #992)

Fixed pricing is replaced by date-driven seasonal rates so tariffs track
seasonal energy demand. Seasons are configured by the admin and applied
automatically during cost computation.

### `SeasonalRate` struct

| Field        | Type     | Description                                                       |
|--------------|----------|-------------------------------------------------------------------|
| `season`     | `Symbol` | Season identifier (e.g. `summer`, `winter`)                       |
| `start_date` | `u64`    | Unix timestamp at which the season begins (inclusive)             |
| `end_date`   | `u64`    | Unix timestamp at which the season ends (exclusive)               |
| `multiplier` | `u32`    | Rate multiplier in basis points (`10000` = 1.0x base rate)        |

### `set_seasonal_rates(rates: Vec<SeasonalRate>)`

Admin-only. Replaces the configured seasonal rate table. Rejects empty input,
overlapping or inverted `[start_date, end_date)` ranges, and zero multipliers.
Emits `SeasonalRateApplied` for the season that is active at the time of the
call.

### Automatic rate application

Cost computation (`apply_usage`, `batch_update_usage`, and the payment paths)
resolves the current season from the ledger timestamp and scales the base rate
by the matching `multiplier / 10000`. When no season matches the current date,
the base rate is used unchanged.

### Views

- `get_current_season() -> Option<SeasonalRate>` — the season active at the
  current ledger timestamp, or `None` when no season matches.
- `get_seasonal_rates() -> Vec<SeasonalRate>` — the full configured rate table,
  for historical seasonal comparison in the frontend.

#### seasonal_rate_applied
- **Topic 0:** `ssn_appl` (symbol_short)
- **Topic 1:** `solargrid` (EVT_NS)
- **Topic 2:** `season` (Symbol)
- **Data:** `(start_date: u64, end_date: u64, multiplier: u32, applied_at: u64)`

Emitted when a seasonal rate is configured via `set_seasonal_rates` and when a
seasonal rate is applied during cost computation.

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
- `test_add_meter_share_holder`, `test_add_meter_share_holder_rejects_over_100_percent`, `test_get_meter_shareholders`, `test_apply_usage_splits_cost_proportionally`, `test_apply_usage_share_holder_shortfall_charged_to_owner` (issue #851)
- `test_add_delegate`, `test_add_delegate_replaces_existing`, `test_add_delegate_rejects_zero_permissions`, `test_add_delegate_rejects_past_expiry`, `test_remove_delegate`, `test_get_delegates_excludes_expired`, `test_check_delegate_permission_view_pay_admin`, `test_delegate_can_make_payment`, `test_delegate_without_pay_permission_rejected`, `test_delegate_events_emitted` (issue #981)
- `test_set_seasonal_rates`, `test_set_seasonal_rates_rejects_overlap`, `test_set_seasonal_rates_rejects_inverted_range`, `test_set_seasonal_rates_rejects_zero_multiplier`, `test_get_current_season`, `test_get_current_season_none_when_no_match`, `test_apply_usage_applies_seasonal_multiplier`, `test_apply_usage_uses_base_rate_outside_seasons`, `test_seasonal_rate_applied_event_emitted` (issue #992)

**Note:** the crate's test module currently fails to compile on `main` for reasons unrelated to these two features (many pre-existing tests pass a `Symbol` where the `meter_id: String` parameters now expect a `String`, plus a `ContractEvents::iter` API drift) — `cargo test` cannot run for this crate until that's fixed. The new code above was verified with `cargo check` (library) and `cargo build --target wasm32v1-none --release` (both clean), and its own test functions were confirmed to produce zero compiler errors by cross-referencing `cargo check --tests` output against their line ranges.

### Batch Deactivate Tests (Issue #664)
- `test_batch_deactivate_all_active` — deactivates 3 active meters in one call
- `test_batch_deactivate_skips_inactive` — skips already-inactive meters
- `test_batch_deactivate_skips_nonexistent` — skips meters that don't exist
- `test_batch_deactivate_mixed` — mix of active, inactive, and nonexistent
- `test_batch_deactivate_empty` — empty vector returns zero counts
- `test_batch_deactivate_too_large` — rejects batches over 50 entries
- `test_batch_deactivate_emits_events` — verifies mtr_deact events

### Bulk Meter Registration (Issue #818)
The `batch_register_meters(meters: Vec<(String, Address)>)` function enables energy providers to register up to 50 meters in a single transaction:
- **Max Batch Size:** 50 meters per call. Returns `ContractError::BatchTooLarge` if exceeded.
- **Input Validation:** Pre-validates empty meter IDs, duplicate IDs in batch, existing meters, and owner allowlist membership.
- **Event Emission:** Emits standard `meter_registered` (`mtr_reg`) event for each successfully registered meter and `batch_skip` (`btch_skip`) for failed/skipped entries.
- **Detailed Error Reporting:** Returns `Vec<BatchRegisterResult>` with `meter_id`, `success: bool`, and `error: Option<String>` detailing reasons for any partial failures (`empty_meter_id`, `duplicate_in_batch`, `meter_already_exists`, `owner_not_allowlisted`).

## Admin Audit Log (#836)

Every state-changing admin function (allowlist, oracle, freeze/pause, pricing,
refunds, meter lifecycle, collaborators, distributions, migrations, multisig
configuration, emergency withdrawals) appends an immutable `AdminAuditEntry` to
persistent storage and emits an `AdminAct` event:

| Field             | Type      | Description                              |
|-------------------|-----------|------------------------------------------|
| `id`              | `u64`     | Sequential entry id (0-based)            |
| `action_type`     | `String`  | Name of the admin function invoked       |
| `admin_address`   | `Address` | Admin that authorized the call           |
| `affected_entity` | `String`  | Entity affected by the action            |
| `timestamp`       | `u64`     | Ledger timestamp of the action           |

Query functions:

- `get_audit_log_count() -> u64`
- `get_audit_logs(filter: AuditLogFilter, offset: u32, limit: u32) -> Vec<AdminAuditEntry>`
  - `filter.action_type`, `filter.admin`, `filter.from_ts`, `filter.to_ts` are all optional.
  - `offset` skips matching entries; `limit` is capped at 100.

## Energy Token Staking (#899)

Implemented in `solar_grid/src/staking.rs`. See `docs/STAKING_SECURITY_REVIEW.md`
for the security review.

## Admin Transfer (#820)

The administrator role uses a two-step handoff so a proposed address must
explicitly accept control:

- `propose_admin_transfer(new_admin)` is authorized by the current admin and
  creates or replaces a pending proposal that expires seven days after creation.
- `accept_admin_transfer()` requires authorization from the proposed address.
  It rejects missing or expired proposals, changes the administrator, removes
  the pending proposal, and records the action in the admin audit log.
- The contract emits `AdminTransferred` with `(old_admin, new_admin)` after
  acceptance. `AdminTransferProposed` records the proposed address and expiry.

The transfer flow is covered by `test_admin_transfer_propose_accept_and_emit_event`
and `test_admin_transfer_expires_after_seven_days`.

Admin setup:

- `configure_staking(stake_token, reward_token, reward_rate, cooldown_secs)`: `reward_rate`
  is reward units per second shared by all stakers; `cooldown_secs` ≤ 90 days. Tokens
  can't be switched once staking has activity.
- `fund_staking_rewards(from, amount)`: tops up the reward reserve (anyone may fund).

User functions (each requires the staker's auth):

| Function | Notes |
| --- | --- |
| `stake(staker, amount)` | Blocked while the contract is paused |
| `request_unstake(staker, amount) -> u64` | Stops rewards and voting power at once; returns the unlock time. A new request adds to the bucket and restarts the cooldown |
| `withdraw_unstaked(staker) -> i128` | After the cooldown |
| `cancel_unstake(staker) -> i128` | Restakes tokens that are cooling down |
| `claim_staking_rewards(staker) -> i128` | Pays all accrued rewards |

Views: `get_staking_config`, `get_staking_pool`, `get_stake_info(staker)`,
`get_voting_power(voter)`, `get_total_voting_power()`.

Rewards use a reward-per-share accumulator (scale 1e12): O(1) per call, pro-rata to
stake, and emission stops when the funded reserve is exhausted. Voting power is the
active stake; pass `get_voting_power(voter)` as the `weight` to
`governance::vote_on_proposal`, and `get_total_voting_power()` to size quorum.

Events (`solar`, …): `stk_cfg`, `stk_fund`, `staked`, `unstk_req`, `unstaked`,
`unstk_cxl`, `stk_claim`.

New errors: `StakingNotConfigured` (38), `InsufficientStake` (39),
`NoPendingUnstake` (40), `CooldownNotElapsed` (41).

## Community Solar Farms (#984)

Users without rooftop space can buy shares in a community solar farm and receive
credits proportional to the farm's generation. Implemented in
`solar_grid/src/solar_farm.rs`.

### `SolarFarm` struct

| Field | Type | Description |
|---|---|---|
| `id` | `u64` | Sequential farm id (0-based) |
| `name` | `String` | Human-readable farm name |
| `capacity_watts` | `u64` | Installed capacity in watts |
| `share_price` | `i128` | Price per share in the payment token |
| `total_shares` | `u64` | Total shares issued so far |
| `shareholders` | `Vec<(Address, u64)>` | `(investor, shares)` pairs, in purchase order |
| `generation_data` | `Vec<GenerationRecord>` | Per-period generation readings |
| `total_generation` | `u64` | Cumulative generation in Wh across all periods |
| `active` | `bool` | Whether shares can still be purchased |

`GenerationRecord` holds `period_start`, `period_end`, and `energy_wh`.

### `buy_solar_share(buyer, farm_id, shares)`

Requires authorization from `buyer`. Transfers `shares * share_price` of the
configured payment token from `buyer` to the contract, then credits `shares` to
the buyer's position in `shareholders` (creating the entry on first purchase).
Rejects `shares == 0`, unknown or inactive farms, and insufficient token balance
or allowance. Emits `SharePurchased`.

### `distribute_generation_credits(farm_id, energy_wh, period_start, period_end)`

Admin-only (requires the administrator's authorization). Appends a
`GenerationRecord` to `generation_data`, adds `energy_wh` to `total_generation`,
and allocates credits **proportionally** to each shareholder:

```
credit_i = energy_wh * shares_i / total_shares
```

Integer division truncates, so the sum of allocated credits may be less than
`energy_wh`; the remainder is retained by the contract. Shareholders with zero
shares receive nothing. Rejects unknown farms, empty shareholder sets, and
periods that end before they start. Emits `CreditsDistributed`.

### Views

`get_solar_farm(farm_id)`, `get_solar_farms(offset, limit)` (limit capped at
100), `get_farm_shareholders(farm_id)`, `get_farm_generation(farm_id)`, and
`get_shareholder_credits(farm_id, investor)`.

### Events

#### SharePurchased
- **Topic 0:** `shr_buy` (symbol_short)
- **Topic 1:** `solargrid` (EVT_NS)
- **Topic 2:** `farm_id` (u64)
- **Data:** `(buyer: Address, shares: u64, amount_paid: i128)`

Emitted by `buy_solar_share` for every successful purchase.

#### CreditsDistributed
- **Topic 0:** `crd_dist` (symbol_short)
- **Topic 1:** `solargrid` (EVT_NS)
- **Topic 2:** `farm_id` (u64)
- **Data:** `(energy_wh: u64, total_generation: u64, period_start: u64, period_end: u64)`

Emitted by `distribute_generation_credits` once per distribution.

### New errors

| Variant | Code | Raised when |
|---|---|---|
| `SolarFarmNotFound` | 60 | Farm id does not exist |
| `SolarFarmInactive` | 61 | Farm is not accepting purchases |
| `InvalidShareAmount` | 62 | `shares == 0` |
| `NoShareholders` | 63 | Distribution attempted with no shareholders |
| `InvalidGenerationPeriod` | 64 | `period_end < period_start` |

### Usage example

```rust
// Admin registers a farm and funds it with a payment token.
let farm_id = client.create_solar_farm(&admin, &name, &capacity_watts, &share_price);

// A user without rooftop space buys 10 shares.
client.buy_solar_share(&buyer, &farm_id, &10);

// Admin reports a generation period; credits are split pro-rata.
client.distribute_generation_credits(&admin, &farm_id, &energy_wh, &start, &end);

// The buyer checks their accrued credits.
let credits = client.get_shareholder_credits(&farm_id, &buyer);
```

### Tests

Share management is covered by `test_create_solar_farm`,
`test_buy_solar_share_updates_shareholders`,
`test_buy_solar_share_rejects_zero_shares`,
`test_buy_solar_share_rejects_inactive_farm`,
`test_distribute_generation_credits_proportional`,
`test_distribute_generation_credits_tracks_total_generation`,
`test_distribute_generation_credits_rejects_no_shareholders`, and
`test_buy_solar_share_emits_event` (issue #984).

## Energy Export Certificates (#871)

Non-fungible certificates attesting that a meter exported renewable energy to
the grid. Implemented in `solar_grid/src/certificates.rs`.

| Function | Description |
|---|---|
| `mint_export_certificate(issuer, meter_id, energy_wh, period_start, period_end, reading_hash) -> u64` | `issuer` (admin or registered oracle) must authorize. Mints to the meter owner. Periods are `[start, end)` in Unix seconds, may not end in the future, and may not overlap the meter's previously certified period |
| `transfer_export_certificate(id, to)` | Holder must authorize; retired certificates cannot move |
| `retire_export_certificate(id)` | Holder claims the renewable attribute; irreversible |
| `verify_export_certificate(id, reading_hash) -> bool` | True when the certificate exists and commits to `reading_hash` |

Views: `get_export_certificate(id)`, `get_certificates_by_owner(owner, offset, limit)`
(limit capped at 100), `get_certificate_count()`, `get_last_certified_period_end(meter_id)`.

Metadata (`ExportCertificate`): `id`, `meter_id`, `producer`, `owner`,
`energy_wh`, `period_start`, `period_end`, `issued_at`, `issuer`,
`reading_hash`, `retired_at`.

`reading_hash` is the SHA-256 of the canonical JSON (keys sorted) of the
reading payload the certificate was minted from. The backend computes it in
`backend/src/lib/exportCertificates.ts`, prints it on the PDF certificate, and
exposes `GET /api/certificates/:id/verify` so third parties can check a PDF
against the chain.

Events (`solargrid`, …, `id`): `cert_mint` `(meter_id, producer, energy_wh,
period_start, period_end, reading_hash)`, `cert_xfer` `(from, to)`,
`cert_ret` `(owner, energy_wh, retired_at)`.

New errors: `CertificateNotFound` (50), `InvalidCertificatePeriod` (51),
`CertificatePeriodOverlap` (52), `CertificateRetired` (53).

## Energy credit gifting and subscription boxes (Issues #1018 and #1019)

`gift_energy_credit(sender_meter_id, recipient_meter_id, amount, message)` moves
prepaid credits between registered meters after the sender owner authorizes. It
rejects non-positive amounts, insufficient balances, unknown meters, and overly
long messages. It emits `EnergyGifted(sender, recipient, amount)` and
`get_gift_history(owner)` exposes the sender's history.

Subscription boxes are configured with
`create_subscription_tier(name, price, included_kwh, rollover_limit)`. Users
enroll with `subscribe(owner, tier_id)` and can use
`upgrade_subscription`, `downgrade_subscription`, and `renew_subscription`.
Renewal deducts the tier price from the owner's first registered meter balance,
adds the included kWh, and carries unused kWh forward up to the tier's
`rollover_limit`. `SubscriptionRenewed(owner, tier_id, price)` is emitted for
enrollment, changes, and monthly renewal. `consume_subscription_kwh` is the
usage-accounting hook used by the billing integration.
