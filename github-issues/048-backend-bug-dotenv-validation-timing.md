---
name: Bug Report
about: Report a reproducible bug in Stellar SolarGrid
title: "[Bug] Environment validation runs after services start"
labels: bug
assignees: ''
---

## Describe the Bug

The `env-check` service in docker-compose validates environment variables but other services (backend, mqtt) start simultaneously. If env validation fails, backend is already partially initialized and may be in inconsistent state.

## Steps to Reproduce

1. Start services with missing required env var: `docker compose up`
2. Observe `env-check` fails with validation error
3. Observe `backend` service already started and tried connecting to RPC
4. Backend logs show cryptic errors instead of clear "missing env var" message

## Expected Behavior

Env validation should run and complete BEFORE backend starts. Use Docker Compose `depends_on` with `condition: service_completed_successfully`:

```yaml
backend:
  depends_on:
    env-check:
      condition: service_completed_successfully
```

## Actual Behavior

Services start in parallel. Env check failure doesn't prevent backend startup.

## Environment

| Field | Value |
|-------|-------|
| Component | backend |
| OS | Ubuntu 22.04 (Docker) |
| Docker Compose version | 2.24.0 |
| Network | testnet |

## Additional Context

The `env-check` service should exit 0 on success, non-zero on failure for proper condition checking.
