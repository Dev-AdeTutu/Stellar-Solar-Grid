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

### Live energy flow (#870)

- `GET /api/widgets/energy?meterId=<id>&range=5m|hourly|daily` returns up to 12 five-minute,
  24 hourly, or 7 daily production/consumption buckets.
- `WS /api/widgets/live?meterId=<id>&range=5m|hourly|daily` sends an initial snapshot and
  refreshes every five seconds. The frontend reconnects with capped exponential backoff and
  polls the HTTP route while disconnected.
- Consumption comes from meter usage events. Production comes from active linked solar-panel
  device telemetry (`energyKwh`, or power integrated over the bucket).

## Energy Trading Simulator (#929)

Practice-only cash and energy balances are stored separately from on-chain accounts. The
simulator verifies that the supplied Stellar wallet owns its meter before account reads/trades.
The market feed defaults to `energy-charts.info` for bidding zone `DE-LU`; set
`ENERGY_MARKET_DATA_URL`, `ENERGY_MARKET_BIDDING_ZONE`, and
`MARKET_PRICE_FALLBACK_EUR_KWH` to configure the feed and offline quote.

- `GET /api/simulator/market?hours=24` returns historical/current EUR-per-kWh quotes and the
  configured practice fee rate.
- `GET /api/simulator/account?meterId=<id>&stellarAddress=<G...>` returns the virtual account
  and recent practice trades.
- `POST /api/simulator/trade` accepts `{ meterId, stellarAddress, side, quantityKwh }`.
- `GET /api/simulator/leaderboard?limit=20` returns anonymized portfolio rankings.

Accounts start with `SIMULATOR_STARTING_CREDITS` (default 1,000); the default virtual trade fee
is 0.5%. Simulator transactions never call the Stellar contract.

## Energy Theft Detection (#931)

The backend scans newly recorded usage at `THEFT_SCAN_INTERVAL_MS` (default one minute) and
compares readings with a robust per-meter median/MAD baseline. Alerts are persisted once per
usage event and sent to registered provider webhooks immediately after detection. The default
threshold is intentionally conservative; the monthly report tracks investigated false positives
so providers can validate the under-5% target against their own metering population.

All theft routes require the existing admin session or `X-Admin-Key` credential:

- `GET /api/theft/alerts?status=open&limit=50&offset=0`
- `GET /api/theft/alerts/:id/investigation`
- `PATCH /api/theft/alerts/:id/investigation` with `{ status, assignedTo?, note?, actor? }`
- `GET /api/theft/reports/monthly?month=YYYY-MM` generates and stores the selected monthly report.

## Monthly Bills (#902)

Bills are generated on the 1st of each month, emailed as PDFs with a payment link, and kept as a permanent history.
Endpoints live under `/api/billing`. See `docs/BILLING.md`.

## Competitions (#903)

Monthly efficiency, trading and green-energy competitions with live SSE leaderboards and automatic prize payouts.
Endpoints live under `/api/competitions`. See `docs/COMPETITIONS.md`.

## Smart Home (#904)

Google Home and Alexa account linking (OAuth 2.0), device fulfillment, energy routines and privacy controls. Endpoints
live under `/api/smart-home`. See `docs/SMART_HOME.md`.
