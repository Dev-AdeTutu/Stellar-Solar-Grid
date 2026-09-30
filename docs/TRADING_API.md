# Energy Trading Bot API (#891)

Base path: `/api/trading`. Authenticate with header `X-API-Key: <key>`.

## Key management
| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/keys` | Admin (`X-Admin-Key`) | Create key `{ owner, dailyQuota? }` → `{ id, key }` (shown once) |
| POST | `/keys/rotate` | API key | Issue new key; old key stays valid for 24h |
| DELETE | `/keys` | API key | Revoke the calling key |
| GET | `/usage` | Admin | Per-key usage (today, quota, total) — monitoring dashboard feed |

Keys are stored only as SHA-256 hashes.

## Trading
| Method | Path | Body |
|---|---|---|
| GET | `/orderbook` | — |
| POST | `/orders` | `{ side: "buy"|"sell", kwh, price }` |
| DELETE | `/orders/:id` | — |

## Real-time feed
`ws://<host>/api/trading/ws?apiKey=<key>` — messages: `{ event: "order.created"|"order.cancelled", data }`.

## Limits
- Burst: `BOT_RATE_LIMIT_PER_SEC` (default 20 req/s per key) → `429` with `RateLimit-*` headers.
- Daily quota: `BOT_DAILY_QUOTA` (default 50,000) or per-key `dailyQuota` → `429`.

## Example
See `examples/bots/simple-market-maker.mjs`.
