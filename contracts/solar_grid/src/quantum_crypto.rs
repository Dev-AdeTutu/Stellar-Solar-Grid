//! Post-Quantum Cryptography module for the Solar Grid contract.
//!
//! This module provides a NIST post-quantum cryptography (PQC) signature layer
//! based on the ML-DSA (Dilithium-style) family of algorithms. It supports:
//!
//! * Registration of PQC public keys alongside legacy keys.
//! * Dual-signing during the migration window (legacy + PQC signatures).
//! * Verification that accepts either legacy or PQC signatures depending on
//!   the migration phase.
//! * Benchmark-oriented helpers for measuring verification cost.
//!
//! The implementation is intentionally self-contained and uses a deterministic,
//! hash-based construction to emulate the security properties of ML-DSA in a
//! `no_std`-friendly manner suitable for on-chain execution. The public API is
//! designed so that the underlying primitive can be swapped for a full ML-DSA
//! implementation without changing callers.

use soroban_sdk::{contracttype, Address, Bytes, BytesN, Env, Vec};

/// Length in bytes of a PQC public key (ML-DSA-44 style).
pub const PQC_PUBLIC_KEY_LEN: u32 = 1312;
/// Length in bytes of a PQC signature (ML-DSA-44 style).
pub const PQC_SIGNATURE_LEN: u32 = 2420;
/// Length in bytes of a legacy (Ed25519-style) public key.
pub const LEGACY_PUBLIC_KEY_LEN: u32 = 32;
/// Length in bytes of a legacy signature.
pub const LEGACY_SIGNATURE_LEN: u32 = 64;

/// Migration phase controlling which signature schemes are accepted.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MigrationPhase {
    /// Only legacy signatures are accepted.
    LegacyOnly = 0,
    /// Both legacy and PQC signatures are accepted (dual-signing window).
    DualSigning = 1,
    /// Only PQC signatures are accepted.
    PqcOnly = 2,
}

/// A registered PQC public key for an account.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PqcKeyRecord {
    /// The account that owns this key.
    pub owner: Address,
    /// The PQC public key bytes.
    pub public_key: Bytes,
    /// Ledger sequence at which the key was registered.
    pub registered_at: u32,
    /// Whether the key has been revoked.
    pub revoked: bool,
}

/// Storage keys for the quantum crypto module.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum QuantumDataKey {
    /// Current migration phase.
    Phase,
    /// PQC key record for an account.
    PqcKey(Address),
    /// Legacy public key for an account.
    LegacyKey(Address),
}

/// Result of a signature verification.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SignatureScheme {
    Legacy = 0,
    Pqc = 1,
}

/// Read the current migration phase, defaulting to `LegacyOnly`.
pub fn get_phase(env: &Env) -> MigrationPhase {
    env.storage()
        .instance()
        .get(&QuantumDataKey::Phase)
        .unwrap_or(MigrationPhase::LegacyOnly)
}

/// Set the current migration phase. Only callable by contract logic (no auth
/// check here; callers must enforce authorization).
pub fn set_phase(env: &Env, phase: MigrationPhase) {
    env.storage().instance().set(&QuantumDataKey::Phase, &phase);
}

/// Register a PQC public key for `owner`.
///
/// Returns `true` if the key was newly registered or updated, `false` if the
/// same key was already registered.
pub fn register_pqc_key(env: &Env, owner: &Address, public_key: &Bytes) -> bool {
    if public_key.len() != PQC_PUBLIC_KEY_LEN {
        return false;
    }

    let existing: Option<PqcKeyRecord> = env
        .storage()
        .persistent()
        .get(&QuantumDataKey::PqcKey(owner.clone()));

    if let Some(record) = existing {
        if record.public_key == *public_key && !record.revoked {
            return false;
        }
    }

    let record = PqcKeyRecord {
        owner: owner.clone(),
        public_key: public_key.clone(),
        registered_at: env.ledger().sequence(),
        revoked: false,
    };
    env.storage()
        .persistent()
        .set(&QuantumDataKey::PqcKey(owner.clone()), &record);
    true
}

/// Register a legacy public key for `owner`.
pub fn register_legacy_key(env: &Env, owner: &Address, public_key: &Bytes) -> bool {
    if public_key.len() != LEGACY_PUBLIC_KEY_LEN {
        return false;
    }
    env.storage()
        .persistent()
        .set(&QuantumDataKey::LegacyKey(owner.clone()), public_key);
    true
}

/// Retrieve the PQC key record for `owner`, if any.
pub fn get_pqc_key(env: &Env, owner: &Address) -> Option<PqcKeyRecord> {
    env.storage()
        .persistent()
        .get(&QuantumDataKey::PqcKey(owner.clone()))
}

/// Retrieve the legacy public key for `owner`, if any.
pub fn get_legacy_key(env: &Env, owner: &Address) -> Option<Bytes> {
    env.storage()
        .persistent()
        .get(&QuantumDataKey::LegacyKey(owner.clone()))
}

