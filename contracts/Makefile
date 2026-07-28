.PHONY: build test deploy

build:
	cargo build --target wasm32-unknown-unknown --release

test:
	cargo test

deploy:
	stellar contract deploy --wasm target/wasm32-unknown-unknown/release/solar_grid.wasm --network testnet
