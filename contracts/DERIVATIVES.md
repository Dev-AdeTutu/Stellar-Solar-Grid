# Energy Credit Derivatives

This document describes the energy credit derivatives market implemented in the
`EnergyDerivatives` smart contract, the backend endpoints that expose it, and the
frontend trading UI that consumes those endpoints.

## Overview

The derivatives market lets participants hedge energy price risk using two
instrument types:

- **Futures** — an agreement to buy or sell a fixed quantity of energy credits at
  a fixed price on a future expiry date.
- **Options** — the right (but not the obligation) to buy (**call**) or sell
  (**put**) energy credits at a fixed strike price on or before expiry.

All positions are collateralized with margin. Positions that fall below their
maintenance margin can be liquidated by any third party.

## Contract: `EnergyDerivatives`

### Instrument creation

```
createFuture(uint256 expiry, uint256 price, uint256 quantity)
createOption(bool isCall, uint256 strike, uint256 expiry, uint256 premium, uint256 quantity)
```

- `expiry` is a Unix timestamp in the future.
- `price` / `strike` are denominated in the platform's energy credit unit.
- `quantity` is the number of energy credits covered by the contract.
- `premium` (options only) is paid by the buyer to the writer at open.

Each instrument is assigned an incrementing `instrumentId` and stores its type,
strike/price, expiry, quantity, and open interest.

### Opening positions

```
openLong(uint256 instrumentId) payable
openShort(uint256 instrumentId) payable
```

- **Long** (futures buyer / option holder): posts initial margin; for options the
  buyer also pays the premium.
- **Short** (futures seller / option writer): posts initial margin; for options
  the writer receives the premium and must post margin sufficient to cover the
  strike exposure.

### Margin requirements

| Parameter | Value |
|-----------|-------|
| Initial margin | 20% of notional |
| Maintenance margin | 10% of notional |
| Liquidation penalty | 5% of notional (paid to liquidator) |

Notional is computed as `price × quantity` for futures and `strike × quantity`
for options. Margin is held in the contract and tracked per position.

### Mark-to-market and liquidation

```
updatePrice(uint256 instrumentId, uint256 newPrice)   // oracle / admin
liquidate(uint256 positionId)
```

- `updatePrice` refreshes the reference price used to compute position equity.
- A position is liquidatable when `equity < maintenanceMargin`.
- `liquidate` closes the position, seizes the remaining margin, pays the
  liquidation penalty to the caller, and returns any surplus to the position
  owner.

### Settlement at expiry

```
settle(uint256 positionId)
settleExpired(uint256 instrumentId)   // batch settlement helper
```

- Settlement is **automated**: once `block.timestamp >= expiry`, anyone may call
  `settle` (or `settleExpired`) to close positions at the settlement price.
- **Futures** settle for the difference between the contract price and the
  settlement price, multiplied by quantity.
- **Options** settle for their intrinsic value:
  - Call: `max(settlementPrice − strike, 0) × quantity`
  - Put: `max(strike − settlementPrice, 0) × quantity`
- Out-of-the-money options expire worthless; the writer keeps the premium.
- Margin is released to the position owner after settlement.

### Events

```
InstrumentCreated(uint256 indexed instrumentId, bool isOption, bool isCall, uint256 price, uint256 expiry, uint256 quantity)
PositionOpened(uint256 indexed positionId, uint256 indexed instrumentId, address indexed trader, bool isLong, uint256 margin)
PriceUpdated(uint256 indexed instrumentId, uint256 newPrice)
PositionLiquidated(uint256 indexed positionId, address indexed liquidator, uint256 penalty)
PositionSettled(uint256 indexed positionId, address indexed trader, int256 payout)
```

## Backend endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/api/derivatives/instruments` | List all instruments with type, price/strike, expiry, open interest |
| `POST` | `/api/derivatives/instruments` | Create a futures or options instrument |
| `GET`  | `/api/derivatives/instruments/:id` | Instrument detail and current mark price |
| `POST` | `/api/derivatives/positions` | Open a long or short position |
| `GET`  | `/api/derivatives/positions` | List the caller's positions with margin and equity |
| `POST` | `/api/derivatives/positions/:id/liquidate` | Liquidate an under-margined position |
| `POST` | `/api/derivatives/positions/:id/settle` | Settle an expired position |
| `GET`  | `/api/derivatives/margin/:id` | Current margin, maintenance threshold, and liquidation status |

All endpoints require authentication and return the on-chain transaction hash
for state-changing operations.

## Frontend trading UI

The derivatives trading page (`/derivatives`) provides:

- **Market list** — all instruments with type badge (Future / Call / Put),
  price or strike, expiry countdown, and open interest.
- **Trade panel** — open long/short, with a live margin requirement preview
  (initial and maintenance) and, for options, the premium.
- **Positions table** — the user's open positions showing entry price, current
  mark, equity, margin ratio, and a health indicator.
- **Actions** — `Settle` appears once a position is past expiry; `Liquidate`
  appears for any position below maintenance margin.
- **Create instrument form** — for authorized users to list new futures or
  options.

The UI polls `/api/derivatives/positions` and `/api/derivatives/instruments` to
keep margin and mark-to-market values current.

## Tests

Derivatives logic is covered by `test/EnergyDerivatives.test.js`, including:

- Futures open, mark-to-market, and settlement (profit and loss cases)
- Call and put option settlement (in-the-money and out-of-the-money)
- Margin requirement enforcement on open
- Liquidation of under-margined positions and penalty distribution
- Automated settlement at expiry and rejection of early settlement
- Access control on price updates and instrument creation
</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>