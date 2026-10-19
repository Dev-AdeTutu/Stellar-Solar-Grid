---
name: Bug Report
about: Report a reproducible bug in Stellar SolarGrid
title: "[Bug] Backend crashes with OOM when processing large usage batch"
labels: bug
assignees: ''
---

## Describe the Bug

When the IoT bridge accumulates 1000+ usage events during MQTT broker downtime, calling `batch_update_usage` causes the backend process to run out of memory and crash with `JavaScript heap out of memory`.

## Steps to Reproduce

1. Stop MQTT broker: `docker compose stop mqtt`
2. Simulate 1500 meter usage updates in SQLite directly
3. Start MQTT broker: `docker compose start mqtt`
4. Backend attempts to process entire batch
5. Observe OOM crash

## Expected Behavior

Large batches should be processed in chunks (e.g., 100 at a time) with memory released between chunks. Add `MAX_BATCH_SIZE` config to limit per-transaction batch size.

## Actual Behavior

Backend attempts to load all 1500 events into memory simultaneously, exhausts heap, and crashes.

```
FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory
```

## Environment

| Field | Value |
|-------|-------|
| Component | backend |
| OS | Ubuntu 22.04 (Docker) |
| Node.js version | 20.14.2 |
| Heap size | Default (512MB in Docker) |
| Network | testnet |

## Additional Context

Consider increasing Node.js heap size (`--max-old-space-size=1024`) as a short-term fix, but batch chunking is the proper solution.
