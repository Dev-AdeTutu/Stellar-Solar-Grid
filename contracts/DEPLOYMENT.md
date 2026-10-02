# Contract deployment

The deployment flow builds a reproducible WASM artifact, records its SHA-256 digest, deploys to the selected network, initializes the contract, and verifies that the contract responds. It supports `local`, `testnet`, and `mainnet` targets.

## Prerequisites

Install Rust, the Stellar CLI, and configure a funded deployer key. Set `ADMIN_SECRET_KEY` and `TOKEN_ADDRESS` in the environment; never commit either value.

```bash
export ADMIN_SECRET_KEY=deployer
export TOKEN_ADDRESS=C...
```

## Deploy

```bash
scripts/deploy.sh --network local
scripts/deploy.sh --network testnet
ALLOW_MAINNET_DEPLOY=1 scripts/deploy.sh --network mainnet
```

Mainnet requires the explicit `ALLOW_MAINNET_DEPLOY=1` safety switch. The script stores the deployed contract ID and artifact hash under `.deployments/`, which is ignored by Git.

To verify an existing deployment without redeploying:

```bash
scripts/deploy.sh --network testnet --contract-id C...
```

## Rollback

Soroban WASM deployments are immutable. Rollback means routing application configuration to the previously verified contract ID, not deleting chain history. Keep the previous ID in the release record, restore `NEXT_PUBLIC_CONTRACT_ID` and backend `CONTRACT_ID`, and redeploy the application. If initialization or verification fails, the script exits non-zero and removes only the local deployment pointer; it does not attempt destructive on-chain operations.

## Governed contract upgrades

Soroban upgrades replace the WASM implementation at the existing contract address; they do not use an EVM-style delegatecall proxy. Contract storage and address are preserved. The upgrade is requested with `AdminOperation::UpgradeContract(wasm_hash, version)` through the on-chain admin proposal flow. Configure 3–5 distinct multisig admins with a threshold of at least 2 before proposing an upgrade. Each approval must come from a distinct configured admin, and the proposal expires at its declared ledger timestamp. The contract version is updated atomically with the WASM change.

Build and upload the candidate WASM, record its hash and semantic version, and test it against a copy of the target contract state on local/testnet before proposing it on the production contract. New state layouts must use versioned, idempotent migration functions; run the migration and verify representative state before directing clients to the upgraded code. Keep the prior WASM hash and deployment record. If the new implementation is faulty, propose a new multisig upgrade to the previously verified WASM hash and matching version; client configuration rollback to a prior contract ID is only applicable when restoring a separate deployment.

This process is not a substitute for an independent security audit. Mainnet upgrades remain gated on the release checklist and a separate security review.

## Release checklist

- [ ] Review the WASM hash in `.deployments/<network>-wasm.sha256`.
- [ ] Deploy to local and testnet first.
- [ ] Run the contract test suite and post-deployment health checks.
- [ ] Record contract ID, network, hash, and operator in the release notes.
- [ ] Keep the previous contract ID available for application rollback.
- [ ] Obtain a second review before enabling mainnet deployment.
