# Meter Circular Economy Lifecycle Tracking

This document describes the on-chain lifecycle tracking of electricity meters from
manufacturing through end-of-life recycling, as required for circular economy
compliance.

## Overview

Every meter registered in the system has a complete, immutable lifecycle record
maintained on-chain. The lifecycle record captures:

- **Manufacturing origin and materials** — where and when the meter was made,
  and what materials it contains (for later recovery accounting).
- **Operational events** — installation, repairs, and upgrades performed during
  the meter's service life.
- **End-of-life recycling certification** — a certified recycling event that
  closes the meter's lifecycle.
- **Material recovery tracking** — quantities of each material recovered during
  recycling, reconciled against the materials declared at manufacturing.

The lifecycle record is append-only: events can be added but never removed or
rewritten. This provides an auditable trail suitable for regulatory review.

## Data Model

### Meter Lifecycle Record

| Field | Description |
| --- | --- |
| `meter_id` | Unique meter identifier (matches the meter registry). |
| `manufacturer` | Registered manufacturer identifier. |
| `manufactured_at` | Timestamp of manufacturing. |
| `origin` | Manufacturing facility / region of origin. |
| `materials` | Declared bill-of-materials: material code → mass (grams). |
| `status` | Current lifecycle status (see below). |
| `events` | Ordered list of lifecycle events. |
| `recycling_certificate` | Present once the meter has been recycled. |

### Lifecycle Status

```
Manufactured → Installed → InService → (Repaired | Upgraded)* → Decommissioned → Recycled
```

- `Manufactured` — record created with origin and materials.
- `Installed` — meter physically installed at a location.
- `InService` — meter is active and reporting.
- `Decommissioned` — meter removed from service, awaiting recycling.
- `Recycled` — recycling certified and material recovery recorded.

### Lifecycle Events

Each event carries a `kind`, `timestamp`, `actor`, and kind-specific payload:

| Kind | Payload |
| --- | --- |
| `Manufactured` | `origin`, `materials` |
| `Installed` | `location`, `installer` |
| `Repaired` | `description`, `parts_replaced`, `technician` |
| `Upgraded` | `description`, `firmware_version`, `technician` |
| `Decommissioned` | `reason`, `decommissioned_by` |
| `Recycled` | `certificate_id`, `recycler`, `recovered_materials` |

## Contract Entry Points

The lifecycle tracking contract exposes the following entry points. All
mutating calls require authorization from the appropriate role (manufacturer,
operator, or certified recycler) and emit events for off-chain indexing.

### `register_meter`

```rust
register_meter(
    env: Env,
    meter_id: BytesN<32>,
    manufacturer: Address,
    origin: Symbol,
    materials: Map<Symbol, u64>,   // material code -> grams
    manufactured_at: u64,
) -> Result<(), LifecycleError>
```

Creates the lifecycle record in `Manufactured` status. Fails if a record for
`meter_id` already exists or if `materials` is empty.

### `record_installation`

```rust
record_installation(
    env: Env,
    meter_id: BytesN<32>,
    location: Symbol,
    installer: Address,
) -> Result<(), LifecycleError>
```

Transitions `Manufactured → Installed`. Only valid from `Manufactured`.

### `record_repair`

```rust
record_repair(
    env: Env,
    meter_id: BytesN<32>,
    description: Symbol,
    parts_replaced: Vec<Symbol>,
    technician: Address,
) -> Result<(), LifecycleError>
```

Appends a `Repaired` event. Valid while the meter is `Installed` or
`InService`.

### `record_upgrade`

```rust
record_upgrade(
    env: Env,
    meter_id: BytesN<32>,
    description: Symbol,
    firmware_version: Symbol,
    technician: Address,
) -> Result<(), LifecycleError>
```

Appends an `Upgraded` event. Valid while the meter is `Installed` or
`InService`.

### `decommission_meter`

