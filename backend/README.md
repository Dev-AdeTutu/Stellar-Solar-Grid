# Backend meter energy and operations

These additions extend the existing MQTT bridge and on-chain `get_meter` device registry. They do **not** alter the Soroban billing contract or pretend that publishing an MQTT message moves electricity.

## Energy-source tracking (#970)

Meters publish to `solargrid/meters/{meterId}/usage`. Legacy `{ "units": 100, "cost": 500000 }` remains accepted on the existing path; its energy is **unreported**, never guessed as solar/grid.

Source-aware firmware must provide a stable, unique `readingId` (persist across reboots and retransmissions). `units` is an incremental **milli-kWh** quantity, as in the contract. `cost` is integer stroops. Choose exactly one source representation:

```json
{"readingId":"meter-boot42-reading001","units":1000,"cost":500000,"energySource":"solar"}
```

```json
{"readingId":"meter-boot42-reading002","units":1000,"cost":500000,"energySources":{"solar":600,"grid":250,"battery":150}}
```

Only `solar`, `grid`, `battery` are accepted. Breakdown values are non-negative safe integers and must sum **exactly** to `units`; source-aware `units` and `cost` are positive safe integers. IDs use letters, digits, underscore or hyphen (1–64 characters). Unknown fields and mixed source representations are rejected. Firmware must measure these quantities; backend attribution is device-reported, **not** renewable-origin certification. Battery discharge provenance is not recursively traced.

New source-aware readings check the existing on-chain registry using its actual String ID type. Unknown devices fail closed. The existing `usage_events` WAL database gains nullable source columns and a unique `(meter_id, reading_id)` index. Attribution is stored atomically with the billing event, survives restart and chain failure, and follows the existing durable retry worker. Retransmission of a stable ID does not create a second event or charge; conflicting reuse is rejected. The enriched path is **not** also queued for the legacy batch flush.

`GET /api/meters/:meterId/energy-mix?since=2026-01-01T00:00:00.000Z&until=2026-02-01T00:00:00.000Z`

