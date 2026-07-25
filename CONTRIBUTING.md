# Contributing to Stellar SolarGrid

Thanks for your interest in contributing! This guide covers everything you need to get up and running.

## Table of Contents

- [Getting Started](#getting-started)
- [Project Structure](#project-structure)
- [Development Setup](#development-setup)
- [Running Tests](#running-tests)
- [Coding Standards](#coding-standards)
- [Security Considerations](#security-considerations)
- [Troubleshooting](#troubleshooting)
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

3. Create a feature branch off `main` using the following branch naming conventions:
   - `feat/` for new features (e.g. `feat/add-payment-flow`)
   - `fix/` for bug fixes (e.g. `fix/meter-validation`)
   - `refactor/` for code restructuring (e.g. `refactor/api-routes`)
   - `docs/` for documentation updates (e.g. `docs/api-guide`)
   - `infra/` for build scripts, Docker, or CI/CD updates (e.g. `infra/docker-setup`)

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

Make sure you have the following installed on your local machine:
- **Node.js**: version 20
- **Rust**: stable version (via [rustup](https://rustup.rs/))
- **wasm32-unknown-unknown target**: installed via `rustup target add wasm32-unknown-unknown`
- **Stellar CLI**: latest version (for deploying and invoking contracts)
- **Docker & Docker Compose**: for running containerized infrastructure (MQTT, checks, etc.)

### Smart Contract Development

We use `make` for common development workflows. You can run these commands from the project root or the `contracts` directory:

- **Build the contract:**
  ```bash
  make build
  ```
- **Run all contract tests:**
  ```bash
  make test
  ```
- **Deploy the contract to testnet:**
  ```bash
  make deploy
  ```

### Local Setup Steps

#### Frontend Setup
1. Navigate to the `frontend` directory:
   ```bash
   cd frontend
   ```
2. Copy the example environment file and configure it:
   ```bash
   cp .env.example .env.local
   ```
3. Install dependencies and start the Vite dev server:
   ```bash
   npm install
   npm run dev
   ```

#### Backend Setup
1. Navigate to the `backend` directory:
   ```bash
   cd backend
   ```
2. Copy the example environment file and configure it:
   ```bash
   cp .env.example .env
   ```
3. Install dependencies and start the Express server:
   ```bash
   npm install
   npm run dev
   ```

### Running the Full Stack with Docker
You can spin up the full stack using docker compose:
```bash
docker compose up --build
```

---

## Running Tests

### Smart Contract Tests

Run the complete test suite:
```bash
cd contracts
cargo test
```

Run specific test modules:
```bash
cargo test test_register_and_payment
cargo test --test integration_tests
```

### Frontend Tests

```bash
cd frontend
npm run test          # Run Jest tests
npm run test:watch    # Run tests in watch mode
npm run test:coverage # Generate coverage report
```

### Backend Tests

```bash
cd backend
npm run test          # Run test suite
npm run test:watch    # Run tests in watch mode
```

### End-to-End Testing

1. Start all services:
   ```bash
   docker-compose up -d
   ```

2. Deploy contract to testnet:
   ```bash
   cd contracts
   stellar contract deploy \
     --wasm target/wasm32-unknown-unknown/release/solar_grid.wasm \
     --network testnet
   ```

3. Update environment files with deployed contract ID
4. Test the complete flow through the frontend dashboard

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
- Keep commits atomic and write meaningful commit messages using the [Conventional Commits](https://www.conventionalcommits.org/) format:
  - `feat(...)`: A new feature (e.g., `feat(infra): add docker-compose validation`)
  - `fix(...)`: A bug fix (e.g., `fix(api): handle connection timeout`)
  - `docs(...)`: Documentation changes
  - `style(...)`: Formatting, semi-colons, etc.
  - `refactor(...)`: Restructuring code without changing behavior
  - `test(...)`: Adding or modifying tests
  - `infra(...)` / `chore(...)`: Infrastructure or dependency updates
  
  Example commit messages:
  ```
  feat: add weekly payment plan support
  fix: correct meter access check logic
  docs: update contract deployment steps
  ```

---

## Security Considerations

### Environment Variables

- Never commit `.env` files or expose secret keys
- Use `.env.example` as a template with placeholder values
- Rotate keys regularly in production environments
- Use different keys for testnet and mainnet

### Smart Contract Security

- All contract functions validate inputs and handle errors explicitly
- Payment amounts are checked for overflow/underflow
- Access control is enforced through allowlists and ownership checks
- Test edge cases thoroughly, especially around balance calculations

### API Security

- All endpoints validate request schemas using Zod
- Rate limiting is implemented for payment endpoints
- Webhook signatures are verified before processing
- CORS is configured appropriately for the frontend domain

---

## Troubleshooting

For a full list of common issues with symptoms, root causes, and step-by-step fixes, see the dedicated **[Troubleshooting Guide](TROUBLESHOOTING.md)**.

### Quick reference

**Contract deployment fails:**
- Ensure you have testnet XLM in your account (`curl "https://friendbot.stellar.org?addr=YOUR_PUBLIC_KEY"`)
- Check that the WASM file was built successfully (`make build`)
- Verify network configuration in Stellar CLI

**Backend fails to start:**
- Check that all required environment variables are set in `backend/.env`
- Ensure MQTT broker is running (`docker compose up mqtt`)
- Verify Stellar RPC endpoint is accessible (`curl https://soroban-testnet.stellar.org/`)

**Frontend build errors:**
- Clear node_modules and reinstall: `rm -rf node_modules package-lock.json && npm install`
- Check that `VITE_CONTRACT_ID` matches the deployed contract
- Ensure Freighter wallet is installed and set to Testnet

**Tests failing:**
- For contract tests: ensure `wasm32-unknown-unknown` target is installed (`rustup target add wasm32-unknown-unknown`)
- For frontend tests: check that test environment variables are set
- For integration tests: ensure all services are running

### Getting Help

- Check existing [Issues](../../issues) for similar problems
- Open a [Discussion](../../discussions) for questions
- Review the [API documentation](backend/API.md) for endpoint details

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

- [ ] Build passes (contracts, frontend, backend)
- [ ] Lint passes successfully without warnings
- [ ] Tests are added or updated for new changes
- [ ] README is updated if any new environment variables or setup steps are introduced

---

For questions, open a [Discussion](../../discussions) or drop a comment on the relevant issue.
