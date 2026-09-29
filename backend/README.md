# Backend

This directory contains the backend services for the project.

## API Response Caching

The backend uses Redis as a caching layer to reduce RPC calls and improve API response times for frequently accessed data.

### Configuration

Redis caching is configured through environment variables:

| Variable | Description | Default |
| --- | --- | --- |
| `REDIS_URL` | Redis connection URL used by the cache client | `redis://127.0.0.1:6379` |
| `CACHE_METER_TTL_SECONDS` | TTL (in seconds) for cached meter data | `300` (5 minutes) |
| `CACHE_USAGE_HISTORY_TTL_SECONDS` | TTL (in seconds) for cached usage history | `3600` (1 hour) |

### Cached Data

- **Meter data** — cached with a 5-minute TTL (`CACHE_METER_TTL_SECONDS`).
- **Usage history** — cached with a 1-hour TTL (`CACHE_USAGE_HISTORY_TTL_SECONDS`).

### Cache Invalidation

Cached entries are invalidated on mutations so reads never serve stale data:

- **Payments** — payment mutations invalidate the affected meter and usage history cache entries.
- **Usage updates** — usage mutations invalidate the affected meter and usage history cache entries.

### Tests

Caching logic (TTL handling and invalidation on mutations) is covered by the backend test suite.

## Meter Health Monitoring (#834)

Meters publish periodic heartbeats to `solargrid/meters/{meterId}/heartbeat`
(optional JSON payload `{ "responseTimeMs": 120, "error": false }`), or POST to
`/api/meters/:meterId/heartbeat`. The backend tracks the last heartbeat,
average response time, error rate and uptime per meter.

| Status  | Condition                                                        |
|---------|------------------------------------------------------------------|
| 🟢 green  | Heartbeat within the last hour and error rate < 10%            |
| 🟡 yellow | No heartbeat for > 1 hour, or error rate ≥ 10%                 |
| 🔴 red    | No heartbeat for 24 hours — an alert is logged once per outage |

Endpoints:

- `GET /api/meters/health` — dashboard of all meters plus a `{ green, yellow, red }` summary
- `GET /api/meters/:meterId/health` — health of a single meter
- `POST /api/meters/:meterId/heartbeat` — record a heartbeat over HTTP

Tunables: `HEALTH_YELLOW_AFTER_MS`, `HEALTH_RED_AFTER_MS`, `HEARTBEAT_INTERVAL_MS`.
