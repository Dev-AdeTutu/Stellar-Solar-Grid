.PHONY: build test deploy invoke-register invoke-allowlist logs clean

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

logs:
	docker compose logs -f backend

clean:
	cd contracts && cargo clean
