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

⚠️ **Note**: Idempotency is not currently implemented. Clients retrying failed payment requests may result in duplicate on-chain transactions. Use client-side deduplication or implement idempotency keys on your end. This is planned for a future release (see issue #API-22).

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
