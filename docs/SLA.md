# Meter performance SLA tracking (#1039)

## Scope and evidence

This is **meter end-to-end service observability**, not a claim that a building has electrical supply or that contractual compensation is owed. It reuses the existing on-chain meter registry, MQTT control envelope, SQLite WAL storage pattern, and registered webhook delivery/retry/logging infrastructure. The existing `/health` endpoint still reports backend RPC/MQTT dependency health; it is not silently reinterpreted as per-meter uptime.

Configured meters require firmware that publishes live `version:1` telemetry and supports `SLA_PING`/`SLA_PONG`. See [backend README](../backend/README.md) for topic ownership, retained-message rejection, and durable telemetry counters. No telemetry means no observed uptime; it is never treated as 100% availability. No response samples/no observed failures means **insufficient data**, not fabricated zero RTT or infinite MTBF.

## Configuration and APIs

Admin auth: `X-Admin-Key: <ADMIN_API_KEY>` or existing login JWT `Authorization: Bearer <session-token>`. Missing secret fails closed; invalid/expired credentials are rejected.

- `PUT /api/meters/:meterId/sla` — full replacement of validated targets; must be a registered meter.
- `GET /api/meters/:meterId/sla` — rolling report, up to 30 hourly historical snapshots and last 100 alerts for the meter.
- `GET /api/sla` — all configured meters, targets, current reports, trends, last 100 installation alerts.

```json
{
  "uptimePct":99.5,
  "responseP95Ms":1000,
  "responseSuccessPct":99,
  "mtbfMs":86400000,
  "heartbeatTimeoutMs":60000,
  "probeTimeoutMs":5000,
  "windowMs":86400000
}
```

All fields have those defaults. Percentages 0–100; response target 0–60,000 ms (exclusive lower bound); positive finite MTBF <= 365 days; heartbeat timeout 1 s–1 h; probe timeout 1–60 s; window 1 min–30 days. Unknown fields, strings-as-numbers, infinities and invalid ranges are rejected. Saving targets begins a **new measurement epoch** at server time; prior stored reports remain unchanged. Review rolling-window duration before changing targets.

The authenticated admin dashboard exposes configuration, uptime, p95 RTT, response success, MTBF, target compliance, accessible hourly trend table and breach/recovery history. `insufficient_data` is displayed explicitly.

## Uptime calculation

Report window is half-open `[max(configuredAt, now - windowMs), now)`.

Each received telemetry observation establishes availability only if **both** `available` and registry `active` were true at receipt. It covers until the earliest of next observation, heartbeat timeout, or window end. Explicit unavailable telemetry closes the previous available interval. Intervals are clipped to the window and merged; missing/stale time is downtime (unobserved availability). Server receipt timestamps, not a device clock, are used.

`uptimePct = 100 × coveredAvailableMilliseconds / elapsedWindowMilliseconds`.

This duration-weighted integration avoids the false accuracy of averaging sparse Boolean samples. A backend outage creates a telemetry gap and therefore lowers **observed end-to-end** uptime; there is no claim that the device itself failed. Initial unobserved time counts as uncovered downtime, but is not an observed online→offline failure transition. After configuration, reports have null report until there is positive elapsed time.

## Failure and MTBF convention

A failure is an observed available interval ending **before** the window end, due to unavailable telemetry or heartbeat silence. Adjacent covered intervals are merged, so normal heartbeats do not create failures. An available interval still open at window end is censored and not a failure.

`mtbfMs = coveredAvailableMilliseconds / observedFailures`.

This is explicitly **mean observed operating time per failure within a rolling window**, not a statistically unbiased lifetime reliability estimate. With zero failures, value is null and compliance `insufficient_data`; never present infinity as a proven SLA. Failure count and uptime/downtime milliseconds are included for auditability. There are no maintenance exclusions or electrical fault labels in this implementation.

## Response measurement (RTT and service quality)

Every 30 seconds at most, configured meters receive non-retained QoS 1:

`solargrid/meters/{meterId}/control`

```json
{"version":1,"cmd":"SLA_PING","probeId":"a UUID","expiresAt":1770000010000}
```

Firmware replies non-retained on `solargrid/meters/{meterId}/ack`:

```json
{"version":1,"cmd":"SLA_PONG","probeId":"the exact UUID"}
```

The backend persists each probe **before** publish and computes RTT from its send time to server receipt of a correlated response. Firmware cannot submit its own claimed latency. ID and meter must match; pre-send, duplicate, late and retained responses are rejected. One pending probe per meter; pending probes within deadline are excluded until there is completed evidence. At timeout, the probe becomes a failed sample. Broker delivery ACK does not count as a meter response.

- p95 is the **nearest-rank 95th percentile of successful probe RTTs**.
- successPct is **successful probes / evaluated probes × 100**, including timeout/transport failures in the denominator. This prevents all-timeout meters appearing compliant solely because no RTT was measured.
- No evaluated samples → both response metrics insufficient data.
- All timeouts → response success breach (when target > 0), p95 remains insufficient data.
- RTT includes backend/broker/network delay, not just firmware processing time. Transport failure attribution is not inferred.

## Durable reports, breach dedupe, and notifications

`METER_OPERATIONS_DB_PATH` defaults to `backend/data/meter-operations.sqlite` when launched from backend. Store it on a persistent writable volume. Observations, probe outcomes, policy epochs, reports, per-metric breach state, and alert history are durable SQLite WAL records.

A non-overlapping 10-second monitoring cycle evaluates rolling performance. First report snapshot per UTC hour is retained (`INSERT OR IGNORE`), carrying the exact target policy and window/metrics used; current API report recalculates from source observations. Trends are snapshots of rolling reports, **not** fixed-hour SLA aggregates.

For each metric, transitions into breach generate one durable `sla_breach`, transition back to measured compliance generates `sla_recovery`. Repeated evaluations/restarts do not create repeat alerts. Insufficient data never falsely recovers a breached metric. Alerts carry unique ID, meter ID, metric, timestamp, targets and report. Initial measured compliance does not generate a recovery event.

Transitions and report history commit atomically before outbound notification. Existing registered webhooks are then invoked once per transition, reusing their timeouts, delivery logs, exponential retries and circuit breaker. **Webhook delivery is best-effort:** the existing retry queue is in memory, not a transactional durable notification outbox; a crash after alert commit/before dispatch can lose outbound notification. The durable alert remains accessible in API/UI and logs. Consumers should dedupe webhook retries using alert ID. Strong exactly-once/outbox guarantees are not claimed.

## Deployment limits and verification

- Run one backend bridge instance; not a distributed monitoring coordinator.
- Broker ACL/TLS and device credentials must bind device publish permissions to their topics. Registry lookup is identity eligibility, not publisher authentication.
- Keep telemetry counters and data persistent across reboots. Pruning observations affects future calculations; preserve at least the longest configured window plus heartbeat timeout and durable last sequence. No automatic prune job is added.
- CPU/budget/mobile proof performance is unrelated to these SLAs. This feature does not benchmark Soroban transaction performance.
- Clock accuracy on backend matters; monitoring uses wall-clock receipt/send times and assumes a synchronized server.
- Focused tests cover clipped intervals, stale gaps, explicit unavailable/inactive states, MTBF censoring, percentile/timeout semantics, probe correlation, validation, target epochs, dedupe/recovery and immutable trends. Integration transport and registry are mocked; physical firmware support still requires deployment validation.

```sh
cd backend
npx vitest run tests/meter-sla.integration.test.ts tests/meter-operations-api.integration.test.ts
```
