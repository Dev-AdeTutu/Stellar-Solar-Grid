.PHONY: build test coverage deploy

build:
	cargo build --target wasm32v1-none --release

test:
	cargo test --all-targets

# Requires: rustup component add llvm-tools-preview && cargo install cargo-llvm-cov
coverage:
	cargo llvm-cov --all-targets --html --fail-under-lines 90

deploy:
	stellar contract deploy --wasm target/wasm32v1-none/release/solar_grid.wasm --network testnet
