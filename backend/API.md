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

## Request/Response Logging

All requests are logged by `requestLogger` middleware (`backend/src/lib/requestLogger.ts`):

- Every request gets a unique `request_id` (also returned as the `X-Request-Id`
  response header) linking its request and response log lines.
- Sensitive fields (secrets, tokens, passwords, API keys) are redacted from
  logged request bodies.
- Errors (status >= 400) are always logged; successful requests are sampled
  at 10% by default to limit log volume.
- Disable entirely by setting `LOG_REQUESTS=false`.

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

## Batch Meter Registration

### `POST /api/meters/batch`

Registers up to 100 meters in a single on-chain transaction (admin only),
wrapping the contract's `batch_register_meters` function.

Request body:

```json
{
  "meters": [
    { "meter_id": "METER1", "owner": "GABC...XYZ" },
    { "meter_id": "METER2", "owner": "GDEF...UVW" }
  ]
}
```

- Rejects (400) if `meters` is empty, exceeds 100 entries, or contains
  duplicate `meter_id` values within the request.
- Entries whose owner is not allowlisted, or whose `meter_id` already exists
  on-chain, are skipped rather than failing the whole batch (see the
  `batch_skip` event in `contracts/README.md`).
- Response: `{ "hash": "<tx_hash>", "meter_ids": [...] }`.

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
