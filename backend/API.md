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

## Payments

### `POST /api/payments`

Submit a payment for a meter.

**Body**

```json
{
  "meterId": "METER1",
  "payer": "G...",
  "amount": 5000000
}
```

**Response**

```json
{ "hash": "<transaction-hash>" }
```

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

## Usage Events Lifecycle Management

All usage event endpoints require a valid `Authorization: Bearer <ADMIN_API_KEY>` header.

### `DELETE /api/usage-events`

Purges submitted usage events older than `N` days.

**Query Parameters**
- `olderThanDays` (optional): Default `90`. Must be a non-negative integer.

**Response**

```json
{
  "deletedCount": 5
}
```

### `GET /api/usage-events/failed`

Returns a paginated list of dead-lettered/failed usage events.

**Query Parameters**
- `page` (optional): Default `1`.
- `pageSize` (optional): Default `10`.

**Response**

```json
{
  "events": [
    {
      "id": 42,
      "meter_id": "METER1",
      "units": 100,
      "cost": "500000",
      "received_at": "2026-07-26T12:00:00.000Z",
      "status": "failed",
      "attempt_count": 5,
      "last_error": "Stellar RPC error"
    }
  ],
  "pagination": {
    "page": 1,
    "pageSize": 10,
    "total": 1,
    "pages": 1
  }
}
```

### `POST /api/usage-events/:id/replay`

Resets a failed usage event back to `pending` status and `attempt_count` to `0` so it can be retried.

**Response**

Returns the updated event record:

```json
{
  "id": 42,
  "meter_id": "METER1",
  "units": 100,
  "cost": "500000",
  "received_at": "2026-07-26T12:00:00.000Z",
  "status": "pending",
  "attempt_count": 0,
  "last_error": null
}
```

If the event is not found or not in `failed` status, returns `404 Not Found`.
