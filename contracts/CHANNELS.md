# Blockchain State Channels

This document describes the state channel implementation used to scale usage-based billing. Instead of submitting an on-chain transaction for every usage update, participants open a payment channel once, exchange signed usage updates off-chain, and settle the final balance on-chain periodically. This reduces on-chain transaction costs by 90%+.

## Overview

A state channel is a relationship between a **user** and the **billing contract** that allows many off-chain micro-transactions to be aggregated into a small number of on-chain operations.

- **Opening** a channel requires one on-chain transaction.
- **Usage updates** are exchanged off-chain as signed messages (zero on-chain cost).
- **Settlement** commits the latest agreed balance on-chain (one transaction per settlement period).
- **Disputes** are resolved on-chain using the signed updates as evidence.

## Channel Lifecycle

```
   open()            update() x N (off-chain)          settle()
User ──► Contract ──────────────────────────────► Contract ──► Funds released
         (on-chain)        (signed messages)        (on-chain)
                          │
                          └──► dispute() (on-chain, only if needed)
```

### 1. Open

The user opens a channel by calling `openChannel(counterparty, deposit, challengePeriod)` and depositing funds. The contract records:

- `channelId` — unique identifier (hash of participants and nonce)
- `user` and `contract` participants
- `deposit` — funds locked in the channel
- `nonce` — monotonically increasing sequence number for updates
- `challengePeriod` — time window allowed for disputes after settlement is requested
- `status` — `Open`, `Closing`, or `Closed`

### 2. Off-chain updates

While the channel is `Open`, the user and contract exchange signed usage updates off-chain. Each update contains:

- `channelId`
- `nonce` (must strictly increase)
- `cumulativeUsage` — total usage billed so far
- `balance` — resulting balance split between user and contract
- signatures from both parties

No gas is spent for these updates. The latest mutually signed update is the authoritative state.

### 3. Close / settle

Either party may request settlement by submitting the latest signed update on-chain via `settle(channelId, update, signatures)`. The contract:

1. Verifies both signatures and that `nonce` is newer than the last settled nonce.
2. Starts the `challengePeriod` timer.
3. If no dispute is raised before the timer expires, `finalize(channelId)` releases funds according to the settled balance.

Settlement can be performed periodically (e.g. daily or when a usage threshold is reached) to bound the amount at risk while still amortizing gas across many updates.

### 4. Dispute resolution

If a party submits a stale or fraudulent update, the counterparty can call `dispute(channelId, update, signatures)` during the challenge period with a newer signed update. The contract:

1. Verifies the disputing update's signatures and that its `nonce` is higher than the challenged update.
2. Replaces the pending settlement with the newer update.
3. Restarts the challenge period.

The highest-nonce validly signed update always wins. If the challenge period elapses with no higher-nonce dispute, the pending update is finalized. This guarantees that an honest party holding the latest signed update can always recover the correct balance.

## Off-chain Update Signing

Updates are signed using ECDSA over the EIP-712 typed-data hash of the `ChannelUpdate` struct:

```solidity
struct ChannelUpdate {
    bytes32 channelId;
    uint256 nonce;
    uint256 cumulativeUsage;
    uint256 userBalance;
    uint256 contractBalance;
}
```

Signing procedure (off-chain):

1. Build the `ChannelUpdate` with the next `nonce`.
2. Compute the EIP-712 digest using the contract's domain separator.
3. Each party signs the digest with their private key.
4. Exchange signatures; both parties store the latest fully signed update.

The contract recovers signers via `ecrecover` and requires both the user and contract signatures to match the channel participants.

## Periodic Settlement

To keep on-chain costs low while limiting exposure:

- Updates are batched off-chain and settled when a configurable threshold is reached (usage amount, time interval, or channel balance).
- Each settlement is a single transaction regardless of how many updates it covers.
- The `nonce` ensures only the newest update is ever committed; older submissions are rejected.

## Cost Savings

| Operation | On-chain txns (naive) | On-chain txns (channels) |
|-----------|-----------------------|--------------------------|
| 1,000 usage updates | 1,000 | 1 open + 1 settle = 2 |
| Relative cost | 100% | ~0.2% |

By moving per-update accounting off-chain, on-chain transaction costs are reduced by well over 90% for typical usage volumes.

## API Endpoints

### Contract functions

| Function | Description |
|----------|-------------|
| `openChannel(address counterparty, uint256 deposit, uint256 challengePeriod) returns (bytes32)` | Opens a channel and locks the deposit. |
| `settle(bytes32 channelId, ChannelUpdate update, bytes userSig, bytes contractSig)` | Submits the latest signed update and starts the challenge period. |
| `dispute(bytes32 channelId, ChannelUpdate update, bytes userSig, bytes contractSig)` | Challenges a pending settlement with a higher-nonce update. |
| `finalize(bytes32 channelId)` | Releases funds after the challenge period elapses. |
| `closeChannel(bytes32 channelId)` | Cooperative close using the latest agreed update. |
| `getChannel(bytes32 channelId) returns (Channel)` | Returns channel state (status, nonce, balances, deadline). |

### Off-chain service endpoints

| Endpoint | Description |
|----------|-------------|
| `POST /channels` | Open a channel (wraps `openChannel`). |
| `POST /channels/:id/updates` | Submit a signed usage update off-chain. |
| `GET /channels/:id` | Fetch current channel state and latest update. |
| `POST /channels/:id/settle` | Trigger on-chain settlement of the latest update. |
| `POST /channels/:id/dispute` | Submit a dispute with a higher-nonce update. |
| `GET /channels/:id/updates` | List signed updates for a channel. |

## Events

- `ChannelOpened(channelId, user, counterparty, deposit)`
- `ChannelSettled(channelId, nonce, userBalance, contractBalance)`
- `ChannelDisputed(channelId, nonce, disputer)`
- `ChannelFinalized(channelId, nonce, userBalance, contractBalance)`
- `ChannelClosed(channelId)`

## Security Considerations

- **Nonce monotonicity** prevents replay and stale-update attacks.
- **Challenge period** gives honest parties time to dispute fraudulent settlements.
- **Signature verification** ensures only channel participants can advance state.
- **Deposit bounds** cap the maximum value at risk per channel.
- **Reentrancy guards** protect fund release paths.

## Testing

Channel lifecycle tests cover:

- Opening a channel and depositing funds.
- Applying off-chain updates and verifying signature checks.
- Periodic settlement and finalization after the challenge period.
- Dispute with a higher-nonce update replacing a stale settlement.
- Rejection of stale, replayed, or improperly signed updates.
- Cooperative close and fund distribution correctness.