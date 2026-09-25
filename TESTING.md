# Testing

## Load testing (#840)

Load tests use [k6](https://k6.io) and live in `backend/loadtest/`.

| Script | Covers |
|---|---|
| `critical-endpoints.js` | `/api/health`, `/metrics` (middleware stack) |
| `write-paths.js` | meter registration (`POST /api/meters`), payments (`POST /api/payments`), usage updates (`POST /api/usage`) |

### Scenarios

`write-paths.js` takes `SCENARIO=100|500|1000` (concurrent virtual users, split evenly across the three flows, ramped over 30s, held 1m):

```bash
k6 run -e SCENARIO=100  backend/loadtest/write-paths.js
k6 run -e SCENARIO=500  backend/loadtest/write-paths.js
k6 run -e SCENARIO=1000 -e BASE_URL=https://staging.example.com backend/loadtest/write-paths.js
```

### Metrics

- **Response time**: `register_duration`, `payment_duration`, `usage_duration` trends (p95 reported)
- **Throughput**: `http_reqs` rate, `requests_total`
- **Error rate**: `errors` (5xx, timeouts, connection failures; 4xx from missing on-chain state is a handled response)

### CI

`.github/workflows/load-test.yml` runs both scripts on backend PRs (write paths at 100 VUs). Threshold breaches fail the build, acting as the performance-regression gate. The 500 and 1000 tiers are run manually against staging.

### Performance baselines

Thresholds encode the budget each tier must meet:

| Metric | 100 VUs | 500 VUs | 1000 VUs |
|---|---|---|---|
| Registration p95 | < 1500 ms | < 1500 ms | < 1500 ms |
| Payment p95 | < 1500 ms | < 1500 ms | < 1500 ms |
| Usage update p95 | < 500 ms | < 500 ms | < 500 ms |
| Error rate | < 1% | < 1% | < 1% |
| Throughput | > 10 req/s | > 10 req/s | > 10 req/s |

Update this table with measured numbers when running the higher tiers against staging.
