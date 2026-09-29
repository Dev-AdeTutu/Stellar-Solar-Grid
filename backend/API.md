# Issue #886: Global Rate Limiting

Every request is charged to an IP-based fixed-window quota before JSON parsing. If a valid `X-API-Key` is present, the owning provider is also charged to a tier quota based on the key's `read`, `write`, or `admin` permission. The tighter payment and write limiters remain in force for their routes.

Configure `RATE_LIMIT_WINDOW_MS` and `RATE_LIMIT_MAX` for the shared IP quota, and `RATE_LIMIT_USER_READ_MAX`, `RATE_LIMIT_USER_WRITE_MAX`, and `RATE_LIMIT_USER_ADMIN_MAX` for provider quotas. Configure `REDIS_URL` to share atomic counters across replicas; without Redis the backend falls back to a bounded process-local store. `TRUST_PROXY_HOPS` must match the trusted proxy chain or clients may be misidentified. Responses include `X-RateLimit-*`, `RateLimit-*`, and `Retry-After` headers; CORS exposes those headers to browser clients.

# Issue #882: Email Notifications

`POST /api/email-notifications/price-alert` sends an admin-triggered price alert. Billing notifications are emitted for successful meter payments and generated bills, and low-balance email notifications use the meter's billing account address. `GET /api/email-notifications/manage?token=...` offers per-event controls; signed tokens are linked in delivered messages. `GET /api/email-notifications/unsubscribe?token=...` displays a confirmation page and the subsequent form POST unsubscribes from all email categories.

Set `EMAIL_PROVIDER` to `resend`, `sendgrid`, or `log`, and configure the corresponding provider API key, `EMAIL_FROM`, `EMAIL_PREFERENCES_SECRET`, and `EMAIL_PREFERENCES_BASE_URL`. The log provider does not deliver mail. Delivery rates are provider/deployment dependent and must be measured from provider events; the application cannot guarantee a 95% deliverability rate by itself.

# Issue #885: Grid Stability

Device voltage and frequency readings are accepted over `solargrid/devices/{deviceId}/telemetry`, HTTP `POST /api/devices/:id/performance`, and GraphQL `recordDevicePerformance`. `GET /api/devices/:id/stability?days=7` returns the measured-readings stability score and historical anomalies. Anomalies are persisted and sent to device-owner webhooks with a per-device/metric 15-minute alert cooldown. Set `GRID_VOLTAGE_MIN_V`, `GRID_VOLTAGE_MAX_V`, `GRID_FREQUENCY_MIN_HZ`, and `GRID_FREQUENCY_MAX_HZ` to match the local grid standard.
# Backend API

This document describes the backend HTTP API surface.

## Energy Grid Simulation Tool (#909)

The simulation tool lets operators test grid scenarios, inspect grid state,
run what-if analyses, and generate impact reports for capacity planning.

### Simulation engine

`POST /api/grid/simulate`

Runs a simulation for a given scenario and returns the resulting grid state.

Request body:

```json
{
  "scenario": {
    "name": "peak-summer-demand",
    "durationHours": 24,
    "stepMinutes": 15,
    "nodes": [
      { "id": "gen-1", "type": "generator", "capacityMw": 500, "outputMw": 420 },
      { "id": "load-1", "type": "load", "demandMw": 380 }
    ],
    "links": [
      { "from": "gen-1", "to": "load-1", "capacityMw": 600 }
    ]
  }
}
```

Response body:

```json
{
  "scenarioId": "peak-summer-demand",
  "status": "ok",
  "steps": [
    {
      "t": 0,
      "nodes": [
        { "id": "gen-1", "outputMw": 420, "utilization": 0.84 },
        { "id": "load-1", "demandMw": 380, "served": true }
      ],
      "links": [
        { "from": "gen-1", "to": "load-1", "flowMw": 380, "utilization": 0.63 }
      ]
    }
  ],
  "summary": {
    "peakDemandMw": 380,
    "unservedMw": 0,
    "overloadedLinks": []
  }
}
```

### Scenario builder

`POST /api/grid/scenarios`

Creates a reusable scenario definition. The body accepts the same `scenario`
object as the simulate endpoint.

`GET /api/grid/scenarios` — list saved scenarios.

`GET /api/grid/scenarios/{id}` — fetch a single scenario.

`PUT /api/grid/scenarios/{id}` — update a scenario.

`DELETE /api/grid/scenarios/{id}` — remove a scenario.

### Visualization

`GET /api/grid/scenarios/{id}/state`

Returns the latest simulated grid state as a render-ready payload for the
frontend (nodes with positions/status and links with flow values).

