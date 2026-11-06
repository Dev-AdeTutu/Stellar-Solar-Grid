# Real-Time Grid Congestion Pricing (#1057)

Locational marginal pricing (LMP) per region:

```
price = energy + congestion + loss
energy     = base price (LMP_BASE_PRICE, default 0.1 XLM/kWh)
congestion = base × (zone congestion multiplier − 1)
loss       = base × region lossFactor
```

The congestion multiplier comes from `src/lib/congestionPricing.ts`: real-time zone loads are posted
to `POST /api/congestion/:zone/load` (admin) and the multiplier rises linearly from 1× above
`CONGESTION_THRESHOLD` utilisation up to `CONGESTION_MAX_MULTIPLIER` at 100%.

Prices are recomputed every `PRICING_INTERVAL_MS` (default 5 minutes). When a region's price moves by at
least `PRICING_NOTIFY_DELTA_PCT` (default 5%), subscribers receive a push notification.

## API

| Endpoint | Purpose |
|----------|---------|
| `GET /api/pricing/regions` | Current LMP breakdown for every region |
| `GET /api/pricing/regions/:region` | One region |
| `GET /api/pricing/heatmap` | Prices plus a 0–1 `intensity` for the frontend heatmap |
| `POST /api/pricing/regions/:region/subscribe` | `{ ownerAddress }` price-change notifications |
| `DELETE /api/pricing/regions/:region/subscribe/:ownerAddress` | Unsubscribe |
| `PUT /api/pricing/regions/:region` | `{ zone, lossFactor, lat?, lng? }` (admin) |
| `PUT /api/pricing/base` | `{ price }` (admin) |
| `POST /api/pricing/reprice` | Force recompute (admin) |

The frontend `RegionalPriceHeatmap` component renders the heatmap.
Tests: `tests/meter-config-pricing-anon.integration.test.ts`.
