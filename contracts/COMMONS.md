# Energy Commons Management

This document describes the Energy Commons Management framework implemented in the smart contracts. It applies Elinor Ostrom's design principles for governing the commons to shared community energy resources.

## Overview

A community energy commons is a shared energy resource (e.g., a solar array, battery bank, or microgrid capacity) governed collectively by its members. Rather than private ownership or state control, the resource is managed through member-defined rules, monitoring, and graduated sanctions — following Ostrom's principles.

## Ostrom's Principles as Implemented

### 1. Clearly Defined Boundaries

The commons resource has explicit boundaries defined at creation:

- **Resource boundary**: The physical or virtual energy resource (capacity in kWh, generation source, storage) is registered with a unique identifier and a defined total capacity.
- **Member boundary**: The set of eligible members is explicitly enumerated. Only registered members may draw from or contribute to the commons.
- **Usage boundary**: Each member has a defined allocation (share) of the resource, expressed in absolute units or as a fraction of total capacity.

Boundaries are stored on-chain and can only be modified through the governance process.

### 2. Rules Matching Local Conditions

Usage rules are **member-defined** rather than imposed externally:

- Members propose rules (allocation limits, contribution requirements, priority ordering, time-of-use constraints).
- Rules are ratified through community voting.
- Rules can be amended as local conditions change (seasonal demand, new members, capacity changes).

The contract stores the active rule set and enforces it on every allocation and usage operation.

### 3. Collective-Choice Arrangements

Members affected by the rules participate in making them:

- **Proposals**: Any member may propose a rule change, allocation adjustment, or sanction.
- **Voting**: Proposals are decided by community vote with configurable quorum and approval thresholds.
- **Execution**: Ratified proposals are executed on-chain, updating the rule set or resource state.

### 4. Monitoring

Usage is monitored transparently:

- Every draw and contribution is recorded on-chain, attributed to a member.
- The contract tracks cumulative usage against each member's allocation.
- Over-use and under-contribution are detectable by any member, since all state is public.
- Monitors (any member, or designated monitors) can raise violations, which trigger the sanctions process.

### 5. Graduated Sanctions

Violations are met with **graduated sanctions** that escalate for repeat offenders:

1. **First offense** — warning recorded on-chain.
2. **Subsequent offenses** — increasing penalties, such as temporary suspension of draw rights, reduction of allocation, or required contribution to restore standing.
3. **Persistent violations** — escalation to membership review, potentially resulting in removal through governance vote.

The sanction level for a member is derived from their recorded violation history. Sanctions are applied automatically by the contract based on the offense count, and members may appeal through the conflict resolution mechanism.

### 6. Conflict Resolution

Disputes are resolved through accessible, low-cost mechanisms:

- **Dispute filing**: Any member may file a dispute against a sanction, allocation decision, or another member's conduct.
- **Review**: Disputes are reviewed by the community (or a designated arbitration set) via vote.
- **Outcome**: The community may uphold, reduce, or overturn a sanction, or adjust allocations. Outcomes are recorded on-chain.

### 7. Recognition of the Right to Organize

The community retains the right to define its own rules and governance parameters (quorum, thresholds, sanction schedule) without external override, within the boundaries set at commons creation.

### 8. Nested Enterprises

Commons may be composed of sub-groups (e.g., buildings within a district), each with their own allocations governed under the umbrella commons rules.

## Contract Interface Summary

| Function | Purpose |
| --- | --- |
| `createCommons(...)` | Define resource boundaries, capacity, and initial members |
| `addMember(...)` / `removeMember(...)` | Manage the member boundary (governance-gated) |
| `proposeRule(...)` | Propose a member-defined usage rule |
| `vote(...)` | Participate in collective choice |
| `allocate(...)` | Assign shares of the resource to members |
| `recordUsage(...)` | Record monitored draw/contribution |
| `reportViolation(...)` | Raise a violation for monitoring/sanctions |
| `applySanction(...)` | Apply graduated sanction based on violation history |
| `fileDispute(...)` / `resolveDispute(...)` | Conflict resolution workflow |

## Testing

Commons governance is covered by tests verifying:

- Boundary enforcement (non-members cannot draw; allocations cannot exceed capacity).
- Member-defined rule proposal, voting, and enforcement.
- Monitoring records accurate usage and detects over-use.
- Graduated sanctions escalate correctly across repeat offenses.
- Conflict resolution can uphold, reduce, or overturn sanctions.
- Governance thresholds (quorum, approval) are respected.

See the test suite for `EnergyCommons` for the full set of governance scenarios.