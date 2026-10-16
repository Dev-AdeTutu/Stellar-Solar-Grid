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

## Energy Consumption Gamification (#996)

Achievements, leaderboards and monthly challenges reward users for saving energy.

- `GET /api/achievements` — the achievement catalogue, or (with `?address=`) each
  achievement annotated with `unlockedAt`. Achievements are evaluated from a
  profile's linked meters and include `peak_avoider` (80%+ of usage outside
  peak hours), `seven_day_saver` (usage fell week-over-week) and
  `solar_champion` (reached #1 on the green-energy leaderboard).
- `GET /api/leaderboards?board=green|trader&region=&limit=` — the global
  leaderboard for a board, or (with `?region=`, green board only) the top
  savers in that region. A profile's region is set via
  `PUT /api/social/profiles/:address` (`region` field).
- Monthly challenges with XLM prizes are served by `/api/competitions`
  (#903) — see its endpoints for joining and tracking standings.
- The underlying profile/achievement/leaderboard store is `/api/social`; the
  routes above are thin, purpose-built views over the same data.

## SMS Notifications (#997)

Users without a smartphone or reliable data connection can opt in to SMS
alerts for low balance, payments received and meter issues.

- `GET /api/users/sms-preferences?phone=` — opted-in events for a phone
  number (E.164, e.g. `+2348012345678`). Every event defaults to **disabled**
  until the user opts in.
- `POST /api/users/sms-preferences` — `{ phone, preferences: { low_balance?, payment_received?, meter_issue? } }`.
- `POST /api/sms-notifications/send` (`X-Admin-Key`) — `{ phone, event, message }`.
  Respects the user's opt-in and a per-phone daily cap (`SMS_MAX_PER_DAY`,
  default 5) so a misbehaving caller can't run up the provider bill.

Set `SMS_PROVIDER` to `twilio` (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
`TWILIO_FROM_NUMBER`), `africastalking` (`AFRICASTALKING_API_KEY`,
`AFRICASTALKING_USERNAME`, `AFRICASTALKING_FROM`), or `log` (default; logs
instead of sending — useful in dev/tests).

## Meter Lifespan & Depreciation (#998)

Tracks each meter's installation date and expected lifespan for asset
management and replacement planning.

- `POST /api/meters/:meterId/asset-info` — `{ installedAt?, expectedLifespanYears?, purchaseCostStroops? }`.
  `installedAt` defaults to now and `expectedLifespanYears` defaults to 15
  (`METER_DEFAULT_LIFESPAN_YEARS`) when first registered.
- `GET /api/meters/:meterId/asset-info` — age, remaining lifespan, straight-line
  depreciation percentage, depreciated book value (when a purchase cost was
  recorded), and `nearEndOfLife` (true within `METER_END_OF_LIFE_WARNING_YEARS`,
  default 1 year, of the end of the expected lifespan).
- `GET /api/meters/asset-info/report` (`X-Admin-Key`) — fleet-wide summary:
  meter count, average age/depreciation, meters nearing end of life (soonest
  first), and total depreciated book value.

A background monitor logs a warning once per check interval for every meter
that has entered its end-of-life warning window.
