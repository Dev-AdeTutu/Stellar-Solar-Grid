# Behavioral Economics Nudges

This document describes the behavioral economics nudge engine that powers personalized energy-saving recommendations in the meter backend. The engine applies well-established behavioral economics principles to encourage better energy habits, and provides an A/B testing framework to measure which strategies actually change behavior.

## Overview

The nudge engine generates personalized nudges for each user based on their usage data, peer comparisons, and account state. Each nudge is framed using one or more behavioral economics principles:

- **Social comparison** — show users how their usage compares to similar neighbors.
- **Loss aversion** — frame savings as avoiding a loss (e.g., losing credits) rather than gaining a reward.
- **Defaults** — pre-select options that promote saving.
- **Commitment devices** — let users pledge to reduce usage and hold them accountable.

All nudges are delivered through an A/B testing framework so that different strategies can be compared and their behavior-change impact measured.

## Nudge Engine

The nudge engine is the backend component that decides *which* nudges to generate for a user, *when* to deliver them, and *how* to frame them.

### Inputs

- Current and historical usage (kWh) for the user.
- Peer/neighborhood usage aggregates for comparable households.
- Account state (credits balance, active pledges, notification preferences).
- The user's A/B test assignment (see below).

### Outputs

A list of nudge objects, each containing:

- `type` — the behavioral principle used (e.g., `social_comparison`, `loss_aversion`, `default`, `commitment`).
- `message` — the personalized, rendered message text.
- `strategy` — the A/B test variant that produced this nudge.
- `metadata` — supporting data (percent difference vs. peers, credit amounts, pledge targets).

### Delivery

Nudges are generated on a schedule (e.g., weekly) and on key events (bill ready, credits about to expire, pledge check-in). Delivery respects user notification preferences and rate limits so users are not overwhelmed.

## Social Comparison Nudges

Social comparison nudges tell users how their usage compares to similar households ("neighbors").

Example:

> You used **20% more electricity** than similar homes nearby last week. Small changes — like adjusting your thermostat by 2°F — could bring you in line with your neighbors.

Implementation notes:

- Peer groups are built from comparable households (similar size, location, and heating type) to keep comparisons fair.
- Comparisons are only shown when the peer group is large enough to preserve anonymity.
- Users who are already efficient receive positive reinforcement instead of a negative comparison.

## Loss Aversion Framing

People feel losses more strongly than equivalent gains. Loss aversion nudges frame energy savings in terms of what the user stands to *lose* by not acting.

Example:

> You have **$12 in energy credits** that expire in 7 days. Reduce your usage this week to keep them.

Implementation notes:

- Loss-framed nudges are triggered when there is a concrete, time-bound loss at stake (expiring credits, a streak about to break, a reward tier about to drop).
- The loss must be real and verifiable — never fabricate urgency.
- Loss framing is paired with a clear, achievable action the user can take to avoid the loss.

## Default Options

Defaults promote saving by pre-selecting the energy-saving choice, while still allowing users to opt out.

Examples:

- New users are opted into a "weekly savings summary" and "peak-hour reminders" by default.
- Thermostat schedules default to an energy-saving setpoint.
- Auto-participation in demand-response events is on by default, with a one-tap opt-out.

Implementation notes:

- Defaults must be transparent and easy to change.
- Opt-out must be as easy as opt-in.
- Default-driven nudges are tracked separately so their impact can be measured.

## Commitment Devices

Commitment devices let users make a public or personal pledge to reduce usage, which increases follow-through.

Example:

> **Pledge:** I will reduce my usage by 10% this month.
> Progress: 6% so far — you're on track! 12 days remaining.

Implementation notes:

- Users set a target reduction and a time window.
- The engine sends progress check-ins and celebrates milestones.
- Pledges are surfaced in the user's dashboard and referenced in subsequent nudges.
- Users can adjust or cancel a pledge at any time.

## A/B Testing Framework

Different nudge strategies are tested against each other to determine what actually works.

### Assignment

- Users are deterministically assigned to a variant per experiment (e.g., via a stable hash of user ID and experiment key) so assignment is consistent across sessions.
- Each experiment defines its variants (e.g., `control`, `social_comparison`, `loss_aversion`).

### Experiment Definition

Each experiment specifies:

- `key` — unique experiment identifier.
- `variants` — the nudge strategies being compared.
- `allocation` — the share of users in each variant.
- `metrics` — the outcome metrics used to evaluate the experiment (see below).

### Running Experiments

- The nudge engine reads the user's variant assignment and selects the corresponding nudge strategy.
- Control groups receive the baseline (or no nudge) so impact can be isolated.
- Experiments can be paused or rolled back without affecting other functionality.

## Measuring Behavior Change Impact

To prove that nudges change behavior, the engine records exposure and outcome data.

### Metrics

- **Exposure** — which users received which nudge and when.
- **Engagement** — open/click/acknowledge rates for delivered nudges.
- **Behavior change** — change in usage (kWh) relative to a baseline period, pledge completion rate, credit retention rate, and opt-out rates for defaults.
- **Guardrail metrics** — notification fatigue (opt-outs, dismissals) to ensure nudges are not harmful.

### Analysis

- Outcomes are compared across variants for each experiment.
- Results are attributed to the variant the user was assigned to (intent-to-treat), not just those who engaged.
- Experiments run long enough to reach statistical significance before a winning strategy is adopted.

## Tests for Nudge Delivery

The nudge engine is covered by automated tests to ensure correct delivery and framing.

Test coverage includes:

- **Nudge generation** — the correct nudge type is produced for a given user state (e.g., a user using more than peers gets a social comparison nudge; a user with expiring credits gets a loss-aversion nudge).
- **Personalization** — messages contain the correct personalized values (percent difference, credit amounts, pledge progress).
- **A/B assignment** — users are assigned deterministically and consistently to variants, and allocation shares match the experiment definition.
- **Delivery** — nudges respect notification preferences and rate limits, and are not delivered to opted-out users.
- **Commitment devices** — pledges are created, tracked, and completed correctly, and progress check-ins fire as expected.
- **Defaults** — default options are applied to new users and can be opted out of.
- **Impact tracking** — exposures and outcomes are recorded for each delivered nudge so experiments can be evaluated.

## Summary

The nudge engine combines social comparison, loss aversion, defaults, and commitment devices into personalized nudges, delivered through an A/B testing framework that measures real behavior change. All strategies are validated with automated tests and evaluated against guardrail metrics to keep nudging helpful rather than annoying.