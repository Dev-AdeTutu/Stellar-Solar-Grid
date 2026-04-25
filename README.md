# Stellar SolarGrid

[![CI](https://github.com/Dev-AdeTutu/Stellar-Solar-Grid/actions/workflows/ci.yml/badge.svg)](https://github.com/Dev-AdeTutu/Stellar-Solar-Grid/actions/workflows/ci.yml)

> Powering Africa with affordable, pay-as-you-go solar energy on blockchain.

Stellar SolarGrid is a decentralized PAYG solar energy platform built on [Soroban](https://soroban.stellar.org), within the Stellar ecosystem. Households and small businesses in underserved regions access solar electricity through flexible micro-payments — no large upfront costs required.

## Architecture

```
stellar-solar-grid/
├── contracts/        # Soroban smart contracts (Rust)
├── frontend/         # React + TypeScript user/provider dashboards
├── backend/          # Node.js API + IoT smart meter bridge
└── README.md
```

## Core Features

- **Smart Meter Integration** — IoT meters with real-time usage monitoring and on/off control
- **Flexible Payment Plans** — Daily, weekly, or usage-based micro-payments in stablecoins
- **Automated Access Control** — Smart contracts enable/disable electricity based on payment status
- **Energy Usage Tracking** — Dashboards for users and providers

## Getting Started

### Prerequisites

- [Rust](https://rustup.rs/) + `wasm32-unknown-unknown` target
- [Stellar CLI](https://developers.stellar.org/docs/tools/developer-tools/cli/stellar-cli)
- Node.js >= 18
- [Freighter Wallet](https://freighter.app/) (browser extension)

### Smart Contracts

```bash
cd contracts
cargo build --target wasm32-unknown-unknown --release
stellar contract deploy --wasm target/wasm32-unknown-unknown/release/solar_grid.wasm --network testnet
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

### Backend

```bash
cd backend
npm install
npm run dev
```

## Smart Contract Overview

The `SolarGrid` contract manages:

| Function | Description |
|---|---|
| `register_meter(meter_id, owner)` | Register a new smart meter |
| `make_payment(meter_id, amount, plan)` | Pay for energy access |
| `check_access(meter_id)` | Check if meter is currently active |
| `get_usage(meter_id)` | Retrieve usage data |
| `update_usage(meter_id, units)` | Called by IoT oracle to update consumption |

## Contract Upgrades

The `Meter` struct carries a `version: u32` field (currently `1`). When the struct layout changes in a future release, existing persistent storage entries must be migrated before they can be read by the new code.

### Migration flow

1. Deploy the new contract WASM (the old entries remain in persistent storage).
2. For each registered meter, call the admin-only `migrate_meter(meter_id)` function.  
   It reads the entry as the previous schema (`LegacyMeter`) and writes it back as the current `Meter` v1.
3. Once all entries are migrated, the `LegacyMeter` type and `migrate_meter_v0` helper can be removed in a subsequent release.

```bash
# Example: migrate a single meter via Stellar CLI
stellar contract invoke \
  --id <CONTRACT_ID> \
  --source <ADMIN_SECRET> \
  --network testnet \
  -- migrate_meter --meter_id METER1
```

> **Note:** `migrate_meter` is idempotent per entry — calling it on an already-migrated meter will overwrite with the same data. Always test migrations on testnet before mainnet.

## Network

Deployed on Stellar Testnet. Switch to Mainnet for production.

## Deployment Security

- **Never commit `.env` files.** Copy `.env.example` to `.env` and populate locally.
- `ADMIN_SECRET_KEY` is loaded once at backend startup into a `Keypair` object; the raw secret string is not referenced anywhere after module initialisation.
- All error handlers log only `err.message` — raw error objects (which may contain XDR or serialised environment variables) are never logged.
- Enable secret scanning in CI (e.g. `git-secrets`, GitHub secret scanning) to prevent accidental key commits.

## License

MIT
