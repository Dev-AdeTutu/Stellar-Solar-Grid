# Quantum-Resistant Cryptography

## Overview

This document describes the migration of the smart contract cryptography layer to
post-quantum cryptographic (PQC) algorithms. The goal is to protect transactions,
signatures, and key material against attacks from future large-scale quantum
computers while maintaining full backward compatibility during the migration
window.

The migration follows a **dual-signing** strategy: during the transition period,
transactions may carry both a classical (ECDSA) signature and a post-quantum
signature. Verification accepts either a valid PQC signature or a valid classical
signature (subject to policy), and new transactions are encouraged to include the
PQC signature. Once the migration window closes, PQC signatures become mandatory.

## NIST Post-Quantum Algorithm Choice

We adopt algorithms standardized by NIST in the post-quantum cryptography
standardization process:

| Purpose            | Algorithm | NIST Standard | Rationale |
|--------------------|-----------|---------------|-----------|
| Digital signatures | **ML-DSA** (Dilithium) | FIPS 204 | Lattice-based signature scheme; strong security, reasonable key/signature sizes, well-studied. Selected as the primary quantum-safe signature algorithm. |
| Digital signatures (alternative) | **SLH-DSA** (SPHINCS+) | FIPS 205 | Hash-based signature scheme; conservative security assumptions (relies only on hash functions). Used as a fallback for high-value or long-lived keys where lattice assumptions are a concern. |
| Key encapsulation (future) | **ML-KEM** (Kyber) | FIPS 203 | Reserved for future key-exchange / encrypted payload use cases. |

### Parameter Sets

- **ML-DSA-65** (NIST security category 3) is the default for transaction
  signatures. It offers a balanced trade-off between security and size.
- **ML-DSA-87** (category 5) is available for high-value accounts.
- **SLH-DSA-SHA2-128s** is available as a conservative fallback.

The algorithm and parameter set are encoded in the signature envelope so that
verifiers can select the correct implementation.

## Quantum-Safe Signatures

### Signature Envelope

All quantum-safe signatures are wrapped in a versioned envelope:

```
struct PqcSignature {
    uint8  version;      // envelope version (currently 1)
    uint8  algorithm;    // 1 = ML-DSA-65, 2 = ML-DSA-87, 3 = SLH-DSA-SHA2-128s
    bytes  publicKey;    // PQC public key
    bytes  signature;    // PQC signature over the canonical message digest
}
```

The signed message is the canonical serialization of the transaction
(chain id, nonce, sender, recipient, value, data, gas parameters), hashed with
SHA-256 before signing. Domain separation prefixes prevent cross-protocol
signature reuse.

### Verification Flow

1. Parse the signature envelope and validate `version` and `algorithm`.
2. Recompute the canonical message digest.
3. Verify the PQC signature against the embedded public key.
4. If a classical signature is also present (dual-signing), verify it as well
   according to the active migration policy.

### Key Registration

PQC public keys are registered on-chain via `registerPqcKey(bytes publicKey,
uint8 algorithm)`. The registration binds the PQC key to the account's classical
key. Key rotation is supported; the previous key remains valid until the
migration window for that account closes.

## Migration Strategy: Dual-Signing

The migration proceeds in three phases, controlled by an on-chain
`migrationPhase` parameter:

### Phase 0 — Classical Only (legacy)

- Only classical ECDSA signatures are required.
- PQC signatures are accepted but optional.
- Used before PQC support is activated.

### Phase 1 — Dual-Signing (transition)

- Transactions **may** include a PQC signature in addition to the classical
  signature.
- If a PQC key is registered for the sender, the PQC signature is **required**
  and verified in addition to the classical signature.
- If no PQC key is registered, classical-only transactions remain valid.
- Accounts are encouraged to register PQC keys and begin dual-signing.

### Phase 2 — PQC Required

- A valid PQC signature is mandatory for all transactions.
- Classical signatures are still verified when present (defense in depth) but
  are no longer sufficient on their own.
