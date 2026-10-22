# Demand Response Automation

This document describes the automated demand response (DR) system implemented in the energy contracts. The system replaces slow, manual DR programs with smart-contract-driven events and IoT-based load control, enabling fast, verifiable curtailment and automatic incentive distribution.

## Overview

Demand response automation coordinates three actors:

- **Program operator** — defines DR events with curtailment targets and funds incentive pools.
- **Participants** — opt in, set load preferences, and allow automated curtailment of enrolled loads.
- **IoT controllers** — execute curtailment commands on participant devices and report metered reduction.

The smart contract is the source of truth for event state, participant enrollment, curtailment verification, and incentive payouts.

## DR Event Definition

A DR event is created by the operator and includes:

- `eventId` — unique identifier.
- `startTime` / `endTime` — event window.
- `curtailmentTarget` — total load reduction required across all participants (in kW or energy units).
- `baselineMethod` — how each participant's baseline load is computed (e.g., historical average over a lookback window).
- `incentivePool` — total funds available for distribution.
- `penaltyRate` (optional) — applied to under-performing participants where the program allows penalties.
- `status` — `Scheduled`, `Active`, `Completed`, or `Cancelled`.

Events are validated on creation: the window must be in the future, the target must be positive, and the incentive pool must be funded before the event can become `Active`.

## User Opt-In and Load Preferences

Participants enroll per program and configure load preferences:

- `enrolledLoads` — list of controllable loads (HVAC, EV charger, water heater, etc.) with their rated capacity.
- `maxCurtailment` — maximum reduction the participant permits per event.
- `minComfortLevel` — floor below which loads must not be curtailed (e.g., temperature bounds).
- `autoOptIn` — whether the participant is automatically included in eligible events.
- `priority` — ordering used when selecting which loads to curtail first.

Enrollment and preference updates are recorded on-chain so that curtailment decisions are auditable. Participants can opt out at any time; opting out removes them from future events but does not affect events already in progress.

## Automated Curtailment Flow

1. Operator creates and funds a DR event.
2. At `startTime`, the contract transitions the event to `Active`.
3. The automation service queries eligible participants (opted in, load available, within comfort bounds).
4. The contract allocates a curtailment assignment to each participant, bounded by `maxCurtailment` and respecting `priority` and `minComfortLevel`.
5. IoT controllers receive curtailment commands and reduce loads.
6. Devices report metered reduction back to the contract during and after the event.
7. At `endTime`, the event transitions to `Completed` and verified reductions are finalized.

Curtailment is bounded so that the sum of assignments never exceeds the event's `curtailmentTarget` beyond a configurable tolerance, and never exceeds any participant's `maxCurtailment`.

## Incentive Calculation and Distribution

Incentives are distributed pro-rata to verified delivered reduction:

```
participantShare = verifiedReduction / totalVerifiedReduction
participantIncentive = incentivePool * participantShare
```

Rules:

- Only verified reduction counts toward the share.
- If total verified reduction meets or exceeds the `curtailmentTarget`, the full pool is distributed.
- If the target is not met, distribution scales with delivered performance (configurable shortfall policy).
- Optional penalties are deducted from under-performers and may be redistributed to top performers.
- Payouts are executed automatically after verification; each payout emits an event for auditability.

## Performance Tracking and Verification

- **Baseline** — computed per participant using the configured `baselineMethod`.
- **Delivered reduction** — measured from IoT meter reports during the event window.
- **Verified reduction** — delivered reduction adjusted against baseline, with outlier and tamper checks.
- **Performance score** — per-participant and per-event metrics (delivered vs. assigned, reliability over time) are stored for reporting and future allocation weighting.

Verification results are recorded on-chain and drive incentive distribution.

## Contract Entry Points

| Function | Description |
| --- | --- |
| `createEvent(...)` | Operator defines a DR event with target, window, and incentive pool. |
| `fundEvent(eventId, amount)` | Deposits incentive funds for an event. |
| `enroll(programId, loads, preferences)` | Participant opts in and sets load preferences. |
| `updatePreferences(programId, preferences)` | Updates load preferences. |
| `optOut(programId)` | Removes participant from future events. |
| `activateEvent(eventId)` | Transitions a funded event to `Active`. |
| `assignCurtailment(eventId, participant, amount)` | Records curtailment assignment. |
| `reportReduction(eventId, participant, amount)` | IoT controller reports metered reduction. |
| `finalizeEvent(eventId)` | Verifies reductions and computes incentives. |
| `distributeIncentives(eventId)` | Executes incentive payouts. |
| `getParticipantPerformance(participant)` | Returns performance metrics. |

## Backend API Routes

| Method | Route | Description |
| --- | --- | --- |
| `POST` | `/api/dr/events` | Create a DR event. |
| `GET` | `/api/dr/events` | List DR events. |
| `GET` | `/api/dr/events/:id` | Get event details and status. |
| `POST` | `/api/dr/events/:id/fund` | Fund an event's incentive pool. |
| `POST` | `/api/dr/events/:id/activate` | Activate an event. |
| `POST` | `/api/dr/enroll` | Enroll a participant with load preferences. |
| `PUT` | `/api/dr/preferences` | Update participant load preferences. |
| `POST` | `/api/dr/opt-out` | Opt a participant out. |
| `POST` | `/api/dr/events/:id/report` | Submit IoT metered reduction. |
| `POST` | `/api/dr/events/:id/finalize` | Finalize and verify an event. |
| `GET` | `/api/dr/events/:id/incentives` | Get computed incentive distribution. |
| `GET` | `/api/dr/performance/:participant` | Get participant performance metrics. |

## Frontend Enrollment

The frontend provides a DR program enrollment flow:

1. **Program discovery** — lists available DR programs and upcoming events.
2. **Enrollment form** — participant selects controllable loads, sets `maxCurtailment`, `minComfortLevel`, `autoOptIn`, and load `priority`.
3. **Preference management** — participants can review and update preferences and opt out at any time.
4. **Event dashboard** — shows active events, assigned curtailment, live delivered reduction, and projected incentives.
5. **Payout history** — displays distributed incentives and performance scores.

## Tests

Automated tests cover:

- Event creation and validation (window, target, funding).
- Enrollment, preference updates, and opt-out behavior.
- Curtailment assignment bounded by `maxCurtailment` and `minComfortLevel`.
- Automated curtailment flow and status transitions.
- Reduction reporting and verification.
- Incentive calculation (pro-rata, shortfall, penalties) and distribution.
- Performance tracking and metrics retrieval.
- API route behavior for events, enrollment, reporting, and incentives.