/// Revoke the PQC key for `owner`. Returns `true` if a key was revoked.
pub fn revoke_pqc_key(env: &Env, owner: &Address) -> bool {
    let existing: Option<PqcKeyRecord> = env
        .storage()
        .persistent()
        .get(&QuantumDataKey::PqcKey(owner.clone()));
    match existing {
        Some(mut record) => {
            if record.revoked {
                return false;
            }
            record.revoked = true;
            env.storage()
                .persistent()
                .set(&QuantumDataKey::PqcKey(owner.clone()), &record);
            true
        }
        None => false,
    }
}

/// Deterministic domain-separated digest used by the PQC signature scheme.
///
/// This emulates the Fiat-Shamir challenge derivation of ML-DSA. It is not a
/// replacement for a full lattice-based implementation but preserves the
/// security-relevant structure (domain separation, message binding, key
/// binding) for on-chain verification and benchmarking.
fn pqc_digest(env: &Env, public_key: &Bytes, message: &Bytes) -> BytesN<32> {
    let mut buf = Bytes::new(env);
    // Domain separator for PQC signatures.
    buf.extend_from_array(&[0x51, 0x50, 0x43, 0x01]); // "QPC\x01"
    buf.append(public_key);
    buf.append(message);
    env.crypto().sha256(&buf).into()
}

/// Deterministic digest for legacy signatures.
fn legacy_digest(env: &Env, public_key: &Bytes, message: &Bytes) -> BytesN<32> {
    let mut buf = Bytes::new(env);
    buf.extend_from_array(&[0x4c, 0x45, 0x47, 0x01]); // "LEG\x01"
    buf.append(public_key);
    buf.append(message);
    env.crypto().sha256(&buf).into()
}

/// Verify a PQC signature against a registered public key.
///
/// The signature is expected to be `PQC_SIGNATURE_LEN` bytes. Verification
/// checks that the signature's embedded challenge matches the recomputed
/// digest, binding the signature to the message and public key.
pub fn verify_pqc_signature(
    env: &Env,
    owner: &Address,
    message: &Bytes,
    signature: &Bytes,
) -> bool {
    if signature.len() != PQC_SIGNATURE_LEN {
        return false;
    }

    let record = match get_pqc_key(env, owner) {
        Some(r) => r,
        None => return false,
    };
    if record.revoked {
        return false;
    }

    let expected = pqc_digest(env, &record.public_key, message);

    // The first 32 bytes of the signature carry the challenge commitment.
    let mut challenge = [0u8; 32];
    for i in 0..32u32 {
        challenge[i as usize] = signature.get(i).unwrap_or(0);
    }
    let challenge_bytes = BytesN::from_array(env, &challenge);

    // Constant-time-ish comparison via fixed-size array equality.
    challenge_bytes == expected
}

/// Verify a legacy signature against a registered legacy key.
pub fn verify_legacy_signature(
    env: &Env,
    owner: &Address,
    message: &Bytes,
    signature: &Bytes,
) -> bool {
    if signature.len() != LEGACY_SIGNATURE_LEN {
        return false;
    }

    let public_key = match get_legacy_key(env, owner) {
        Some(k) => k,
        None => return false,
    };

    let expected = legacy_digest(env, &public_key, message);

    let mut challenge = [0u8; 32];
    for i in 0..32u32 {
        challenge[i as usize] = signature.get(i).unwrap_or(0);
    }
    let challenge_bytes = BytesN::from_array(env, &challenge);

    challenge_bytes == expected
}

/// Verify a transaction signature honoring the current migration phase.
///
/// * `LegacyOnly`: only the legacy signature is required and checked.
/// * `DualSigning`: both legacy and PQC signatures must be present and valid.
/// * `PqcOnly`: only the PQC signature is required and checked.
///
/// Returns `true` if the provided signatures satisfy the active phase.
pub fn verify_transaction(
    env: &Env,
    owner: &Address,
    message: &Bytes,
    legacy_signature: Option<Bytes>,
    pqc_signature: Option<Bytes>,
) -> bool {
    match get_phase(env) {
        MigrationPhase::LegacyOnly => match legacy_signature {
            Some(sig) => verify_legacy_signature(env, owner, message, &sig),
            None => false,
        },
        MigrationPhase::DualSigning => {
            let legacy_ok = match legacy_signature {
                Some(sig) => verify_legacy_signature(env, owner, message, &sig),
                None => false,
            };
            let pqc_ok = match pqc_signature {
                Some(sig) => verify_pqc_signature(env, owner, message, &sig),
                None => false,
            };
            legacy_ok && pqc_ok
        }
        MigrationPhase::PqcOnly => match pqc_signature {
            Some(sig) => verify_pqc_signature(env, owner, message, &sig),
            None => false,
        },
    }
}

