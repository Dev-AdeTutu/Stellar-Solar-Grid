---
name: Bug Report
about: Report a reproducible bug in Stellar SolarGrid
title: "[Bug] Prometheus counter increments are lost under high concurrency"
labels: bug
assignees: ''
---

## Describe the Bug

Under load testing (100 req/s), Prometheus counters like `mqtt_messages_total` show counts lower than actual messages processed. This indicates race conditions in metric increment operations.

## Steps to Reproduce

1. Start load test: `ab -n 10000 -c 100 http://localhost:3001/api/stats`
2. Simultaneously publish 5000 MQTT messages
3. Query Prometheus metrics endpoint
4. Compare `mqtt_messages_total` with actual MQTT publish count
5. Observe metrics show ~4800 instead of 5000

## Expected Behavior

All counter increments should be atomic and accurately reflect actual operations, even under high concurrency.

## Actual Behavior

Some increments are lost due to non-atomic read-modify-write operations on shared counter state.

## Screenshots / Logs

```typescript
// Potential issue in metrics.ts:
let mqttCount = 0;
export const incrementMqtt = () => { mqttCount++; }; // Non-atomic
```

## Environment

| Field | Value |
|-------|-------|
| Component | backend |
| OS | Ubuntu 22.04 |
| Node.js version | 20.14.2 |
| prom-client version | 15.1.3 |
| Network | testnet |

## Additional Context

Use prom-client's native counter methods which are atomic: `counter.inc(1)` instead of manual incrementing.
