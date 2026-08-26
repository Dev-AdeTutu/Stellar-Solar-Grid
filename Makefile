.PHONY: build test deploy invoke-register invoke-allowlist migrate-all logs clean

NETWORK  ?= testnet
WASM     := contracts/target/wasm32-unknown-unknown/release/solar_grid.wasm

build:
	cd contracts && cargo build --target wasm32-unknown-unknown --release

test:
	cd contracts && cargo test

deploy: build
	stellar contract deploy --wasm $(WASM) --source $(ADMIN_SECRET_KEY) --network $(NETWORK)

invoke-register:
	stellar contract invoke --id $(CONTRACT_ID) --source $(ADMIN_SECRET_KEY) --network $(NETWORK) -- register_meter --meter_id $(METER_ID) --owner $(OWNER)

invoke-allowlist:
	stellar contract invoke --id $(CONTRACT_ID) --source $(ADMIN_SECRET_KEY) --network $(NETWORK) -- allowlist_add --owner $(OWNER)

## Bulk-migrate all registered meters to the current schema.
##
## Closes #536: replaces the manual one-at-a-time stellar contract invoke
## … migrate_meter workflow with a single command.
##
## Required:
##   CONTRACT_ID       — deployed Soroban contract address
##   ADMIN_SECRET_KEY  — admin Stellar secret key (S…)
##
## Optional:
##   NETWORK           — testnet (default) or mainnet
##   DRY_RUN           — set to "true" to list meters without migrating
##
## Example:
##   make migrate-all CONTRACT_ID=C... ADMIN_SECRET_KEY=S...
##   make migrate-all CONTRACT_ID=C... ADMIN_SECRET_KEY=S... DRY_RUN=true
migrate-all:
	@if [ -z "$(CONTRACT_ID)" ]; then \
	  echo "ERROR: CONTRACT_ID is required.  Usage: make migrate-all CONTRACT_ID=C... ADMIN_SECRET_KEY=S..."; \
	  exit 1; \
	fi
	@if [ -z "$(ADMIN_SECRET_KEY)" ]; then \
	  echo "ERROR: ADMIN_SECRET_KEY is required.  Usage: make migrate-all CONTRACT_ID=C... ADMIN_SECRET_KEY=S..."; \
	  exit 1; \
	fi
	CONTRACT_ID=$(CONTRACT_ID) \
	ADMIN_SECRET_KEY=$(ADMIN_SECRET_KEY) \
	STELLAR_NETWORK=$(NETWORK) \
	DRY_RUN=$(DRY_RUN) \
	node scripts/migrate-all.js

logs:
	docker compose logs -f backend

clean:
	cd contracts && cargo clean
