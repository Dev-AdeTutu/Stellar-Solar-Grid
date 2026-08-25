---
name: Feature Request
about: Propose a new feature or improvement
title: "[Feature] Add detailed health check endpoint with dependencies status"
labels: enhancement
assignees: ''
---

## Problem Statement

The current `/health` endpoint only returns basic status. Operations teams need visibility into the health of each backend dependency (Stellar RPC, MQTT broker, SQLite database) for effective monitoring and alerting.

## Proposed Solution

Enhance `GET /health` to return structured health data:

```json
{
  "status": "healthy|degraded|unhealthy",
  "timestamp": "2025-08-25T10:30:00Z",
  "uptime": 86400,
  "checks": {
    "stellar_rpc": { "status": "up", "latency_ms": 120 },
    "mqtt_broker": { "status": "up", "connected": true },
    "database": { "status": "up", "size_mb": 15.2 },
    "contract": { "status": "up", "last_call": "2025-08-25T10:29:45Z" }
  },
  "deadLetterEvents": 3
}
```

Return HTTP 503 if any critical check fails, 200 if all pass, 207 if degraded.

## Alternatives Considered

- Separate endpoints per service: More complex client logic
- Prometheus metrics only: Not all tools support Prometheus

## Affected Component(s)

- [ ] Frontend (React / TypeScript)
- [x] Backend / IoT bridge (Node.js)
- [ ] Smart contracts (Soroban / Rust)
- [x] Documentation
- [ ] Other

## Additional Context

Should be compatible with Kubernetes liveness/readiness probes and standard health check protocols.
