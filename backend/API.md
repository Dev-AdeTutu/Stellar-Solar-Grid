# SolarGrid Backend API

## Development with Docker Compose

### Quick Start

Spin up the full development stack (backend + MQTT broker) with:

```bash
docker-compose up --build
```

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

### `POST /api/meters/:id/pay`

Submit a payment for a meter.

**Headers**

| Header            | Required | Description                                |
| ----------------- | -------- | ------------------------------------------ |
| `Idempotency-Key` | No       | Unique client-generated key (e.g. UUID v4) |

**Body**

```json
{
  "token_address": "C...",
  "payer": "G...",
  "amount_stroops": 5000000,
  "plan": "Daily"
}
```

**Behaviour**

- If `Idempotency-Key` is provided and a successful response for that key exists in the cache (within 24 h), the cached `{ hash }` is returned immediately — no duplicate contract call is made.
- Cache entries expire after 24 hours.
- Expired entries are evicted lazily on the next write.

**Response**

```json
{ "hash": "<transaction-hash>" }
```

## Low-Balance Webhook Notifications

Providers can register webhook URLs to receive notifications when a customer's meter balance drops below a configurable threshold.

### Configuration

Set the following environment variables:

| Variable                | Required | Default | Description                                    |
| ----------------------- | -------- | ------- | ---------------------------------------------- |
| `PROVIDER_WEBHOOK_URL`  | No       | -       | Webhook endpoint URL for low-balance alerts    |
| `LOW_BALANCE_THRESHOLD` | No       | 1000000 | Balance threshold in stroops (0.1 XLM default) |

### Register Webhook Endpoint

**`POST /api/webhooks/low-balance`**

Register or update the webhook URL for low-balance notifications.

**Body**

```json
{
  "webhook_url": "https://your-service.com/webhooks/low-balance"
}
```

**Response**

```json
{
  "message": "Webhook registered successfully",
  "webhook_url": "https://your-service.com/webhooks/low-balance"
}
```

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