```rust
decommission_meter(
    env: Env,
    meter_id: BytesN<32>,
    reason: Symbol,
    decommissioned_by: Address,
) -> Result<(), LifecycleError>
```

Transitions the meter to `Decommissioned`, making it eligible for recycling.

### `certify_recycling`

```rust
certify_recycling(
    env: Env,
    meter_id: BytesN<32>,
    certificate_id: BytesN<32>,
    recycler: Address,
    recovered_materials: Map<Symbol, u64>,   // material code -> grams recovered
) -> Result<(), LifecycleError>
```

Records the end-of-life recycling certification and the recovered material
quantities. Only valid from `Decommissioned`. Once recorded, the lifecycle is
closed and no further events may be appended.

### Read-only queries

```rust
get_lifecycle(env: Env, meter_id: BytesN<32>) -> Option<MeterLifecycle>
get_events(env: Env, meter_id: BytesN<32>) -> Vec<LifecycleEvent>
get_recovery_summary(env: Env, meter_id: BytesN<32>) -> Option<RecoverySummary>
```

`get_recovery_summary` returns declared vs. recovered mass per material and the
overall recovery rate.

## Material Recovery Tracking

At manufacturing, the declared bill-of-materials is stored per meter. At
recycling, the certified recycler records recovered mass per material. The
contract computes, per material:

- **declared mass** — from the manufacturing record,
- **recovered mass** — from the recycling certificate,
- **recovery rate** — `recovered / declared`.

Recovery rates are exposed via `get_recovery_summary` and are used by the
compliance reporting described below. Recovered quantities that exceed declared
quantities are rejected as invalid.

## Regulatory Compliance

The lifecycle record is designed to satisfy circular economy reporting
obligations:

- **Traceability** — every meter has an unbroken chain of custody from
  manufacturing to recycling.
- **Material accounting** — declared and recovered materials are recorded so
  recovery rates can be reported per meter, per manufacturer, and in aggregate.
- **Certified recycling** — recycling may only be recorded by an authorized
  recycler with a certificate identifier, ensuring end-of-life handling is
  verifiable.
- **Immutability** — events are append-only and emit on-chain events, providing
  an auditable trail for regulators.

Aggregate recovery statistics can be derived by indexing the emitted events
off-chain; no additional on-chain aggregation is required.

## Backend Integration

The backend indexes lifecycle events emitted by the contract:

1. **Event ingestion** — subscribe to contract events (`MeterRegistered`,
   `MeterInstalled`, `MeterRepaired`, `MeterUpgraded`, `MeterDecommissioned`,
   `MeterRecycled`) and persist them in the lifecycle store.
2. **API endpoints** — expose lifecycle data to the frontend:
   - `GET /meters/{id}/lifecycle` — full lifecycle record and event list.
   - `GET /meters/{id}/recovery` — recovery summary.
   - `GET /manufacturers/{id}/recovery` — aggregate recovery statistics.
3. **Validation** — the backend mirrors contract state transitions for
   read-side validation but treats the chain as the source of truth.

## Frontend Visualization

The frontend renders a lifecycle timeline for each meter:

- **Timeline view** — ordered events (manufactured, installed, repairs,
  upgrades, decommissioned, recycled) with timestamps and actors.
- **Materials panel** — declared bill-of-materials with a bar per material
  showing declared vs. recovered mass and the recovery rate.
- **Status badge** — current lifecycle status, with a clear "Recycled" state
  once the recycling certificate is recorded.
- **Compliance summary** — overall recovery rate and certificate identifier for
  recycled meters.

## Tests

Lifecycle tracking is covered by contract tests that verify:

- Registration stores origin and materials and rejects duplicates.
- Installation, repair, and upgrade events are appended in order and rejected
  from invalid states.
- Decommissioning is required before recycling.
- Recycling certification records recovered materials and closes the lifecycle.
- Recovery rates are computed correctly and over-recovery is rejected.
- Unauthorized actors cannot mutate lifecycle records.
- Events are emitted for every state transition.