# Stellar SolarGrid

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

| Function                               | Description                                |
| -------------------------------------- | ------------------------------------------ |
| `register_meter(meter_id, owner)`      | Register a new smart meter                 |
| `make_payment(meter_id, amount, plan)` | Pay for energy access                      |
| `check_access(meter_id)`               | Check if meter is currently active         |
| `get_usage(meter_id)`                  | Retrieve usage data                        |
| `update_usage(meter_id, units)`        | Called by IoT oracle to update consumption |

### Event Schema

The contract emits Soroban events for off-chain indexing and backend automation:

| Function       | Topic                   | Data                                |
| -------------- | ----------------------- | ----------------------------------- |
| `make_payment` | `("payment", meter_id)` | `(payer, amount, ledger_timestamp)` |
| `update_usage` | `("usage", meter_id)`   | `(units, cost, meter_balance)`      |
| `set_active`   | `("access", meter_id)`  | `active`                            |

The backend event indexer subscribes to these contract events and stores parsed records for downstream processing.

## Network

Deployed on Stellar Testnet. Switch to Mainnet for production.

## License

MIT
