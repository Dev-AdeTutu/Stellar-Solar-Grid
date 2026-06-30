# Stellar SolarGrid — Troubleshooting Guide

This guide covers the most common issues encountered when setting up, running, and developing Stellar SolarGrid. Each issue includes symptoms, root cause, and step-by-step resolution.

**Quick links**
- [Environment & Configuration](#1-environment--configuration)
- [Smart Contract](#2-smart-contract)
- [Backend](#3-backend)
- [MQTT / IoT Bridge](#4-mqtt--iot-bridge)
- [Frontend](#5-frontend)
- [Wallet & Freighter](#6-wallet--freighter)
- [Payments & Balances](#7-payments--balances)
- [Docker & Docker Compose](#8-docker--docker-compose)
- [Observability (Prometheus / Grafana)](#9-observability-prometheus--grafana)
- [CI / CD & Contract Deployment](#10-ci--cd--contract-deployment)
- [Debug Checklist](#debug-checklist)
- [Getting Help](#getting-help)

---

## 1. Environment & Configuration

### 1.1 Backend exits immediately with "Missing required environment variables"

**Symptom**
```
FATAL Missing required environment variables. Copy backend/.env.example to backend/.env.
{"missing":["CONTRACT_ID","ADMIN_SECRET_KEY"]}
```

**Cause**  
One or more required vars are not set, are empty, or still contain placeholder values like `YOUR_CONTRACT_ID_HERE`.

**Fix**
```bash
cd backend
cp .env.example .env
# Open .env and fill in CONTRACT_ID, ADMIN_SECRET_KEY, STELLAR_RPC_URL, MQTT_BROKER
```
Required variables: `CONTRACT_ID`, `ADMIN_SECRET_KEY`, `STELLAR_RPC_URL`, `MQTT_BROKER`.

---

### 1.2 Docker Compose `env-check` service fails

**Symptom**
```
ERROR: Required environment variable CONTRACT_ID is not set, is empty, or has placeholder value.
```

**Cause**  
The root `.env` file is missing or contains unmodified placeholder values.

**Fix**
```bash
cp .env.example .env
# Set CONTRACT_ID, ADMIN_SECRET_KEY, VITE_CONTRACT_ID with real values
docker compose up --build
```

---

### 1.3 Frontend shows blank page — `VITE_CONTRACT_ID` not set

**Symptom**  
The app loads but contract calls immediately fail with "Contract not initialized."

**Cause**  
`VITE_CONTRACT_ID` is not set in `frontend/.env.local`, so the contract client initialises with an empty ID.

**Fix**
```bash
cd frontend
cp .env.example .env.local
# Set VITE_CONTRACT_ID to the same value as CONTRACT_ID in backend/.env
```
> **Note:** In Docker Compose, `VITE_CONTRACT_ID` is passed as a build arg. Make sure the root `.env` has it set before running `docker compose up --build`.

---

### 1.4 `ADMIN_API_KEY` left as default in production

**Symptom**  
Admin endpoints are accessible without authentication, or the backend logs:
```
WARN ADMIN_API_KEY not set — skipping auth check (dev mode)
```

**Fix**  
Set a strong random value in `.env`:
```bash
ADMIN_API_KEY=$(openssl rand -hex 32)
```
In production, the backend returns `503 Server misconfiguration` if `ADMIN_API_KEY` is not set.

---

## 2. Smart Contract

### 2.1 Contract deployment fails — insufficient testnet XLM

**Symptom**
```
error: transaction submission failed: TRANSACTION_FAILED
OperationResultCode: opUNDERFUNDED
```

**Fix**  
Fund your account using the Stellar Friendbot:
```bash
curl "https://friendbot.stellar.org?addr=YOUR_PUBLIC_KEY"
```
Then retry deployment.

---

### 2.2 `Error(Contract, 3)` — Meter not found

**Symptom**  
Frontend or backend returns: `"Meter not found."`

**Cause**  
The meter ID has not been registered on-chain, or the wrong `CONTRACT_ID` is being used.

**Fix**
```bash
# Register the meter via Stellar CLI
stellar contract invoke \
  --id $CONTRACT_ID \
  --source $ADMIN_SECRET_KEY \
  --network testnet \
  -- register_meter \
  --meter_id METER1 \
  --owner YOUR_PUBLIC_KEY
```
Or use the Makefile shortcut:
```bash
make invoke-register CONTRACT_ID=<id> ADMIN_SECRET_KEY=<key> METER_ID=METER1 OWNER=<key>
```

---

### 2.3 `Error(Contract, 5)` — Unauthorized access

**Symptom**  
Admin-only contract calls return `"Unauthorized access."`

**Cause**  
The signing key used is not the admin key stored in the contract, or the oracle address is not on the allowlist.

**Fix**
- Confirm `ADMIN_SECRET_KEY` in `.env` corresponds to the key used during `make deploy`.
- Add the IoT oracle address to the allowlist:
  ```bash
  make invoke-allowlist CONTRACT_ID=<id> ADMIN_SECRET_KEY=<key> OWNER=<oracle_address>
  ```

---

### 2.4 `Error(Contract, 7)` — Owner not in allowlist

**Symptom**  
`make_payment` or `update_usage` calls fail with `"Owner is not in the allowlist."`

**Cause**  
The user's wallet address or the oracle address has not been added to the allowlist.

**Fix**
```bash
stellar contract invoke \
  --id $CONTRACT_ID \
  --source $ADMIN_SECRET_KEY \
  --network testnet \
  -- add_to_allowlist \
  --address USER_PUBLIC_KEY
```

---

### 2.5 Contract build fails — missing wasm32 target

**Symptom**
```
error[E0463]: can't find crate for `std`
error: cannot find crate for `std`
```

**Fix**
```bash
rustup target add wasm32-unknown-unknown
make build
```

---

### 2.6 Contract test failures after struct change

**Symptom**  
Tests pass locally but fail in CI after a `Meter` struct update.

**Cause**  
Persistent storage entries use the old schema. See [Contract Upgrades](README.md#contract-upgrades).

**Fix**  
Run the migration for each affected meter:
```bash
stellar contract invoke \
  --id $CONTRACT_ID \
  --source $ADMIN_SECRET_KEY \
  --network testnet \
  -- migrate_meter \
  --meter_id METER1
```

---

## 3. Backend

### 3.1 Backend fails to start — cannot connect to MQTT broker

**Symptom**
```
ERROR Failed to connect to MQTT broker mqtt://mqtt:1883
```

**Cause**  
The MQTT broker container is not running, or `MQTT_BROKER` points to the wrong host.

**Fix**
```bash
# If using Docker Compose
docker compose up mqtt

# Verify the broker is healthy
docker compose ps mqtt

# For local dev (no Docker), start Mosquitto manually and set:
MQTT_BROKER=mqtt://localhost:1883
```

---

### 3.2 `504 Request timed out` on contract calls

**Symptom**  
API returns `{"error":"Request timed out","code":"TIMEOUT"}` on meter or payment endpoints.

**Cause**  
The Stellar RPC endpoint is slow or the default 15s timeout is too short for the current network conditions.

**Fix**  
Increase the timeout in `backend/.env`:
```
REQUEST_TIMEOUT=30s
```
Also check the RPC endpoint is reachable:
```bash
curl https://soroban-testnet.stellar.org/
```

---

### 3.3 `429 Too Many Requests`

**Symptom**  
API responses include `{"error":"Too many requests","code":"RATE_LIMITED"}` with a `Retry-After` header.

**Fix**  
For development, relax the rate limits in `backend/.env`:
```
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=120
```
In production, use the `Retry-After` value (seconds) before retrying.

---

### 3.4 `413 Request body too large`

**Symptom**
```json
{"error":"Request body too large","code":"PAYLOAD_TOO_LARGE"}
```

**Fix**  
Increase the body limit in `backend/.env`:
```
REQUEST_BODY_LIMIT=1mb
```

---

### 3.5 CORS errors from frontend

**Symptom**  
Browser console shows:
```
Access to fetch at 'http://localhost:3001/api/...' from origin 'http://localhost:3000' has been blocked by CORS policy
```

**Fix**  
Add your frontend origin to `CORS_ORIGIN` in `backend/.env`:
```
CORS_ORIGIN=http://localhost:3000,http://localhost:5173
```
Restart the backend after changing this value.

---

### 3.6 `/api/health` returns `503 degraded`

**Symptom**
```json
{"status":"degraded","dependencies":{"stellarRpc":"unreachable","mqtt":"unreachable"}}
```

**Fix**
- **stellarRpc unreachable:** Check `STELLAR_RPC_URL` is correct and the endpoint is up.
- **mqtt unreachable:** Ensure the MQTT broker container is running and `MQTT_BROKER` uses the correct host/port.

---

## 4. MQTT / IoT Bridge

### 4.1 IoT bridge stops reconnecting after repeated failures

**Symptom**  
Backend logs:
```
ERROR Max MQTT reconnect attempts reached. IoT bridge stopped.
```

**Cause**  
The broker was unreachable for longer than `MQTT_MAX_RECONNECT_ATTEMPTS` attempts (default: 10).

**Fix**
```bash
# Restart the backend service (or the full stack)
docker compose restart backend

# Optionally increase the retry limit in backend/.env:
MQTT_MAX_RECONNECT_ATTEMPTS=20
```

---

### 4.2 Usage events not reaching the smart contract

**Symptom**  
Meters report usage via MQTT but `units_used` on-chain doesn't update.

**Debug steps**
1. Check that the IoT bridge's oracle address is on the contract allowlist (see [2.3](#23-error-contract-7--owner-not-in-allowlist)).
2. Check backend logs for `batch_update_usage` contract errors.
3. Verify the MQTT topic format matches `meter/{METER_ID}/usage`.
4. Confirm the payload schema:
   ```json
   {"meter_id": "METER1", "units": 100, "cost": 50}
   ```

---

### 4.3 Low-balance webhook not firing

**Symptom**  
Meter balance drops below threshold but `PROVIDER_WEBHOOK_URL` receives no request.

**Fix**  
Check these vars in `backend/.env`:
```
PROVIDER_WEBHOOK_URL=https://your-endpoint.com/webhook
LOW_BALANCE_THRESHOLD=1000000
```
Confirm the URL is reachable from the backend container. Use `docker compose logs backend` to see webhook delivery errors.

---

## 5. Frontend

### 5.1 `npm run dev` fails — port already in use

**Symptom**
```
Error: listen EADDRINUSE: address already in use :::5173
```

**Fix**
```bash
# Kill the process using port 5173
npx kill-port 5173
npm run dev

# Or start on a different port
npm run dev -- --port 5174
```

---

### 5.2 Frontend build fails — `node_modules` missing or stale

**Symptom**
```
Cannot find module '@/components/...'
```

**Fix**
```bash
cd frontend
rm -rf node_modules package-lock.json
npm install
npm run build
```

---

### 5.3 UsageChart shows error boundary fallback on new meters

**Symptom**  
The usage chart area shows an error card for meters with no recorded usage.

**Cause**  
This was a known bug (fixed in [#399](https://github.com/Dev-AdeTutu/Stellar-Solar-Grid/issues/399)). The component now renders an empty state placeholder instead of crashing.

**Fix**  
Pull the latest `main` and rebuild.

---

### 5.4 Balance does not update without page refresh

**Symptom**  
After a payment, the meter balance shown in the dashboard is stale.

**Cause**  
Prior to [#400](https://github.com/Dev-AdeTutu/Stellar-Solar-Grid/issues/400), balance was only fetched on mount.

**Fix**  
Pull the latest `main`. The dashboard now polls `/api/meters/:id/balance` every 30 seconds via `useInterval`. To adjust the interval:
```
# frontend/.env.local
NEXT_PUBLIC_POLL_INTERVAL_MS=15000
```

---

## 6. Wallet & Freighter

### 6.1 "Freighter not detected" tooltip appears

**Symptom**  
The Connect Wallet button shows a tooltip: "Freighter not detected — Install Freighter ↗"

**Fix**
1. Install the [Freighter browser extension](https://freighter.app).
2. Refresh the page.
3. Make sure Freighter is set to **Testnet** (not Mainnet) for development.

---

### 6.2 "Transaction cancelled by user"

**Symptom**  
Payment fails with: `"Transaction cancelled by user."`

**Cause**  
The Freighter popup was dismissed or the user rejected the transaction.

**Fix**  
This is user-initiated. Retry the payment and approve it in the Freighter popup.

---

### 6.3 Wallet connects but shows wrong network

**Symptom**  
Transactions fail with network mismatch errors.

**Fix**  
In Freighter: Settings → Network → select **Testnet**.  
In `frontend/.env.local`, confirm:
```
VITE_NETWORK_PASSPHRASE=Test SDF Network ; September 2015
```

---

### 6.4 `Error(Contract, 5)` after wallet connect

**Symptom**  
All contract calls fail with "Unauthorized access" immediately after connecting.

**Cause**  
The connected wallet address is not on the contract allowlist.

**Fix**  
Ask an admin to add your address to the allowlist (see [2.4](#24-errorcontract-7--owner-not-in-allowlist)).

---

### 6.5 Freighter shows "Account not found"

**Symptom**  
Freighter popup shows "Account not found" when trying to sign.

**Cause**  
The account has never received any XLM, so it doesn't exist on the ledger.

**Fix**  
Fund the account via Friendbot:
```bash
curl "https://friendbot.stellar.org?addr=YOUR_PUBLIC_KEY"
```

---

## 7. Payments & Balances

### 7.1 Payment succeeds but meter stays inactive

**Symptom**  
Transaction hash is returned, but `active: false` on the meter.

**Cause**  
`Error(Contract, 11)` — meter balance is zero after a partial payment, or the payment amount was below the minimum for the selected plan.

**Fix**  
Check the minimum payment for the plan and retry with a sufficient amount. Monitor the backend logs for `Error(Contract, 11)`.

---

### 7.2 `Error(Contract, 12)` — Insufficient meter balance

**Symptom**  
Usage update fails: `"Insufficient meter balance."`

**Cause**  
The meter ran out of pre-paid balance. The contract automatically deactivates the meter.

**Fix**  
Top up via the dashboard or:
```bash
stellar contract invoke \
  --id $CONTRACT_ID \
  --source $USER_SECRET_KEY \
  --network testnet \
  -- make_payment \
  --meter_id METER1 \
  --amount 5000000 \
  --plan Daily
```

---

### 7.3 Balance shows `0` immediately after payment

**Symptom**  
The balance card shows `0 XLM` right after a successful payment.

**Cause**  
The 5-second balance cache at `/api/meters/:id/balance` is serving a stale response.

**Fix**  
Wait 5 seconds and click **↻ Refresh** on the dashboard. The cache TTL is intentional to reduce RPC load.

---

## 8. Docker & Docker Compose

### 8.1 Backend container fails health check — keeps restarting

**Symptom**
```
backend | Error: connect ECONNREFUSED 127.0.0.1:1883
```
The backend container restarts in a loop.

**Fix**
```bash
# Ensure mqtt starts healthy before backend
docker compose up mqtt
docker compose ps mqtt        # wait for "healthy"
docker compose up backend
```
The `depends_on` in `docker-compose.yml` uses `condition: service_healthy` — if the health check times out, increase `start_period` in the Compose file.

---

### 8.2 `docker compose up` fails — port 3001 already in use

**Fix**
```bash
# Find and kill the process using port 3001
netstat -ano | findstr :3001     # Windows
lsof -i :3001                    # macOS / Linux
# Then kill the PID, or change PORT in backend/.env
```

---

### 8.3 Mosquitto container exits with "Address already in use"

**Symptom**
```
mosquitto | Error: Address already in use
```

**Fix**
```bash
# Stop any local Mosquitto service
sudo systemctl stop mosquitto   # Linux
brew services stop mosquitto    # macOS
```

---

### 8.4 Frontend Docker image shows old contract ID

**Cause**  
`VITE_CONTRACT_ID` is a build-time arg. Changing the root `.env` alone is not enough — the image must be rebuilt.

**Fix**
```bash
docker compose up --build frontend
```

---

## 9. Observability (Prometheus / Grafana)

### 9.1 Prometheus is not scraping the backend

**Symptom**  
Prometheus target `solargrid-backend` shows `DOWN`.

**Fix**
1. Confirm the backend `/metrics` endpoint is reachable from the Prometheus container:
   ```bash
   curl http://backend:3001/metrics
   ```
2. Check `infra/prometheus.yml` has the correct `targets` value (`backend:3001`).
3. Start the observability profile:
   ```bash
   docker compose --profile observability up
   ```

---

### 9.2 Grafana shows "No data" on all panels

**Fix**
1. Open Grafana at `http://localhost:3000` (credentials: `admin` / `admin`).
2. Go to **Configuration → Data Sources** and verify the Prometheus URL is `http://prometheus:9090`.
3. Click **Save & Test** — it should show "Data source is working".
4. Generate some traffic to the backend, then refresh the dashboard.

---

### 9.3 `/metrics` returns `401 Unauthorized` or `429 Too Many Requests`

**Cause**  
The `/metrics` endpoint must be registered before rate-limit and auth middleware. This was fixed in [#397](https://github.com/Dev-AdeTutu/Stellar-Solar-Grid/issues/397).

**Fix**  
Pull the latest `main`.

---

## 10. CI / CD & Contract Deployment

### 10.1 GitHub Actions contract deploy workflow fails

**Symptom**
```
Error: secret ADMIN_SECRET_KEY not found
```

**Fix**  
In your GitHub repository: **Settings → Secrets and variables → Actions → New repository secret**  
Add `ADMIN_SECRET_KEY` with the testnet admin secret key.

---

### 10.2 Contract deploy workflow does not trigger

**Cause**  
The workflow only triggers on tags matching `contract-v*`.

**Fix**
```bash
git tag contract-v1.0.1
git push origin contract-v1.0.1
```

---

### 10.3 `gh pr create` fails — "No default remote repository has been set"

**Fix**
```bash
gh repo set-default OWNER/Stellar-Solar-Grid
```

---

### 10.4 Push rejected — `403` permission denied to `<other-user>`

**Symptom**
```
remote: Permission to Dev-AdeTutu/Stellar-Solar-Grid.git denied to <username>.
```

**Cause**  
You are pushing to the upstream repo directly, which requires collaborator access. The correct workflow is fork → branch → PR.

**Fix**
```bash
# Push to your fork
git push -u origin your-branch

# Then open a PR against Dev-AdeTutu/Stellar-Solar-Grid
gh pr create --repo Dev-AdeTutu/Stellar-Solar-Grid \
  --head YOUR_USERNAME:your-branch \
  --base main
```

---

## Debug Checklist

Run through this list when something is broken and you're not sure where to start.

```
[ ] Is .env populated? (no placeholder values)
[ ] Is the MQTT broker running and healthy?
    docker compose ps mqtt
[ ] Is the backend healthy?
    curl http://localhost:3001/api/health
[ ] Is the Stellar RPC endpoint reachable?
    curl https://soroban-testnet.stellar.org/
[ ] Is the CONTRACT_ID correct in all .env files?
[ ] Does the admin account have testnet XLM?
    curl "https://friendbot.stellar.org?addr=ADMIN_PUBLIC_KEY"
[ ] Is the oracle/meter address on the contract allowlist?
[ ] Is Freighter set to Testnet?
[ ] Have you rebuilt the frontend after changing VITE_CONTRACT_ID?
    docker compose up --build frontend
[ ] Are there error messages in the logs?
    docker compose logs backend --tail=50
    docker compose logs mqtt --tail=50
```

---

## Getting Help

If your issue is not covered here:

1. **Search existing issues** — [github.com/Dev-AdeTutu/Stellar-Solar-Grid/issues](https://github.com/Dev-AdeTutu/Stellar-Solar-Grid/issues)
2. **Check the API docs** — [`backend/API.md`](backend/API.md) and the live OpenAPI spec at `/api/docs` when the backend is running
3. **Open a Discussion** for questions that aren't bugs — [github.com/Dev-AdeTutu/Stellar-Solar-Grid/discussions](https://github.com/Dev-AdeTutu/Stellar-Solar-Grid/discussions)
4. **File a bug report** using the issue template — include the output of `docker compose logs` and your sanitised `.env` (remove secret keys)

> **Security issues** — do not open a public issue. Email the maintainers directly or use GitHub's private vulnerability reporting.
