# Cross-Chain Bridge for Multi-Blockchain Support (`contracts/bridge`)

## Overview

The Stellar Solar Grid Cross-Chain Bridge enables seamless interoperability between the **Stellar (Soroban)** network and EVM-compatible blockchains including **Ethereum**, **Polygon**, and **Arbitrum**.

## Architecture

1. **Stellar Bridge Contract (`contracts/bridge/src/lib.rs`)**:
   - Locks native `SOLAR` liquidity on Stellar (`wrap_to_chain`) and emits verifiable `BridgeReceipt` records with monotonic nonces.
   - Verifies external burn proofs (`unwrap_from_chain`) to release native `SOLAR` tokens back to users on Stellar.
   - Aggregates balances across Stellar, Ethereum, Polygon, and Arbitrum via `unified_balance`.
   - Processes direct cross-chain utility meter payments (`cross_chain_payment`).

2. **Target Chain EVM Contract (`contracts/bridge/evm/SolarGridBridge.sol`)**:
   - Mints wrapped `wSOLAR` tokens upon verified Stellar lock events (`mintWrapped`).
   - Burns `wSOLAR` on unwrap requests (`burnAndUnwrap`) and cross-chain meter payments (`paySolarMeterCrossChain`).

3. **Frontend Multi-Chain Portal (`frontend/src/components/CrossChainBridgePortal.tsx`)**:
   - Provides an interactive chain selector, unified multi-chain balance view, wrap/unwrap controls, and cross-chain meter payment settlement.

---

## Security Audit Report

| Control Area | Vulnerability Checked | Mitigation Implemented | Status |
| :--- | :--- | :--- | :--- |
| **Replay Protection** | Duplicate redemption of cross-chain unwrap proofs | Strictly tracks `ProcessedNonce(external_nonce)` on Soroban and `processedStellarNonces[stellarNonce]` on EVM | Passed |
| **Liquidity Invariant** | Unwrapping more tokens than locked on Stellar | Enforces `LockedLiquidity >= amount` and `WrappedBalance >= amount` prior to state mutation | Passed |
| **Emergency Circuit Breaker** | Exploit or validator compromise on external chain | Admin-authenticated `set_paused` / `whenNotPaused` guard halts wrap, unwrap, and payment entrypoints | Passed |
| **Authorization** | Unauthorized token locking or burning | Enforces `sender.require_auth()` on Soroban and `msg.sender` balance checks on EVM | Passed |