```json
{
  "scenarioId": "peak-summer-demand",
  "nodes": [
    { "id": "gen-1", "type": "generator", "status": "nominal", "utilization": 0.84 },
    { "id": "load-1", "type": "load", "status": "served", "utilization": 0.63 }
  ],
  "links": [
    { "from": "gen-1", "to": "load-1", "flowMw": 380, "status": "nominal" }
  ]
}
```

### What-if analysis

`POST /api/grid/scenarios/{id}/what-if`

Applies one or more overrides to a scenario and returns the delta against the
baseline simulation.

Request body:

```json
{
  "overrides": [
    { "nodeId": "gen-1", "field": "outputMw", "value": 300 },
    { "nodeId": "load-1", "field": "demandMw", "value": 450 }
  ]
}
```

Response body:

```json
{
  "baseline": { "unservedMw": 0, "peakDemandMw": 380 },
  "modified": { "unservedMw": 70, "peakDemandMw": 450 },
  "delta": { "unservedMw": 70, "peakDemandMw": 70 }
}
```

### Report generation

`POST /api/grid/scenarios/{id}/report`

Generates an impact report for a scenario (optionally with what-if overrides)
for capacity planning.

Request body:

```json
{
  "format": "json",
  "overrides": []
}
```

Response body:

```json
{
  "scenarioId": "peak-summer-demand",
  "generatedAt": "2024-01-01T00:00:00Z",
  "impact": {
    "peakDemandMw": 380,
    "unservedMw": 0,
    "overloadedLinks": [],
    "headroomMw": 120
  },
  "recommendations": [
    "Generator gen-1 has 16% headroom at peak demand."
  ]
}
```


## API Key Management (#833)

Providers can create API keys for programmatic access. Keys are stored as
SHA-256 hashes (`api_keys` table: `id`, `provider_id`, `key_hash`,
`permissions`, `expires_at`, `revoked_at`, …); the plaintext key is returned
only once. Management routes require `X-Admin-Key` and `X-Provider-Id`.

### `POST /api/keys/generate`

Body: `{ "name"?: string, "permissions"?: ("read"|"write"|"admin")[], "expiresInDays"?: number }`

`201` → `{ "key": "sg_…", "id": "…", "provider_id": "…", "permissions": ["read"], "expires_at": null, … }`

### `GET /api/keys`

Lists the provider's keys (no secrets): `{ "keys": [ … ] }`

### `DELETE /api/keys/:keyId`

Revokes a key. `204` on success, `404` if not found.

### Authenticating with a key

Send the key in the `X-API-Key` header. Routes protected with the
`requireApiKey(permission?)` middleware respond `401` for missing, invalid,
expired or revoked keys and `403` if the key lacks the required permission
(`admin` implies all permissions).

## Usage Prediction (#835)

### `GET /api/meters/:meterId/prediction`

Estimates when the meter balance will reach zero. A linear regression is fit
to the meter's daily usage cost over the last 30 days and projected forward.
Predictions are cached and refreshed daily (or when the balance changes).
The balance is read from the contract unless `?balance=<stroops>` is given.

```json
{
  "meterId": "METER1",
  "balance": 3000,
  "estimatedDaysRemaining": 30.0,
  "confidenceInterval": { "low": 25.4, "high": 36.1, "level": 0.95 },
  "avgDailyUsage": 100,
  "trendPerDay": 0.1,
  "trainingDays": 30,
  "generatedAt": "2026-09-25T00:00:00.000Z"
}
```

`estimatedDaysRemaining` is `null` when there is no usage history or usage is
not trending toward depletion.

## Widget Summary (#901)

### `GET /api/widgets/summary?meterId=<id>`

A compact payload (under 1 KB) for the iOS and Android home-screen widgets. It is cached for 5 minutes and served with
an `ETag`, so send `If-None-Match` to get a `304` when nothing has changed. See `docs/MOBILE_WIDGETS.md`.

```json
{
  "meterId": "METER1",
  "active": true,
  "balanceXlm": 12.5,
  "todayUnits": 3.2,
  "last7DaysUnits": [4.1, 3.9, 5.0, 4.4, 3.8, 4.0, 3.2],
  "daysRemaining": 3.1,
  "updatedAt": "2026-09-27T10:00:00.000Z"
}
```

## Monthly Bills (#902)

Bills are generated on the 1st of each month, emailed as PDFs with a payment link, and kept as a permanent history.
Endpoints live under `/api/billing`. See `docs/BILLING.md`.

## Competitions (#903)

Monthly efficiency, trading and green-energy competitions with live SSE leaderboards and automatic prize payouts.
Endpoints live under `/api/competitions`. See `docs/COMPETITIONS.md`.

## Smart Home (#904)

Google Home and Alexa account linking (OAuth 2.0), device fulfillment, energy routines and privacy controls. Endpoints
live under `/api/smart-home`. See `docs/SMART_HOME.md`.
