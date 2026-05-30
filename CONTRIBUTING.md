# Contributing to Stellar SolarGrid

Thanks for helping improve Stellar SolarGrid. This guide explains how to set up the backend, frontend, and Soroban contract locally, plus the conventions maintainers expect in pull requests.

## Prerequisites

- Node.js 20.x
- npm 10.x or the npm version bundled with Node 20
- Rust stable via [rustup](https://rustup.rs/)
- `wasm32-unknown-unknown` Rust target
- [Stellar CLI](https://developers.stellar.org/docs/tools/developer-tools/cli/stellar-cli)
- A local MQTT broker such as Mosquitto
- Freighter Wallet for browser-based testnet flows

Install the Rust WASM target once:

```bash
rustup target add wasm32-unknown-unknown
```

If you use Mosquitto with the included config, run it from the repo root:

```bash
mosquitto -c mosquitto.conf
```

## Local Setup

Fork the repository, clone your fork, and add the upstream remote:

```bash
git clone https://github.com/YOUR_USERNAME/Stellar-Solar-Grid.git
cd Stellar-Solar-Grid
git remote add upstream https://github.com/Dev-AdeTutu/Stellar-Solar-Grid.git
```

Create a branch from `main` before making changes:

```bash
git fetch upstream
git checkout main
git rebase upstream/main
git checkout -b docs/update-contributing-guide
```

## Backend

The backend is a Node.js TypeScript API with an IoT MQTT bridge.

```bash
cd backend
npm install
npm run dev
```

Useful backend commands:

```bash
npm run build
npm run test:e2e
```

The backend stores local usage events in `backend/data/usage-events.sqlite` by default. Set `USAGE_EVENTS_DB_PATH` to use another SQLite file.

## Frontend

The frontend is a Next.js TypeScript app.

```bash
cd frontend
npm install
npm run dev
```

Useful frontend commands:

```bash
npm run build
npm run lint
npm run test
```

## Smart Contract

The Soroban contract lives under `contracts/`.

```bash
cd contracts
cargo build --target wasm32-unknown-unknown --release
cargo test
```

Format and lint Rust changes before opening a PR:

```bash
cargo fmt
cargo clippy -- -D warnings
```

## Testnet Deployment

Build the contract WASM first:

```bash
cd contracts
cargo build --target wasm32-unknown-unknown --release
```

Deploy to testnet with Stellar CLI:

```bash
stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/solar_grid.wasm \
  --network testnet
```

Prefer passing the admin and token address through the constructor or the same deployment flow. Do not leave a new deployment uninitialized.

## Branch Naming

Use short, descriptive branch names with one of these prefixes:

- `feat/` for new features
- `fix/` for bug fixes
- `refactor/` for internal restructuring
- `docs/` for documentation-only changes

Examples:

```text
feat/provider-dashboard-filter
fix/meter-access-expiry
refactor/payment-service-errors
docs/contributing-guide
```

## Commit Messages

Use Conventional Commits:

```text
feat: add weekly payment plan support
fix: handle expired meter access
refactor: split payment validation helpers
docs: update contract deployment steps
test: add payment flow coverage
```

Keep commits focused. If a change mixes docs, frontend, backend, and contract behavior, split it into separate commits or PRs when practical.

## Pull Request Checklist

Before opening a PR:

- [ ] Branch is rebased on the latest `upstream/main`
- [ ] Backend build passes when backend code changes
- [ ] Frontend build, lint, and tests pass when frontend code changes
- [ ] `cargo test` passes when contract code changes
- [ ] New behavior has tests or a clear reason tests were not added
- [ ] README or docs are updated when setup, APIs, or workflows change
- [ ] No secrets, `.env` files, private keys, or testnet seed phrases are committed
- [ ] PR description explains the reason for the change and links the issue

## Review Process

Open your PR against `main` and link the relevant issue with `Closes #123` or `Fixes #123`. Keep the PR focused on the issue scope and respond to maintainer feedback promptly.

## Code of Conduct

All contributors are expected to follow the project [Code of Conduct](CODE_OF_CONDUCT.md). Keep discussions respectful, technical, and focused on improving the project.
