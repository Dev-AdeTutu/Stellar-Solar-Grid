# Docker Setup

Run the entire platform locally with Docker Compose:
# SolarGrid Backend API

## Development with Docker Compose

### Quick Start

Spin up the full development stack (backend + MQTT broker) with:

```bash
docker-compose up --build
```

Services:

- **Backend**: Express API server + IoT Bridge (`http://localhost:3001`)
- **Frontend**: Next.js dashboard (`http://localhost:3000`)
- **MQTT**: Eclipse Mosquitto MQTT broker (`mqtt://localhost:1883`)

To stop:
This will:

- Build and start the Node.js backend on port 3001
- Start an MQTT broker (Eclipse Mosquitto) on ports 1883 (MQTT) and 9001 (WebSocket)
- Configure the backend to connect to the MQTT broker automatically

### Environment Configuration

Copy `.env.example` to `.env` and update the values:

```bash
cp backend/.env.example backend/.env
# Edit backend/.env with your configuration
```

The `MQTT_BROKER` is pre-configured to `mqtt://mqtt:1883` for Docker Compose networking.

### Stopping the Stack

```bash
docker-compose down
```

To also remove volumes (e.g., for a clean restart):

```bash
docker-compose down -v
```

## Idempotency

Payment endpoints support the `Idempotency-Key` header to prevent duplicate submissions on network retries.
## Payments

### `POST /api/payments`

Submit a payment for a meter.

**Headers**

| Header            | Required | Description                                |
| ----------------- | -------- | ------------------------------------------ |
| `Idempotency-Key` | No       | Unique client-generated key (e.g. UUID v4) |

**Body**

```json
{
  "meterId": "METER1",
  "amount": 5000000,
  "payer": "G..."
}
```

**Behaviour**

- If `Idempotency-Key` is provided and a successful response for that key exists in the cache (within 24 h), the cached `{ hash }` is returned immediately — no duplicate contract call is made.
- Cache entries expire after 24 hours.
- Expired entries are evicted lazily on the next write.

  "payer": "G...",
  "amount": 5000000
}
```

**Response**

```json
{ "hash": "<transaction-hash>" }
```

## Low-Balance Webhook Notifications

Providers can register webhook URLs to receive notifications when a customer's meter balance drops below a configurable threshold.
**Idempotency**

`POST /api/payments` supports the `Idempotency-Key` header. Provide a unique,
client-generated key (UUID v4 recommended) per logical payment attempt. The
server caches the response for 24 hours keyed to that value. Any retry
carrying the same key within that window receives the original response
without re-invoking the on-chain contract — preventing duplicate money
movement on network-level retries or multi-device submissions.

| Header            | Required | Description                                      |
|-------------------|----------|--------------------------------------------------|
| `Idempotency-Key` | No       | Opaque string, max recommended length 128 chars  |

**Behaviour**

- **First request** — processed normally; response cached for 24 h.
- **Repeat key (hit)** — cached response returned immediately with
  `X-Idempotent-Replayed: true`; no contract call is made.
- **Concurrent duplicate** — if the first request is still in-flight, the
  second returns `409 Conflict` with code `IDEMPOTENCY_CONFLICT`.
- **5xx responses** — not cached; the client may safely retry with the same
  key after a transient server error.
- **No header** — request is processed normally with no idempotency guarantee
  (backwards-compatible).

**Example**

```http
POST /api/payments
Content-Type: application/json
Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000

{
  "meterId": "METER1",
  "payer": "G...",
  "amount": 5000000
}
```

Replayed response includes:

```http
HTTP/1.1 200 OK
X-Idempotent-Replayed: true

