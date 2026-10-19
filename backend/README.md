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

## Grid stability and meter geofencing (#1016/#1017)

Frequency telemetry can be published by meters on `solargrid/meters/{meterId}/frequency` with `{ "frequencyHz": 49.8, "loadKw": 2.4 }`. The bridge applies the 50 Hz threshold response and sends a relay command without routing the message through billing. HTTP equivalents are `POST /api/grid-services/frequency/readings`, `POST /api/grid-services/frequency/contributions`, and `GET /api/grid-services/frequency/:meterId/summary`.

GPS modules publish `{ "latitude": 6.5244, "longitude": 3.3792 }` on `solargrid/meters/{meterId}/location`. The backend compares the report with the registered haversine geofence and records a `LocationVerificationFailed` result when it is outside the permitted radius. Out-of-fence meters are automatically disabled for fraud review.

- `POST /api/grid-services/geofences` — register the expected location and radius
- `POST /api/grid-services/geofences/verify` — submit a periodic GPS reading
- `GET /api/grid-services/geofences/:meterId` — status and verification history
- `GET /api/grid-services/geofences` — data for the frontend map

## Automated Billing Cycle Management (#971)

Tracks recurring billing cycles for meters, issues notifications, and processes invoices upon cycle close:
- Configurable cycle durations (default 30 days) per meter.
- Advance reminder email notifications at 7, 3, and 1 day before billing cycle ends.
- Automated generation of invoice records and rollover of next billing date when current cycle closes.
- Endpoints:
  - `GET /api/meters/:id/billing-history` — retrieve historical invoices and current cycle state.

## Carbon Footprint Calculator (#972)

Calculates carbon emissions saved from solar generation against regional grid emission factors:
- Converts kWh generated into kg CO2 offset, equivalent trees planted, and passenger car miles avoided.
- Provides monthly and yearly breakdown along with shareable impact badge metadata.
- Endpoints:
  - `GET /api/meters/:id/carbon-footprint` — detailed carbon metrics and equivalence data.

## Dynamic Pricing Engine (#973)

Allows responsive pricing adjustments based on real-time grid demand:
- Admin configuration for pricing multiplier (`POST /api/pricing/multiplier`).
- Automatically emits `PriceUpdated` events on changes.
- Syncs with on-chain dynamic pricing parameters.

## Meter Performance Benchmarking (#974)

Compares individual meter efficiency and output against peer groups:
- Peer group segmentation by capacity tier (residential, commercial, industrial) and location type (urban, suburban, rural).
- Performance scoring (0–100 scale), efficiency percentile ranking, and actionable peer comparison insights.
- Endpoints:
  - `GET /api/meters/:id/benchmark` — retrieve peer group benchmark statistics and percentile ranks.

