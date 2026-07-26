# Docker Setup

Run the entire platform locally with Docker Compose:

```bash
docker-compose up --build
```

Services:

- **Backend**: Express API server + IoT Bridge (`http://localhost:3001`)
- **Frontend**: Next.js dashboard (`http://localhost:3000`)
- **MQTT**: Eclipse Mosquitto MQTT broker (`mqtt://localhost:1883`)

To stop:

```bash
docker-compose down
```

To also remove volumes (e.g., for a clean restart):

```bash
docker-compose down -v
```

## Idempotency

Payment endpoints support the `Idempotency-Key` header to prevent duplicate submissions on network retries.

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

**Response**

```json
{ "hash": "<transaction-hash>" }
```

## Low-Balance Webhook Notifications

Providers can register webhook URLs to receive notifications when a customer's meter balance drops below a configurable threshold.
