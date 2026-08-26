---
name: Feature Request
about: Propose a new feature or improvement
title: "[Feature] Add support for multiple Stellar RPC endpoints with failover"
labels: enhancement
assignees: ''
---

## Problem Statement

Backend depends on single Stellar RPC endpoint (`STELLAR_RPC_URL`). If that endpoint goes down or rate-limits requests, the entire platform becomes unavailable.

## Proposed Solution

Support multiple RPC endpoints with automatic failover:

```bash
# .env
STELLAR_RPC_URLS=https://rpc1.stellar.org,https://rpc2.stellar.org,https://rpc3.stellar.org
```

Load balancing strategy:
- Round-robin for normal requests
- Automatic failover on 5xx errors or timeout
- Circuit breaker: Skip unhealthy endpoint for 60 seconds after 3 consecutive failures
- Health check every 30 seconds on failed endpoints
- Log endpoint health status

Fallback priority:
1. Primary RPC (fastest)
2. Secondary RPC (backup)
3. Tertiary RPC (last resort)

## Alternatives Considered

- Single RPC with retry: Still single point of failure
- Proxy/load balancer: Additional infrastructure complexity

## Affected Component(s)

- [ ] Frontend (React / TypeScript)
- [x] Backend / IoT bridge (Node.js)
- [ ] Smart contracts (Soroban / Rust)
- [x] Documentation
- [ ] Other

## Additional Context

Stellar SDK already supports custom Server instances — just need connection pooling logic.
