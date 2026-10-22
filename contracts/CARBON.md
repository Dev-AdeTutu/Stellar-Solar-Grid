# Carbon Credit Marketplace

This document describes the carbon credit token model, issuance, verification, price discovery, and marketplace entry points implemented in the carbon credit contracts.

## Overview

The carbon credit marketplace lets users monetize the environmental benefit of solar generation. Solar generation is converted into tokenized carbon credits, which can be verified/certified and then listed for sale on an on-chain order book. Buyers purchase credits at a discovered market price.

## Token Model

- **1 carbon credit = 1 tonne CO2 avoided = 2000 kWh of solar generation.**
- Credits are represented as fungible tokens (ERC-20 style) with a fixed conversion ratio, allowing fractional credits.
- Conversion constant: `KWH_PER_CREDIT = 2000`.
- Credits are minted to the generating user (or their designated beneficiary) upon issuance.
- Each credit carries provenance metadata (generation source, period, verification status) tracked off-token in the registry; the token itself is fungible and interchangeable once certified.

### Units

| Quantity | Value |
| --- | --- |
| 1 credit | 1 tonne CO2 |
| 1 credit | 2000 kWh |
| kWh per credit | 2000 |
| Credits per kWh | 1 / 2000 = 0.0005 |

## Issuance from Solar Generation

Credits are issued automatically based on metered solar generation:

1. A generation oracle or authorized reporter submits a generation reading (in kWh) for a user/installation.
2. The contract computes `credits = kwh / KWH_PER_CREDIT` (with fractional precision).
3. Credits are minted into a **pending** state associated with the generation record.
4. Pending credits become tradable only after verification/certification.

Issuance entry point:

```solidity
function issueCredits(address beneficiary, uint256 kwh, bytes32 generationId) external returns (uint256 credits);
```

- Only authorized issuers (oracle/reporter role) may call `issueCredits`.
- `generationId` prevents double counting of the same generation event.
- Emits `CreditsIssued(beneficiary, generationId, kwh, credits)`.

## Verification and Certification Flow

Pending credits must be verified before they can be traded:

1. **Submitted** — credits minted from a generation reading (pending).
2. **Under review** — a verifier reviews the generation evidence (meter data, installation ID, period).
3. **Certified** — verifier approves; credits move to the tradable balance.
4. **Rejected** — verifier rejects; credits are burned or voided.

Entry points:

```solidity
function certify(bytes32 generationId) external;   // verifier role
function reject(bytes32 generationId) external;    // verifier role
```

- Only addresses with the verifier role may certify or reject.
- Certification emits `CreditsCertified(generationId, credits)`.
- Rejection emits `CreditsRejected(generationId, credits)` and voids the pending credits.

## Price Discovery

Price discovery uses an **on-chain order book** with a derived **index price**.

### Order book

- Sellers place **ask** orders: `(seller, amount, pricePerCredit)`.
- Buyers place **bid** orders: `(buyer, amount, pricePerCredit)`.
- Orders are matched by best price first (highest bid vs. lowest ask); a trade executes when `bidPrice >= askPrice`.
- Partial fills are supported; remaining amounts stay on the book.
- Orders can be cancelled by their owner.

Entry points:

```solidity
function placeAsk(uint256 amount, uint256 pricePerCredit) external returns (uint256 orderId);
function placeBid(uint256 amount, uint256 pricePerCredit) external returns (uint256 orderId);
function cancelOrder(uint256 orderId) external;
```

### Index price

- The **index price** is the last traded price (or a volume-weighted average over a recent window).
- Exposed via `indexPrice()` and updated on each trade.
- Emits `TradeExecuted(buyer, seller, amount, pricePerCredit)`.

## Marketplace API / Contract Entry Points

| Function | Description |
| --- | --- |
| `issueCredits(address beneficiary, uint256 kwh, bytes32 generationId)` | Mint pending credits from solar generation (authorized issuer). |
| `certify(bytes32 generationId)` | Certify pending credits (verifier). |
| `reject(bytes32 generationId)` | Reject and void pending credits (verifier). |
| `balanceOf(address account)` | Tradable credit balance. |
| `pendingBalanceOf(address account)` | Unverified credit balance. |
| `placeAsk(uint256 amount, uint256 pricePerCredit)` | List credits for sale. |
| `placeBid(uint256 amount, uint256 pricePerCredit)` | Place a buy order. |
| `cancelOrder(uint256 orderId)` | Cancel an open order. |
| `indexPrice()` | Current index price per credit. |
| `bestAsk()` / `bestBid()` | Top of book. |

### Events

- `CreditsIssued(address indexed beneficiary, bytes32 generationId, uint256 kwh, uint256 credits)`
- `CreditsCertified(bytes32 indexed generationId, uint256 credits)`
- `CreditsRejected(bytes32 indexed generationId, uint256 credits)`
- `OrderPlaced(uint256 indexed orderId, address indexed owner, bool isAsk, uint256 amount, uint256 pricePerCredit)`
- `OrderCancelled(uint256 indexed orderId)`
- `TradeExecuted(address indexed buyer, address indexed seller, uint256 amount, uint256 pricePerCredit)`

## Security Considerations

- **Role-based access**: issuance restricted to authorized issuers; certification restricted to verifiers. Use `onlyRole` modifiers.
- **Double counting**: `generationId` uniqueness prevents minting credits twice for the same generation.
- **Reentrancy**: order matching and transfers use checks-effects-interactions and/or a reentrancy guard.
- **Integer precision**: credit computation uses scaled arithmetic to avoid truncation; document rounding direction (round down to protect the protocol).
- **Order validation**: reject zero-amount and zero-price orders; enforce sufficient certified balance for asks and sufficient funds/allowance for bids.
- **Price manipulation**: index price derived from executed trades; consider a volume-weighted window to resist single-trade manipulation.
- **Pause/emergency**: include a pausable mechanism for marketplace operations.
- **Verification integrity**: verifiers are trusted roles; evidence is stored off-chain with hashes referenced on-chain where possible.
- **Front-running**: order matching is deterministic by price-time priority; document any MEV considerations.

## Frontend Marketplace UI

The frontend provides:

- A dashboard showing tradable and pending credit balances.
- An issuance view showing kWh generated and credits earned (kWh / 2000).
- A marketplace view with the order book (bids/asks), index price, and trade history.
- Forms to place/cancel asks and bids.
- A verification queue for verifier accounts to certify or reject pending credits.

## Tests

Trading and issuance behavior is covered by tests including:

- Credit issuance from kWh with correct 2000 kWh/credit conversion.
- Rejection of duplicate `generationId`.
- Certification and rejection flows with role enforcement.
- Placing, matching, partially filling, and cancelling orders.
- Index price updates on trades.
- Access control and reentrancy protections.