{ "hash": "<original-transaction-hash>" }
```

### `GET /api/payments/:address`

Fetch paginated on-chain payment history for a Stellar address. Queries
Soroban contract events for `make_payment` calls where `payer === address`,
scoped to a rolling time window.

**Path parameter**

| Parameter | Description                              |
|-----------|------------------------------------------|
| `address` | Valid 56-character Stellar public key    |

**Query parameters**

| Parameter | Type    | Default | Range / Values   | Description                                      |
|-----------|---------|---------|------------------|--------------------------------------------------|
| `page`    | integer | `1`     | ≥ 1              | Page number                                      |
| `limit`   | integer | `10`    | 1 – 50           | Records per page (capped at 50)                  |
| `sort`    | string  | `desc`  | `asc` \| `desc`  | Sort order by payment date                       |
| `days`    | integer | `30`    | 1 – 90           | Rolling window in days to query events (max 90)  |

**Response `200`**

```json
{
  "payments": [
    {
      "txHash": "<transaction-hash>",
      "date": "2025-05-27T10:30:00.000Z",
      "meterId": "METER1",
      "amountXlm": 0.5,
      "plan": "Daily"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 10,
    "total": 42,
    "pages": 5
  }
}
```

**Error responses**

| Status | Code        | Reason                                     |
|--------|-------------|--------------------------------------------|
| `400`  | —           | Address is missing or not a valid Stellar key |
| `502`  | `RPC_ERROR` | Soroban RPC unreachable                    |
| `500`  | —           | Unexpected server error                    |

**Example**

```http
GET /api/payments/GBRPYHIL2CI3FNV4HLWFIL45TEOZT5MVCTOFKH2UBIJBPQESELUBX4?page=1&limit=10&sort=desc&days=30
```

---

## Low-Balance Webhook Notifications

Providers can register webhook URLs to receive notifications when a customer's meter balance drops below a configurable threshold.

### Configuration

Set the following environment variables:

| Variable                | Required | Default | Description                                    |
| ----------------------- | -------- | ------- | ---------------------------------------------- |
| `PROVIDER_WEBHOOK_URL`  | No       | -       | Webhook endpoint URL for low-balance alerts    |
| `LOW_BALANCE_THRESHOLD` | No       | 1000000 | Balance threshold in stroops (0.1 XLM default) |
| `WEBHOOK_SECRET`        | No       | -       | Fallback HMAC signing secret used when a webhook has no per-provider secret registered |

### Register Webhook Endpoint

**`POST /api/webhooks/low-balance`**

Register or update the webhook URL for low-balance notifications. Requires
admin authentication via the `X-Admin-Key` header (same admin key used by
`/api/collaborators`).

**Headers**

| Header        | Required | Description                          |
| ------------- | -------- | ------------------------------------ |
| `X-Admin-Key` | Yes      | Must match the server's `ADMIN_API_KEY` |

**Body**

```json
{
  "webhook_url": "https://your-service.com/webhooks/low-balance",
  "secret": "optional-signing-secret-min-16-chars"
}
```

`secret` is optional. If omitted, the server generates a random one for you.

**Response**

```json
{
  "message": "Webhook registered successfully",
  "webhook_url": "https://your-service.com/webhooks/low-balance",
  "provider_id": "provider-123",
  "id": 1,
  "created_at": "2025-05-27T10:30:00.000Z",
  "secret": "5f2c...e91a",
  "secret_notice": "Store this secret now — it will not be shown again. Use it to verify the X-Signature-256 header on inbound deliveries."
}
```

`secret` is returned **only in this response**. It is never exposed again by
`GET /api/webhooks` or any other endpoint — store it securely.

A request without a valid `X-Admin-Key` header returns `401 Unauthorized`.

### Webhook Payload

When a meter's balance drops below the threshold after a usage update, the bridge fires a POST request to the registered webhook URL.

**Payload**

```json
{
  "event": "low_balance",
  "meter_id": "METER123",
  "balance": 500000,
  "threshold": 1000000,
  "timestamp": "2025-05-27T10:30:00.000Z"
}
```

**Fields**

| Field       | Type   | Description                      |
| ----------- | ------ | -------------------------------- |
| `event`     | string | Always `"low_balance"`           |
| `meter_id`  | string | The meter identifier             |
| `balance`   | number | Current meter balance in stroops |
| `threshold` | number | Configured threshold in stroops  |
| `timestamp` | string | ISO 8601 timestamp of the event  |

**Error Handling**

- Failed webhook calls are logged but do not crash the IoT bridge
- Webhook timeouts can be configured via your HTTP client settings
- Consider idempotency keys on your webhook endpoint to handle retries

### Verifying the Webhook Signature

Every outbound webhook request carries an `X-Signature-256` header:

```
X-Signature-256: sha256=<hex-encoded HMAC-SHA256 of the raw request body>
```

The signature is computed as `HMAC-SHA256(secret, rawBody)`, where `secret`
is either the per-webhook secret returned when you registered the URL, or
the server's `WEBHOOK_SECRET` env var if no per-webhook secret was set.

Verify it on your endpoint before trusting the payload (Node.js example):

```typescript
import crypto from "node:crypto";

function verifySolarGridWebhook(rawBody: string, signatureHeader: string, secret: string): boolean {
  const expected =
    "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signatureHeader);
  if (expectedBuf.length !== actualBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}
```

Always compare against the **raw** (unparsed) request body — re-serializing
parsed JSON can reorder keys or change whitespace and break the comparison.
Reject requests with a missing or invalid signature with `401`.

---

## Statistics

### `GET /api/stats`

Returns contract-derived aggregate statistics for all meters.

Response is cached for **30 seconds** to reduce RPC load.

**Response**

```json
{
  "totalMeters": 42,
  "activeMeters": 37,
  "totalUnits": 182400,
  "totalRevenue": 12500000
}
```

| Field | Type | Description |
|---|---|---|
| `totalMeters` | number | Total registered meters on-chain |
| `activeMeters` | number | Meters currently active |
| `totalUnits` | number | Total energy units consumed across all meters |
| `totalRevenue` | number | Provider revenue in stroops |

| Status | Description |
|---|---|
| 200 | Returns aggregate stats |
| 500 | RPC or contract error |

---

### `GET /api/stats/summary`

Returns a JSON snapshot of the four core Prometheus counters/gauges for the admin dashboard.
Does **not** require Prometheus or Grafana to be running.

Response is cached for **15 seconds**.

**Response**

```json
{
  "mqttMessages": 1024,
  "contractCalls": 256,
  "activeMeters": 37,
  "paymentVolumeXlm": 5.25
}
```

| Field | Type | Description |
|---|---|---|
| `mqttMessages` | number | Total MQTT messages received since process start |
| `contractCalls` | number | Total Soroban contract invocations since process start |
| `activeMeters` | number | Current active meter gauge |
| `paymentVolumeXlm` | number | Cumulative payment volume in XLM |

| Status | Description |
|---|---|
| 200 | Returns metrics snapshot |

---

## Energy Provider

These endpoints expose provider-specific data and are all protected by the
`X-Admin-Key` header.

### `GET /api/provider`

Returns the energy provider's on-chain revenue and an aggregate summary of all meters.

Response is cached for **30 seconds**.

**Headers**

| Header | Required | Description |
|---|---|---|
| `X-Admin-Key` | Yes | Admin API key |

**Response**

```json
{
  "provider": "GADMIN...",
  "totalRevenue": 12500000,
  "totalMeters": 42,
  "activeMeters": 37,
  "totalUnitsUsed": 182400
}
```

| Field | Type | Description |
|---|---|---|
| `provider` | string\|null | Admin address (`ADMIN_ADDRESS` env var) |
| `totalRevenue` | number | Revenue in stroops |
| `totalMeters` | number | Total registered meters |
| `activeMeters` | number | Currently active meters |
| `totalUnitsUsed` | number | Total units consumed |

| Status | Description |
|---|---|
| 200 | Returns provider summary |
| 401 | Missing or invalid `X-Admin-Key` |
| 500 | RPC or contract error |

---

### `POST /api/provider/webhook`

Register or replace the low-balance webhook URL for this provider.
When a meter's balance drops below `LOW_BALANCE_THRESHOLD`, the IoT bridge
fires a POST to this URL.

This is a named alias for `POST /api/webhooks/low-balance` in the
provider-facing namespace.

**Headers**

| Header | Required | Description |
|---|---|---|
| `X-Admin-Key` | Yes | Admin API key |
| `Content-Type` | Yes | `application/json` |

**Body**

```json
{
  "webhook_url": "https://your-service.example.com/hooks/low-balance"
}
```

**Response**

```json
{
  "message": "Webhook registered",
  "webhook_url": "https://your-service.example.com/hooks/low-balance"
}
```

| Status | Description |
|---|---|
| 200 | Webhook registered |
| 400 | Invalid URL format |
| 401 | Missing or invalid `X-Admin-Key` |

---

## Admin: Dead-letter Events

Usage events that fail every retry attempt are moved to a **dead-letter** state
(`status = 'failed'`).  They are excluded from the automatic retry worker and
must be manually reprocessed or discarded.

The current dead-letter count is also surfaced in the `/health` response under
the `deadLetterEvents` field.

### `GET /api/admin/dead-letters`

Lists all dead-lettered usage events.

**Headers**

| Header | Required | Description |
|---|---|---|
| `X-Admin-Key` | Yes | Admin API key |

**Query Parameters**

| Param | Default | Description |
|---|---|---|
| `limit` | 50 | Maximum results (max 200) |
| `offset` | 0 | Pagination offset |

**Response**

```json
{
  "total": 3,
  "limit": 50,
  "offset": 0,
  "events": [
    {
      "id": 7,
      "meter_id": "METER1",
      "units": 150,
      "cost": "750000",
      "status": "failed",
      "attempt_count": 5,
      "last_error": "RPC timeout",
      ...
    }
  ]
}
```

| Status | Description |
|---|---|
| 200 | Returns dead-letter list |
| 401 | Missing or invalid `X-Admin-Key` |

---

### `POST /api/admin/dead-letters/:id/reprocess`

Requeues a single dead-lettered event for retry. Resets its status to `pending`
and zeroes the attempt counter so the retry worker picks it up on its next tick.

**Headers**

| Header | Required | Description |
|---|---|---|
| `X-Admin-Key` | Yes | Admin API key |

**Response**

```json
{
  "message": "Event requeued",
  "event": { "id": 7, "status": "pending", ... }
}
```

| Status | Description |
|---|---|
| 200 | Event requeued |
| 400 | Invalid event id |
| 401 | Missing or invalid `X-Admin-Key` |
| 404 | Event not found or not in dead-letter state |

---

## Usage Event Retention & Compaction

`usage_events` grows roughly 1KB per row; left unbounded it reaches multiple
GB after months of operation at fleet scale. A daily job compacts detailed
history into aggregates while keeping analytics intact.

### How it works

1. **Detail window** (`USAGE_DETAIL_RETENTION_DAYS`, default 90): events
   newer than this stay as individual rows in `usage_events`.
2. **Roll-up**: events older than the detail window are aggregated per
   `(date, meter_id)` into `usage_summary` (`total_units`, `total_cost`,
   `event_count`), then the detail rows are deleted and the database is
   `VACUUM`ed to reclaim disk space.
3. **Cold-storage archive** (`USAGE_ARCHIVE_RETENTION_DAYS`, default 365):
   events older than this are additionally written to a gzipped JSONL file
   under `USAGE_ARCHIVE_DIR` (default `./data/archive`) *before* deletion, so
   the raw records survive even though they're gone from the live database.
   Point `USAGE_ARCHIVE_DIR` at a mounted/synced bucket (s3fs, gcsfuse, an
   `aws s3 sync` cron target) to treat it as real cold storage.
4. Only `submitted` events are touched — `pending` and `failed` events are
   left alone regardless of age so retry/replay keeps working.

The job runs automatically once a day at **02:00 UTC**. It's idempotent:
running it again with nothing left to compact is a no-op.

### `POST /api/usage-events/compact`

Run the compaction job on demand (e.g. right after lowering the retention
window). Requires `X-Admin-Key`.

**Body** (optional overrides)

```json
{ "detailedRetentionDays": 90, "archiveRetentionDays": 365 }
```

**Response**

```json
{
  "compactedCount": 1200,
  "summaryRowsTouched": 40,
  "archivedCount": 300,
  "archiveFile": "/app/data/archive/usage-events-2026-08-26T02-00-00-000Z.jsonl.gz",
  "vacuumed": true
}
```

### `GET /api/usage-events/summary?meterId=&limit=`

Aggregated daily usage from `usage_summary`, most recent day first. `meterId`
is optional (omit for all meters); `limit` caps the number of rows (default
90, max 365).

**Response**

```json
{
  "summary": [
    { "date": "2026-05-01", "meter_id": "METER1", "total_units": 4200, "total_cost": 21000000, "event_count": 48 }
  ],
  "count": 1
}
```

### `DELETE /api/usage-events?olderThanDays=90`

Hard-deletes submitted events older than N days **without** aggregating them
first — use `POST /api/usage-events/compact` instead unless you specifically
want to discard the history rather than roll it up. Requires `X-Admin-Key`.
