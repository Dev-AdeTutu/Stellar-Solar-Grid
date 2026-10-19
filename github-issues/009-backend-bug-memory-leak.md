---
name: Bug Report
about: Report a reproducible bug in Stellar SolarGrid
title: "[Bug] Memory leak in idempotency cache"
labels: bug
assignees: ''
---

## Describe the Bug

The payment idempotency cache grows indefinitely. While entries have a 24-hour TTL, there's no active eviction mechanism. Over time, this leads to increasing memory consumption in long-running backend instances.

## Steps to Reproduce

1. Start backend with `npm run dev`
2. Make 10,000 payment requests with unique idempotency keys
3. Monitor memory usage with `process.memoryUsage()`
4. Wait 25 hours (past TTL)
5. Observe memory is not freed despite expired entries

## Expected Behavior

Expired cache entries should be automatically evicted, either:
- On-demand during cache access (lazy eviction)
- Via periodic cleanup interval (e.g., every hour)
- Using an LRU eviction policy with size cap

## Actual Behavior

Memory usage grows continuously. The cache Map never shrinks even after entries expire.

## Screenshots / Logs

```
Initial heap: 45 MB
After 10k payments: 127 MB
After 25 hours: 127 MB (no decrease)
```

## Environment

| Field | Value |
|-------|-------|
| Component | backend |
| OS | Ubuntu 22.04 (Docker) |
| Node.js version | 20.14.2 |
| Network | testnet |

## Additional Context

Consider using a dedicated caching library like `node-cache` or `lru-cache` with built-in TTL and max-size eviction.