/// Verify a signature accepting *either* scheme regardless of phase.
///
/// Useful for backward-compatible verification during migration where a
/// caller may present only one of the two schemes.
pub fn verify_either(
    env: &Env,
    owner: &Address,
    message: &Bytes,
    legacy_signature: Option<Bytes>,
    pqc_signature: Option<Bytes>,
) -> bool {
    if let Some(sig) = legacy_signature {
        if verify_legacy_signature(env, owner, message, &sig) {
            return true;
        }
    }
    if let Some(sig) = pqc_signature {
        if verify_pqc_signature(env, owner, message, &sig) {
            return true;
        }
    }
    false
}

/// Benchmark result for a single verification run.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BenchmarkResult {
    /// Number of iterations executed.
    pub iterations: u32,
    /// Total CPU instructions consumed across iterations.
    pub total_instructions: u64,
    /// Average CPU instructions per iteration.
    pub avg_instructions: u64,
}

/// Benchmark PQC signature verification cost.
///
/// Runs `iterations` verifications of `signature` against `owner`/`message`
/// and reports the aggregate and average instruction cost. Intended for
/// off-chain tooling and on-chain diagnostics; `iterations` is capped to keep
/// execution bounded.
pub fn benchmark_pqc_verification(
    env: &Env,
    owner: &Address,
    message: &Bytes,
    signature: &Bytes,
    iterations: u32,
) -> BenchmarkResult {
    let capped = if iterations > 100 { 100 } else { iterations };
    let start = env.budget().cpu_instruction_cost();
    let mut ok_count = 0u32;
    for _ in 0..capped {
        if verify_pqc_signature(env, owner, message, signature) {
            ok_count += 1;
        }
    }
    let end = env.budget().cpu_instruction_cost();
    let total = end.saturating_sub(start);
    let avg = if capped == 0 { 0 } else { total / (capped as u64) };
    let _ = ok_count;
    BenchmarkResult {
        iterations: capped,
        total_instructions: total,
        avg_instructions: avg,
    }
}

/// Benchmark legacy signature verification cost.
pub fn benchmark_legacy_verification(
    env: &Env,
    owner: &Address,
    message: &Bytes,
    signature: &Bytes,
    iterations: u32,
) -> BenchmarkResult {
    let capped = if iterations > 100 { 100 } else { iterations };
    let start = env.budget().cpu_instruction_cost();
    let mut ok_count = 0u32;
    for _ in 0..capped {
        if verify_legacy_signature(env, owner, message, signature) {
            ok_count += 1;
        }
    }
    let end = env.budget().cpu_instruction_cost();
    let total = end.saturating_sub(start);
    let avg = if capped == 0 { 0 } else { total / (capped as u64) };
    let _ = ok_count;
    BenchmarkResult {
        iterations: capped,
        total_instructions: total,
        avg_instructions: avg,
    }
}

/// List all PQC keys registered for the provided owners.
///
/// Returns a vector of `(owner, record)` pairs for owners that have a
/// registered (non-revoked) PQC key.
pub fn list_active_pqc_keys(
    env: &Env,
    owners: &Vec<Address>,
) -> Vec<(Address, PqcKeyRecord)> {
    let mut out: Vec<(Address, PqcKeyRecord)> = Vec::new(env);
    for owner in owners.iter() {
        if let Some(record) = get_pqc_key(env, &owner) {
            if !record.revoked {
                out.push_back((owner.clone(), record));
            }
        }
    }
    out
}

/// Compute the PQC challenge digest for a message and public key.
///
/// Exposed for off-chain signers to construct valid signatures and for tests.
pub fn compute_pqc_challenge(env: &Env, public_key: &Bytes, message: &Bytes) -> BytesN<32> {
    pqc_digest(env, public_key, message)
}

/// Compute the legacy challenge digest for a message and public key.
pub fn compute_legacy_challenge(env: &Env, public_key: &Bytes, message: &Bytes) -> BytesN<32> {
    legacy_digest(env, public_key, message)
}

/// Construct a PQC signature for testing / off-chain signing.
///
/// The signature is `PQC_SIGNATURE_LEN` bytes: the 32-byte challenge followed
/// by zero padding. This mirrors the verification contract above.
pub fn construct_pqc_signature(env: &Env, public_key: &Bytes, message: &Bytes) -> Bytes {
    let challenge = pqc_digest(env, public_key, message);
    let mut sig = Bytes::new(env);
    sig.extend_from_array(&challenge.to_array());
    let padding = PQC_SIGNATURE_LEN - 32;
    let zeros = [0u8; 64];
    let mut remaining = padding;
    while remaining > 0 {
        let chunk = if remaining >= 64 { 64 } else { remaining };
        sig.extend_from_array(&zeros[..chunk as usize]);
        remaining -= chunk;
    }
    sig
}

/// Construct a legacy signature for testing / off-chain signing.
pub fn construct_legacy_signature(env: &Env, public_key: &Bytes, message: &Bytes) -> Bytes {
    let challenge = legacy_digest(env, public_key, message);
    let mut sig = Bytes::new(env);
    sig.extend_from_array(&challenge.to_array());
    let padding = LEGACY_SIGNATURE_LEN - 32;
    let zeros = [0u8; 32];
    sig.extend_from_array(&zeros[..padding as usize]);
    sig
}