# Virtual Power Plant (VPP)

This document describes the Virtual Power Plant (VPP) feature for meter aggregation. A VPP groups distributed meters into a coordinated portfolio that can respond to grid operator dispatch signals, track performance and revenue, and distribute earnings to participants.

## Overview

A VPP aggregates many individual meters (batteries, flexible loads, generators, etc.) into a single controllable resource. The VPP backend:

- Groups meters into **portfolios**
- Receives **dispatch signals** from grid operators
- **Coordinates** meter responses across the fleet
- Tracks **performance and revenue**
- Distributes **earnings** to participants

## Portfolio Grouping

Meters are organized into portfolios. Each portfolio represents a set of meters that are dispatched together as a single VPP resource.

### Portfolio model

| Field | Type | Description |
|-------|------|-------------|
| `id` | UUID | Unique portfolio identifier |
| `name` | string | Human-readable portfolio name |
| `gridOperatorId` | string | Identifier of the grid operator this portfolio serves |
| `capacityKw` | number | Total aggregated capacity in kW |
| `status` | enum | `active`, `inactive`, `suspended` |
| `createdAt` | timestamp | Creation time |
| `updatedAt` | timestamp | Last update time |

### Portfolio membership

Meters are added to a portfolio via membership records:

| Field | Type | Description |
|-------|------|-------------|
| `portfolioId` | UUID | Portfolio the meter belongs to |
| `meterId` | UUID | Meter identifier |
| `role` | enum | `producer`, `consumer`, `storage`, `flexible` |
| `maxCapacityKw` | number | Maximum dispatchable capacity for this meter |
| `priority` | number | Dispatch priority (lower = dispatched first) |
| `joinedAt` | timestamp | When the meter joined the portfolio |

A meter may only belong to one active portfolio at a time.

## Grid Operator API Integration

The VPP integrates with grid operator APIs to receive dispatch signals and report status.

### Dispatch signal model

| Field | Type | Description |
|-------|------|-------------|
| `signalId` | string | Grid operator signal identifier |
| `portfolioId` | UUID | Target portfolio |
| `type` | enum | `increase`, `decrease`, `setpoint`, `curtail` |
| `targetKw` | number | Requested aggregate power (signed; negative = export) |
| `startTime` | timestamp | Signal start |
| `endTime` | timestamp | Signal end |
| `receivedAt` | timestamp | When the signal was received |
| `status` | enum | `received`, `accepted`, `rejected`, `dispatched`, `completed`, `failed` |

### Integration flow

1. Grid operator sends a dispatch signal to the VPP webhook/API endpoint.
2. The VPP validates the signal (portfolio exists, capacity available, time window valid).
3. The signal is accepted or rejected and acknowledged back to the grid operator.
4. Accepted signals are passed to the dispatch coordinator.

### Authentication

Grid operator requests are authenticated using a shared secret or signed request (HMAC). Configure credentials per grid operator in the VPP settings.

## Dispatch Coordination

The dispatch coordinator translates an aggregate dispatch signal into per-meter commands.

### Coordination algorithm

1. **Resolve portfolio** — load active members and their capacities.
2. **Compute allocation** — distribute `targetKw` across members proportionally to `maxCapacityKw`, respecting each meter's limits and the portfolio `priority` ordering.
3. **Issue commands** — send per-meter setpoints to each meter's control interface.
4. **Monitor** — poll meter state to confirm actual response.
5. **Reconcile** — if actual response deviates from target, re-allocate the residual to remaining members.
6. **Complete** — mark the signal `completed` when the window ends or the target is met.

### Constraints

- Per-meter commands never exceed `maxCapacityKw`.
- Meters with `status` not `active` are skipped.
- If the portfolio cannot meet the target, the signal is marked `failed` with a shortfall report.

## Performance Tracking

The VPP tracks performance per signal, per portfolio, and per meter.

### Metrics

| Metric | Description |
|--------|-------------|
| `deliveredKw` | Actual aggregate power delivered |
| `targetKw` | Requested aggregate power |
| `accuracy` | `deliveredKw / targetKw` |
| `responseTimeMs` | Time from signal receipt to dispatch |
| `availability` | Fraction of time the portfolio was available |
| `revenue` | Revenue earned for the signal |

Performance records are stored per signal and aggregated into portfolio-level and meter-level summaries.

## Revenue Distribution

Revenue earned from grid services is distributed to participants.

### Distribution model

1. Revenue is recorded per completed signal.
2. Each meter's contribution is computed from its delivered energy during the signal.
3. Revenue is split proportionally to contribution, minus a configurable platform fee.
4. Earnings are credited to each participant's account.

### Distribution record

| Field | Type | Description |
|-------|------|-------------|
| `signalId` | string | Signal the revenue came from |
| `meterId` | UUID | Participant meter |
| `contributionKwh` | number | Energy contributed |
| `grossAmount` | number | Revenue before fees |
| `feeAmount` | number | Platform fee |
| `netAmount` | number | Amount credited to participant |
| `distributedAt` | timestamp | When the distribution occurred |

## Frontend VPP Management Portal

The VPP portal provides:

- **Portfolio management** — create, edit, and deactivate portfolios; add/remove meters.
- **Live dispatch view** — current and recent dispatch signals with status.
- **Performance dashboard** — accuracy, availability, and revenue charts.
- **Revenue & payouts** — per-participant earnings and distribution history.
- **Grid operator settings** — configure credentials and endpoints.

## API Endpoints

### Portfolios

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/vpp/portfolios` | List portfolios |
| `POST` | `/api/vpp/portfolios` | Create a portfolio |
| `GET` | `/api/vpp/portfolios/:id` | Get a portfolio |
| `PATCH` | `/api/vpp/portfolios/:id` | Update a portfolio |
| `DELETE` | `/api/vpp/portfolios/:id` | Deactivate a portfolio |
| `POST` | `/api/vpp/portfolios/:id/meters` | Add a meter to a portfolio |
| `DELETE` | `/api/vpp/portfolios/:id/meters/:meterId` | Remove a meter |

### Dispatch signals

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/vpp/signals` | Receive a dispatch signal (grid operator) |
| `GET` | `/api/vpp/signals` | List dispatch signals |
| `GET` | `/api/vpp/signals/:id` | Get a dispatch signal |
| `POST` | `/api/vpp/signals/:id/accept` | Accept a signal |
| `POST` | `/api/vpp/signals/:id/reject` | Reject a signal |

### Performance & revenue

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/vpp/portfolios/:id/performance` | Portfolio performance metrics |
| `GET` | `/api/vpp/portfolios/:id/revenue` | Portfolio revenue summary |
| `GET` | `/api/vpp/portfolios/:id/distributions` | Revenue distributions |
| `POST` | `/api/vpp/portfolios/:id/distribute` | Trigger revenue distribution |

## Testing

VPP operations are covered by tests for:

- Portfolio creation and membership
- Dispatch signal validation and acceptance
- Dispatch coordination and allocation
- Performance metric calculation
- Revenue distribution math

See the test suite under `tests/vpp/` for details.