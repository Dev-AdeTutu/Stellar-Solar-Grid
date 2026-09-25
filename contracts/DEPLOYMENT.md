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

## Release checklist

- [ ] Review the WASM hash in `.deployments/<network>-wasm.sha256`.
- [ ] Deploy to local and testnet first.
- [ ] Run the contract test suite and post-deployment health checks.
- [ ] Record contract ID, network, hash, and operator in the release notes.
- [ ] Keep the previous contract ID available for application rollback.
- [ ] Obtain a second review before enabling mainnet deployment.