- Entered only after the migration deadline or by governance decision.

### Phase Transitions

Phase transitions are governed by an authorized migration controller and emit
`MigrationPhaseChanged(uint8 previousPhase, uint8 newPhase)` events. Transitions
are monotonic (0 → 1 → 2) and cannot be reversed.

## Backward Compatibility

- **Legacy transactions** signed only with ECDSA remain valid throughout Phase 0
  and Phase 1 (for accounts without a registered PQC key).
- **Signature envelope versioning** allows future algorithm additions without
  breaking existing verifiers; unknown versions are rejected explicitly.
- **Storage layout** is append-only: new PQC key fields are added without
  reordering existing storage slots, preserving upgrade compatibility.
- **ABI stability**: existing function selectors are unchanged; new functions
  are additive.
- **Grace period**: accounts that have not registered a PQC key by the Phase 2
  deadline are given a configurable grace period during which classical
  signatures are still accepted, after which they must migrate.

## Performance Benchmarking

Benchmarks are run as part of the test suite (`test/quantum/benchmarks`). The
following figures are indicative for a reference environment (single core,
optimized build). Actual numbers depend on the host and library implementation.

| Operation                     | Algorithm        | Approx. time | Approx. size |
|-------------------------------|------------------|--------------|--------------|
| Key generation                | ML-DSA-65        | ~0.1 ms      | 1,952 B pk   |
| Sign                          | ML-DSA-65        | ~0.3 ms      | 3,293 B sig  |
| Verify                        | ML-DSA-65        | ~0.1 ms      | —            |
| Key generation                | ML-DSA-87        | ~0.2 ms      | 2,592 B pk   |
| Sign                          | ML-DSA-87        | ~0.5 ms      | 4,595 B sig  |
| Verify                        | ML-DSA-87        | ~0.2 ms      | —            |
| Key generation                | SLH-DSA-SHA2-128s| ~5 ms        | 32 B pk      |
| Sign                          | SLH-DSA-SHA2-128s| ~50 ms       | 7,856 B sig  |
| Verify                        | SLH-DSA-SHA2-128s| ~1 ms        | —            |
| Verify (classical ECDSA)      | secp256k1        | ~0.05 ms     | 65 B sig     |

### Gas / Cost Considerations

- PQC verification is more expensive than ECDSA verification. Gas costs are
  calibrated per algorithm to reflect verification cost.
- Signature size increases calldata cost; batching and compression are used
  where possible.
- Dual-signing during Phase 1 roughly doubles signature verification cost;
  this is accounted for in the gas schedule.

## Testing for Quantum Resistance

The test suite covers:

- **Correctness**: sign/verify round-trips for each supported algorithm and
  parameter set.
- **Negative tests**: tampered messages, tampered signatures, wrong keys, and
  malformed envelopes are rejected.
- **Migration tests**: phase transitions, dual-signing acceptance/rejection,
  grace-period behavior, and key rotation.
- **Backward compatibility**: legacy classical-only transactions remain valid
  in Phases 0 and 1.
- **Fuzz tests**: signature envelope parsing and canonicalization.
- **Benchmarks**: performance regression checks against the baseline table above.

## Security Considerations

- PQC keys must be generated with a cryptographically secure RNG.
- Private keys never leave the client; only public keys are registered on-chain.
- Domain separation and canonical serialization prevent signature malleability
  and replay across chains.
- The dual-signing period ensures that a break of either the classical or the
  PQC scheme alone does not compromise funds.
- SLH-DSA is recommended for accounts requiring long-term security guarantees
  independent of lattice assumptions.

## References

- NIST FIPS 203 — ML-KEM (Kyber)
- NIST FIPS 204 — ML-DSA (Dilithium)
- NIST FIPS 205 — SLH-DSA (SPHINCS+)
- NIST IR 8105 — Report on Post-Quantum Cryptography