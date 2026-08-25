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
| `LOW_BALANCE_THRESHOLD` | No       | 1000000 | Fallback threshold (used when no 7-day usage history exists) |
| `WEB_PUSH_VAPID_SUBJECT` | No      | -       | VAPID subject for Web Push (`mailto:...`) |
| `WEB_PUSH_VAPID_PUBLIC_KEY` | No   | -       | VAPID public key sent to browsers |
| `WEB_PUSH_VAPID_PRIVATE_KEY` | No  | -       | VAPID private key used to sign push sends |

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

When a meter's balance drops below the alert threshold after a usage update, the bridge fires a POST request to the registered webhook URL.

Alert threshold rule:
- `threshold = 10% of typical weekly usage (last 7 days summed cost)`
- If no recent usage exists, fallback to `LOW_BALANCE_THRESHOLD`

**Payload**

```json
{
  "event": "low_balance",
  "meter_id": "METER123",
  "balance": 500000,
  "threshold": 800000,
  "weekly_typical_stroops": 8000000,
  "timestamp": "2025-05-27T10:30:00.000Z"
}
```

**Fields**

| Field       | Type   | Description                      |
| ----------- | ------ | -------------------------------- |
| `event`     | string | Always `"low_balance"`           |
| `meter_id`  | string | The meter identifier             |
| `balance`   | number | Current meter balance in stroops |
| `threshold` | number | Computed threshold in stroops  |
| `weekly_typical_stroops` | number | Last-7-days usage cost sum in stroops |
| `timestamp` | string | ISO 8601 timestamp of the event  |

## Push Subscription API

### `GET /api/push/config`

Returns push feature status and the VAPID public key for browser subscription.

### `POST /api/push/subscribe`

Stores/updates a browser push subscription for a Stellar owner address.

Body:

```json
{
  "ownerAddress": "G...",
  "subscription": {
    "endpoint": "https://...",
    "keys": {
      "p256dh": "...",
      "auth": "..."
    }
  }
}
```

### `POST /api/push/unsubscribe`

Deletes a stored push subscription by endpoint.

**Error Handling**

- Failed webhook calls are logged but do not crash the IoT bridge
- Webhook timeouts can be configured via your HTTP client settings
- Consider idempotency keys on your webhook endpoint to handle retries
