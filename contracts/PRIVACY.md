# Privacy / zero-knowledge design review (#1040)

**Status: design only; ZK privacy is NOT implemented.** Existing contract transactions, usage, payment amounts, addresses and events remain public. No hash, commitment placeholder, fake proof endpoint or always-true verifier has been added. This document is not proof-generation/verification completion and must not be used to advertise private payments.

## Repository findings and blockers

`solar_grid/Cargo.toml` pins `soroban-sdk = 27.0.2` (alloc; testutils in development). The contract uses public token transfers, public `Meter.units_used` / `day_spent`, administrative usage updates, payment events and public meter queries. The repository has no audited ZK verifier dependency, circuit source, prover build pipeline, test vectors, verification-key management, trusted-setup procedure, shielded-note model or private asset pool.

Soroban support alone is not a complete audited ZK system. Selecting a compatible curve/verifier, proving correct budget behavior on the actual deployment protocol, building mobile proof generation, and migrating the payment/usage ledger cannot securely be accomplished by inventing a commitment hash. A hash hides neither predictable low-entropy usage (without a secret blinding factor) nor public token payment amounts. No compatibility/benchmark claim about an external ZK library is made without an implementation and independent verification.

The core **protocol** blocker is larger than a verifier: even a sound sufficient-balance proof will not hide amounts if the contract still emits usage/spending and makes ordinary public amount-bearing token transfers. Hiding only one API field leaves ledger data and linkability intact. Chain history cannot be retroactively made private.

## Threat model to settle before code

Potential adversaries include public ledger observers, malicious users trying to double spend or underpay, compromised meter firmware, malicious provider/oracle, dishonest or curious prover services, mobile storage compromise and colluding network observers. ZK does not prove that a physical sensor truthfully measured electricity. Private usage requires an authenticated measurement/oracle trust policy, separate from arithmetic correctness.

Decide the privacy boundary:

- Hide usage from public observers while the provider retains billing visibility?
- Hide meter ownership/identity linkability and payment timing too?
- Hide individual payment amounts with shielded tokens, or accept amounts as public and protect only finer usage granularity?
- Permit selective disclosures to owners/providers/auditors under an explicit consent/legal policy?

State what remains public (roots/nullifiers/proof versions, fee/epoch metadata, deposits/withdrawals, timing) and analyze intersection/timing/amount inference. Existing access/activation, provider revenue splits, daily limits, refunds, subscriptions and reconciliation must be preserved or deliberately redesigned; none can be dropped silently for privacy.

## Candidate architecture (not an implemented interface)

A versioned shielded-note ledger can prove private balance transitions against an authenticated root. Each circuit would constrain, at a minimum:

1. Input-note membership and authorization from secret owner material.
2. Bounded non-negative private value representations and no field wraparound.
3. Value conservation: authenticated debit + bounded output/change values + any fees exactly equals input values.
4. An authenticated tariff/usage obligation for the correct meter, billing interval, meter sequence and policy version, with an explicitly defined sensor/provider trust boundary.
5. Domain separation binding network, contract address, circuit/verifying-key version and statement type.
6. Nullifier derivation/uniqueness for each spend and billing obligation; reject replay/cross-contract/cross-network proofs.
7. Correct daily budget/subscription constraints without publishing private `day_spent` or `units_used`.

On-chain verifier inputs should be a strictly specified typed statement (protocol/circuit version, root, nullifiers, output commitments, authorized policy/epoch identifiers), with canonical encoding, exact lengths, finite bounded collections, checked point decoding and subgroup validation. Root acceptance and nullifier insertion must be atomic with state transition. Public input integrity is as important as proof validity. Unsupported versions, malformed input, absent/rotated keys and all verifier errors must **fail closed**.

This is a protocol sketch, not a concrete ABI. Adding a speculative proof interface before choosing an audited system would lock callers into an unreviewed statement and give false assurance; **no such interface or synthetic test was added**.

## Selection and implementation gates

Before changing contract authorization or payment state:

- Select an audited proof system/circuit framework and reviewed Soroban-compatible verifier implementation; enumerate exact SDK/network/curve support and licensing.
- Document proof soundness assumptions, setup/ceremony if any, key custody/provenance, circuit/key hash pinning and upgrade authority. A setup-free system still needs verifier/circuit review.
- Build reproducible deterministic artifacts and independent prover/verifier interoperability vectors. Audit circuit constraints (underconstraint, arithmetic range, membership, ownership, conservation, nullifiers, domain separation).
- Measure verifier instruction/memory/ledger footprint and total fees on target Soroban protocol, worst-case invalid input cost, mobile proof latency/memory, APK/browser bundle size and battery/network impact. No performance figures are fabricated here.
- Specify disclosure/encryption/key recovery; do not send witnesses to an unaudited remote prover or log them. Consent, escrow/provider access and recovery imply real trust tradeoffs.
- Design an explicit migration: existing public meters remain public; create an opt-in versioned private pool/ledger with carefully reviewed activation/billing/revenue/refund flows. Upgrade rollout, emergency pause and rollback cannot allow double spends.
- Obtain independent cryptographic and smart-contract audits; deploy a limited testnet pilot before any production use.

## Required adversarial tests once a real system exists

Positive independent proof vectors and negative tests for mutated public input/witness, insufficient balance, zero/negative/out-of-range value, field modulus wraparound, malformed/wrong-subgroup points, truncated/oversized proof, wrong verifier key, missing key, unsupported circuit version, reused nullifier, stale/unknown root, cross-network/contract replay, unauthorized tariff/oracle, duplicate meter interval, concurrency, pause/freeze, refund/revenue conservation and budget exhaustion. Ensure every failure leaves no partial payment/nullifier state. Add mobile benchmarks with actual devices and verifier cost limits, not mock proof objects.

## Interim privacy hygiene (not ZK)

Minimize off-chain telemetry retention, secure MQTT/device credentials and access controls, avoid unnecessary detailed public usage granularity when a separately reviewed billing design permits it, keep sensitive witnesses/logs out of telemetry and backups, and accurately disclose existing public visibility to users. These mitigations require their own deployment/change review and do not erase existing public ledger history.

**Issue #1040 remains blocked** pending a real audited proof/circuit/private-ledger implementation, integration and benchmarks. Only this design review is provided in this change set.
