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
