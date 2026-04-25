# Contributing to Stellar SolarGrid

Thanks for your interest in contributing! This guide covers everything you need to get up and running.

## Table of Contents

- [Getting Started](#getting-started)
- [Project Structure](#project-structure)
- [Development Setup](#development-setup)
- [Coding Standards](#coding-standards)
- [Submitting a Pull Request](#submitting-a-pull-request)

---

## Getting Started

1. Fork the repository and clone your fork:
   ```bash
   git clone https://github.com/YOUR_USERNAME/Stellar-Solar-Grid.git
   cd Stellar-Solar-Grid
   ```

2. Add the upstream remote:
   ```bash
   git remote add upstream https://github.com/ORIGINAL_OWNER/Stellar-Solar-Grid.git
   ```

3. Create a feature branch off `main`:
   ```bash
   git checkout -b feat/your-feature-name
   ```

---

## Project Structure

```
Stellar-Solar-Grid/
├── contracts/     # Soroban smart contracts (Rust)
├── frontend/      # React + TypeScript dashboards (Vite)
└── backend/       # Node.js API + IoT MQTT bridge (Express + tsx)
```

---

## Development Setup

### Prerequisites

| Tool | Version |
|------|---------|
| Node.js | >= 18 |
| Rust | stable (via [rustup](https://rustup.rs/)) |
| Stellar CLI | latest |
| Freighter Wallet | browser extension |

Add the WASM target once after installing Rust:
```bash
rustup target add wasm32-unknown-unknown
```

### Smart Contracts

```bash
cd contracts
cargo build --target wasm32-unknown-unknown --release
```

Deploy to testnet:
```bash
stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/solar_grid.wasm \
  --network testnet
```

### Frontend

```bash
cd frontend
cp .env.example .env        # fill in your contract ID and network
npm install
npm run dev
```

### Backend

```bash
cd backend
cp .env.example .env        # fill in your Stellar keys and MQTT config
npm install
npm run dev
```

---

## Coding Standards

### TypeScript (frontend & backend)

- Use TypeScript strict mode — no `any` unless absolutely necessary.
- Prefer `const` over `let`; avoid `var`.
- Name files in `kebab-case`, components in `PascalCase`.
- Keep functions small and single-purpose.
- Run `tsc --noEmit` before committing to catch type errors.

### Rust (contracts)

- Follow standard Rust formatting: `cargo fmt` before every commit.
- Run `cargo clippy -- -D warnings` and fix all warnings.
- Document public functions with `///` doc comments.
- Avoid `unwrap()` in contract code — handle errors explicitly.

### General

- No commented-out dead code in PRs.
- Keep commits atomic and write meaningful commit messages using [Conventional Commits](https://www.conventionalcommits.org/):
  ```
  feat: add weekly payment plan support
  fix: correct meter access check logic
  docs: update contract deployment steps
  ```

---

## Submitting a Pull Request

1. Sync with upstream before opening a PR:
   ```bash
   git fetch upstream
   git rebase upstream/main
   ```

2. Make sure the project builds cleanly:
   ```bash
   # Contracts
   cargo build --target wasm32-unknown-unknown --release

   # Frontend
   cd frontend && npm run build

   # Backend
   cd backend && npm run build
   ```

3. Push your branch and open a PR against `main`.

4. Fill out the pull request template completely.

5. A maintainer will review your PR. Please respond to feedback promptly and keep the branch up to date.

### PR Checklist

- [ ] Code builds without errors or warnings
- [ ] Existing functionality is not broken
- [ ] New logic is reasonably self-documenting or commented
- [ ] PR description explains the *why*, not just the *what*

---

For questions, open a [Discussion](../../discussions) or drop a comment on the relevant issue.
