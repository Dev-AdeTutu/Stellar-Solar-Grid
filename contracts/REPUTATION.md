# Reputation-Based Credit Scoring

This document describes the on-chain reputation system that enables credit assessment for unbanked users using verifiable payment history. The system tracks payment behavior, computes a privacy-preserving reputation score in the range **0–100**, integrates with Decentralized Identifiers (DIDs), and makes reputation portable across platforms.

---

## 1. Overview

Traditional credit scores rely on centralized bureaus and bank accounts, excluding users who operate primarily on-chain or in cash. This system replaces that dependency with a transparent, on-chain reputation model:

- **Payment history** (timeliness, amounts, consistency) is recorded on-chain.
- A **deterministic scoring algorithm** maps history to a `0–100` score.
- Scores are bound to a **DID** so they are self-sovereign and portable.
- Computation is **privacy-preserving**: raw payment details are never exposed; only commitments and aggregate signals are published.

---

## 2. On-Chain Data Model

### 2.1 `ReputationProfile`

One profile per DID. Stores aggregate state, not raw transaction logs.

| Field | Type | Description |
|-------|------|-------------|
| `did` | `bytes32` | Hash of the subject's DID (never the raw DID string). |
| `totalPayments` | `uint64` | Count of recorded payments. |
| `onTimePayments` | `uint64` | Count of payments made on or before due date. |
| `latePayments` | `uint64` | Count of payments made after due date. |
| `missedPayments` | `uint64` | Count of payments never made / defaulted. |
| `totalAmountPaid` | `uint128` | Sum of amounts paid (in base units). |
| `totalAmountDue` | `uint128` | Sum of amounts due. |
| `weightedTimeliness` | `uint256` | Accumulated timeliness weight (see §3.2). |
| `firstActivityAt` | `uint64` | Timestamp of first recorded payment. |
| `lastActivityAt` | `uint64` | Timestamp of most recent payment. |
| `score` | `uint8` | Cached reputation score (0–100). |
| `scoreUpdatedAt` | `uint64` | Timestamp of last score computation. |
| `commitment` | `bytes32` | Commitment to the underlying history (see §5). |

### 2.2 `PaymentRecord` (commitment-only)

Raw payment records are **not** stored in plaintext. Instead, each payment is committed:

```
commitment = keccak256(abi.encode(paymentId, amount, dueDate, paidDate, salt))
```

Only the commitment and the derived aggregate deltas are written on-chain. The full record can be revealed selectively to a verifier (e.g., a lender) without exposing it to everyone.

### 2.3 Events

| Event | Purpose |
|-------|---------|
| `PaymentRecorded(bytes32 indexed didHash, bytes32 commitment, uint8 outcome)` | Emitted when a payment outcome is recorded. `outcome`: 0 = on-time, 1 = late, 2 = missed. |
| `ScoreUpdated(bytes32 indexed didHash, uint8 oldScore, uint8 newScore)` | Emitted when the cached score changes. |
| `DIDLinked(bytes32 indexed didHash, bytes32 indexed controller)` | Emitted when a DID is bound to a controller key. |

---

## 3. Scoring Algorithm (0–100)

The score is a weighted combination of three components, each normalized to `0–100`, then combined and clamped.

### 3.1 Components

1. **Timeliness (T)** — how reliably payments are made on time.
2. **Volume (V)** — total value paid relative to value due.
3. **Consistency (C)** — regularity and longevity of payment activity.

### 3.2 Timeliness

Each payment contributes a weight based on how early/late it was:

```
weight = clamp(1.0 - (daysLate / MAX_LATE_DAYS), 0, 1)   // MAX_LATE_DAYS = 30
```

- On-time or early → `weight = 1.0`
- Missed → `weight = 0`
- `weightedTimeliness` accumulates `weight` per payment.

```
T = (weightedTimeliness / totalPayments) * 100
```

### 3.3 Volume

```
V = min(totalAmountPaid / totalAmountDue, 1.0) * 100
```

If `totalAmountDue == 0`, `V = 0`.

### 3.4 Consistency

Consistency rewards a track record: more payments and a longer active span increase confidence.

```
spanDays   = (lastActivityAt - firstActivityAt) / 1 day
countFactor = min(totalPayments / MIN_PAYMENTS_FOR_FULL, 1.0)   // MIN_PAYMENTS_FOR_FULL = 12
spanFactor  = min(spanDays / MIN_SPAN_DAYS_FOR_FULL, 1.0)       // MIN_SPAN_DAYS_FOR_FULL = 180
C = ((countFactor + spanFactor) / 2) * 100
```

### 3.5 Final Score

```
rawScore = (W_T * T) + (W_V * V) + (W_C * C)
score    = clamp(round(rawScore), 0, 100)
```

Default weights (governance-adjustable):

| Weight | Value |
|--------|-------|
| `W_T` (timeliness) | 0.50 |
| `W_V` (volume) | 0.30 |
| `W_C` (consistency) | 0.20 |