- Optional UTC ISO timestamps; half-open receipt-time window `[since, until)`, with `since < until <= now`.
- Default: all retained received history through now.
- Returns `units`, `percentages` for solar/grid/battery/**unknown**, totalUnits, readings, hasData, unit and basis.
- Shares are **energy-weighted**, not averaged per reading. Unknown usage stays in the denominator. Empty data has zero shares and `hasData: false`, not a fabricated 100% mix.
- Includes locally received pending/failed billing, not just chain-confirmed energy. It is not a settlement report.
- Existing usage retention/purge removes these source values too. Back up the database and its WAL correctly; run scheduled retention only under an explicit operational policy.

Lightweight `usage_reading_receipts` tombstones survive history purge so an old stable reading cannot be billed again. They are inserted by a SQLite trigger in the same transaction as the usage event. Do not remove these receipts while devices may replay historical IDs.

Frontend: meter-card **View energy mix** links open `/meters/:id/energy`, with an accessible CSS pie chart, exact source table, loading/error/empty states and refresh. This API preserves the project's public usage-read convention; it does not add privacy.

## Opt-in deterministic load balancing (#1038)

**Hardware prerequisite:** no cross-meter transfer firmware, topology or transfer acknowledgement existed in this checkout. This implementation supplies a guarded backend protocol and UI, not a completed physical transfer system. Keep rules disabled until an independently commissioned, interlocked switching controller implements the protocol. The controller must be represented in the existing registry. Never assume geographical proximity implies electrical connectivity, never parallel incompatible circuits, and never map these requests to ordinary relay ON/OFF commands.

### Live telemetry

Registered meters publish **non-retained**, QoS 1 telemetry to `solargrid/meters/{meterId}/telemetry`:

```json
{"version":1,"sequence":42,"loadWatts":950,"available":true}
```

`sequence` is a durable monotonic counter across reboots. Replay/out-of-order messages cannot refresh a meter. Server receipt time is authoritative; load watts are **instantaneous power**, not usage milli-kWh. `available:false`, inactive registry state, missing, future or stale telemetry excludes a meter. Retained telemetry/acks are rejected. MQTT topic ownership must be enforced by broker ACL/TLS/device credentials; registry membership alone does **not** authenticate the publisher.

### Rules and API

Admin APIs accept `X-Admin-Key` or the existing admin session JWT. Invalid credentials now correctly reject rather than fall through. Backend startup requires `ADMIN_API_KEY` as before.

- `GET /api/load-balancing` — configured groups, actual load/freshness and durable last 100 command records/group.
- `PUT /api/load-balancing/rules/:groupId` — strict, validated full policy replacement; IDs must match and all devices must exist in the registry.

```json
{
  "id":"feeder1","enabled":false,"controllerId":"CTRL1",
  "members":[{"meterId":"METER1","capacityWatts":1000},{"meterId":"METER2","capacityWatts":1000}],
  "paths":[{"from":"METER1","to":"METER2"}],
  "overloadRatio":0.9,"targetRatio":0.7,"reserveWatts":100,
  "maxTransferWatts":200,"minTransferWatts":1,
  "staleAfterMs":30000,"ackTimeoutMs":10000,"cooldownMs":60000
}
```

Rules are disabled by default. Capacities and routes are **operator-supplied commissioned constraints**, not device assertions. Unique members (2–20); unique directed paths (1–100); `targetRatio < overloadRatio`; finite positive capacities/max transfer; minimum transfer <= maximum. Stale timeout 1–300 s, ACK timeout 1–60 s, cooldown 1 s–1 h. Backend validates the schema, not electrical safety. The admin dashboard exposes rule JSON with these requirements rather than inventing a topology.

The worker runs every 10 seconds with an in-flight guard. It refreshes registry activation before decisions (registry failure excludes members). It selects highest overload ratio then lowest destination ratio, breaking ties by meter ID. One transfer per group/cycle is floored to integer watts and bounded by source excess to target, destination target minus reserve and current load, and maxTransferWatts. Unresolved meters are reserved across groups. Cooldown and **new post-ack telemetry** are required before reuse; observed loads are never mutated by a plan.

Controllers must publish fresh available telemetry too; a stale/inactive/unavailable controller cannot receive new plans. Pending/unknown work also reserves the controller across groups. Meter-level post-ack cooldown prevents overlapping group policies bypassing the cooldown.

### Control/ack state machine

Existing topic/envelope conventions are retained: `solargrid/meters/{controllerId}/control`, QoS 1, **non-retained**, JSON `cmd`. New command:

```json
{"version":1,"cmd":"LOAD_TRANSFER_REQUEST","commandId":"a UUID","groupId":"feeder1","fromMeterId":"METER1","toMeterId":"METER2","watts":200,"expiresAt":1770000010000,"timestamp":"2026-02-02T02:00:00.000Z"}
```

Controller requirements: persist commandId dedupe across reboots; validate group, destination, circuit interlocks, current measured headroom and expiry at execution; atomically orchestrate safe switching; reject unsupported/unsafe/expired requests; never execute twice on QoS redelivery. Expiry requires bounded synchronized controller time. Only publish `executed` after the **physical** operation has been measured/confirmed. An interlocked central controller is used intentionally: two independent meter ACKs cannot establish safe atomic cross-meter switching.

Reply to `solargrid/meters/{controllerId}/ack`, non-retained:

```json
{"version":1,"commandId":"the exact UUID","status":"executed"}
```

or `status: "rejected"` with optional bounded `reason`.

- Reservation is durable **before** publish: `pending` means requested, not executed.
- Broker PUBACK never means physical execution.
- Matching controller and UUID execution ACK → `acknowledged` (controller-reported execution); rejection → `rejected`.
- Publish error or ACK timeout → `unknown`, not safe-to-retry failure. No automatic re-send/transfer follows.
- Pending/unknown blocks group rule changes and further transfers on involved meters. Late definitive execution/rejection ACK may resolve unknown; duplicates/other controller ACKs do not.
- No UI/API can manually relabel unknown as executed. Operators must inspect hardware/controller and restore authoritative acknowledgement plus fresh telemetry; do not edit database state casually.

### Persistence and deployment

Set `METER_OPERATIONS_DB_PATH` (default `data/meter-operations.sqlite`) to a persistent writable volume. It stores telemetry, policies, load command/ack history and SLA records; it uses the same WAL/busy-timeout pattern as existing stores. Run **one backend bridge instance** per installation; this is not a distributed scheduler/consensus system. Telemetry/probe/report retention is not automatic; size and back up the volume, apply a reviewed retention policy without losing counters or unresolved commands. MQTT access security, TLS, electrical commissioning and controller firmware are deployment prerequisites, not implemented here.

See [SLA.md](../docs/SLA.md) for durable meter performance tracking (#1039), and [PRIVACY.md](../contracts/PRIVACY.md) for the deliberately blocked ZK privacy design (#1040).

## Focused verification

```sh
cd backend
npx tsc --noEmit
npx vitest run tests/energy-mix.integration.test.ts tests/load-balancing.integration.test.ts tests/meter-sla.integration.test.ts tests/meter-operations-api.integration.test.ts tests/mqtt-dedup.integration.test.ts tests/mqtt-webhook.integration.test.ts
```

The tests use temporary/in-memory databases and mocked chain/transport, not real switched loads. Existing legacy bridge duplicate batch billing is outside this feature; the new source-aware path avoids it without rewriting existing billing behavior.
