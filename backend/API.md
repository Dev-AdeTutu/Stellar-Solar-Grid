# SolarGrid Backend API

## Idempotency

Payment endpoints support the `Idempotency-Key` header to prevent duplicate submissions on network retries.

### `POST /api/meters/:id/pay`

Submit a payment for a meter.

**Headers**

| Header            | Required | Description                                      |
|-------------------|----------|--------------------------------------------------|
| `Idempotency-Key` | No       | Unique client-generated key (e.g. UUID v4)       |

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