### 3.6 Score Bands

| Band | Range | Interpretation |
|------|-------|----------------|
| Poor | 0–39 | Insufficient or poor history |
| Fair | 40–59 | Emerging history |
| Good | 60–79 | Reliable payer |
| Excellent | 80–100 | Strong, consistent record |

### 3.7 Determinism & Integer Math

All arithmetic is performed with fixed-point integers (scaled by `1e4`) to avoid floating-point nondeterminism across EVM implementations. The same inputs always yield the same score.

---

## 4. DID Integration

### 4.1 Binding

A DID is bound to a controller key via `DIDLinked`. The contract stores only `didHash = keccak256(did)`, never the raw DID, preserving privacy while allowing the subject to prove ownership off-chain.

### 4.2 Verification Flow

1. Subject presents their DID and a signature from the controller key.
2. Verifier recomputes `didHash` and checks `DIDLinked`.
3. Verifier reads the cached `score` and `commitment`.
4. Optionally, subject reveals selected payment records whose commitments match, proving specific history without exposing the rest.

### 4.3 Self-Sovereignty

- The subject controls their DID and can authorize score reads.
- No central authority can alter history; only valid payment outcomes update aggregates.
- The subject may revoke a controller key and re-link a new one.

---

## 5. Privacy-Preserving Computation

### 5.1 Commitments

Raw payment data is hidden behind `keccak256` commitments (§2.2). The chain stores only aggregates and commitments.

### 5.2 Aggregate-Only On-Chain State

The `ReputationProfile` exposes only counts, sums, and the final score — never individual amounts, dates, or counterparties.

### 5.3 Selective Disclosure

To prove a specific payment, the subject reveals `(paymentId, amount, dueDate, paidDate, salt)`; the verifier recomputes the commitment and checks it against the recorded value. This is zero-knowledge-friendly: a ZK proof of "commitment opens to a valid on-time payment" can replace full disclosure.

### 5.4 Score Computation Privacy

Score computation reads only aggregate fields already on-chain. Off-chain verifiers can recompute the score from the same aggregates to independently validate the cached value without additional data exposure.

### 5.5 Data Minimization

- No PII on-chain.
- DIDs are hashed.
- Payment counterparties are not recorded.

---

## 6. Portability Across Platforms

Reputation is designed to move with the user:

- **DID-anchored**: the score belongs to the DID, not to a platform.
- **Standard interface**: any platform can read `score`, `commitment`, and aggregates via a stable read API.
- **Verifiable export**: a platform can export a signed snapshot `(didHash, score, scoreUpdatedAt, commitment)` that other platforms verify against on-chain state.
- **Cross-platform aggregation**: multiple platforms can record payments against the same `didHash`, contributing to a single unified reputation.
- **No lock-in**: because computation is deterministic and inputs are public aggregates, any party can recompute and confirm the score.

### 6.1 Read API (conceptual)

```solidity
function getScore(bytes32 didHash) external view returns (uint8 score, uint64 updatedAt);
function getProfile(bytes32 didHash) external view returns (ReputationProfile memory);
function verifyCommitment(bytes32 didHash, bytes32 commitment) external view returns (bool);
```

---

## 7. Security Considerations

- **Sybil resistance**: scores require real payment history; empty profiles score `0`.
- **Manipulation resistance**: weights and thresholds are governance-controlled and changes are logged.
- **Replay protection**: commitments include a unique `paymentId` and `salt`.
- **Access control**: only authorized recorders (e.g., integrated platforms) may submit payment outcomes for a DID they are permitted to attest.
- **Freshness**: `scoreUpdatedAt` lets verifiers reject stale scores.

---

## 8. Running the Tests

### 8.1 Contract Tests

```bash
# From repository root
npm install
npx hardhat compile
npx hardhat test test/Reputation.test.js
```

The contract test suite covers:

- Profile creation and DID linking
- Payment recording (on-time, late, missed)
- Timeliness, volume, and consistency component math
- Final score computation and clamping to `0–100`
- Commitment creation and verification
- Access control on recorders
- Event emission
- Score caching and `scoreUpdatedAt` freshness

### 8.2 Backend Tests

```bash
# From repository root
cd backend
npm install
npm test -- --grep "reputation"
```

The backend suite covers:

- Score recomputation parity with on-chain results
- DID resolution and hashing
- Commitment verification
- Portability export/import of signed snapshots
- Privacy checks (no PII leakage in API responses)

### 8.3 Full Suite

```bash
npm run test:all
```

---

## 9. Definition of Done Checklist

- ✅ Track payment history, timeliness, amounts
- ✅ Calculate reputation score (0–100)
- ✅ Integrate with DID (Decentralized Identifiers)
- ✅ Portable reputation across platforms
- ✅ Privacy-preserving score computation
- ✅ Tests for reputation system
- ✅ Documented in `contracts/REPUTATION.md`