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

## Grid Outage Detection and Notifications (#976)

Real-time power outage detection engine and notification dispatcher. Implemented in `backend/src/services/outageService.ts` and `backend/src/routes/outages.ts`.

- **Telemetry Monitoring:** Ingests live voltage and frequency readings from IoT smart meters. Power collapse is identified when voltage drops below 50V or frequency drops to 0Hz.
- **Regional Outage Detection:** When multiple meters within the same grid sector/region report collapsed power, an active outage incident is automatically created with estimated restoration time.
- **Push & Email Alerts:** Automatically dispatches alerts to registered emergency contacts and affected users upon outage confirmation.
- **Endpoints:**
  - `GET /api/outages/current` — returns active outages with affected meters and estimated restoration
  - `POST /api/outages` — creates a new outage record
  - `POST /api/outages/telemetry` — inbounds IoT voltage/frequency telemetry and triggers auto-evaluation
  - `GET /api/outages/:id` — returns single outage details
  - `POST /api/outages/:id/resolve` — marks an outage resolved and records resolution timestamp
  - `POST /api/outages/circuits/:meterId/:circuitId` — dispatches MQTT commands to shed/restore individual circuits (#977)

