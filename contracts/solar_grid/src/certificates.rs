//! Renewable energy export certificates (Issue #871).
//!
//! A certificate is a non-fungible, on-chain record attesting that a meter
//! exported `energy_wh` watt-hours (the same milli-kWh unit used for usage)
//! to the grid during `[period_start, period_end)`.
//!
//! Issuance: only a trusted issuer — the contract admin or the registered
//! IoT oracle — can mint, and it must authorize the call. The issuer commits
//! to the off-chain meter readings through `reading_hash` (SHA-256 of the
//! canonical reading payload), which lets anyone verify a certificate against
//! the data it was minted from.
//!
//! Double counting is prevented per meter: a new certificate's period must
//! start at or after the end of the previous one, so the same exported energy
//! can never be certified twice.
//!
//! Ownership: certificates start with the meter owner (the producer) and can
//! be transferred like an NFT. Retiring a certificate claims its renewable
//! attribute permanently; retired certificates can no longer be transferred.
//!
//! Certificate authority (Issue #1065): certificates carry a lifecycle state
//! (`Issued` -> `Verified` -> `Retired`, or `Revoked` from any live state),
//! can be attested by registered third-party verifiers, and record the
//! international standard they comply with (I-REC, Granular, etc.) together
//! with vintage and country metadata. Revocation is permanent and recorded in
//! a revocation registry keyed by certificate id.

use crate::{
    ContractError, DataKey, SolarGridContract, SolarGridContractArgs, SolarGridContractClient,
    ADMIN, EVT_NS, ORACLE,
};
use soroban_sdk::{contractimpl, contracttype, symbol_short, Address, BytesN, Env, String, Vec};

/// Maximum page size for `get_certificates_by_owner`.
pub const MAX_CERTIFICATE_PAGE: u32 = 100;

/// Lifecycle state of an energy certificate.
#[contracttype]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CertificateStatus {
    /// Minted by a trusted issuer, not yet attested by a third party.
    Issued,
    /// Attested by a registered third-party verifier.
    Verified,
    /// Permanently revoked (fraudulent or invalid); cannot be transferred.
    Revoked,
    /// Renewable attribute claimed by the holder; cannot be transferred.
    Retired,
}

/// International certificate standard the certificate claims compliance with.
#[contracttype]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CertificateStandard {
    /// International REC Standard.
    IRec,
    /// Granular Certificate (24/7 hourly matching).
    Granular,
    /// Guarantee of Origin (EU).
    GuaranteeOfOrigin,
    /// Renewable Energy Certificate (US).
    Rec,
    /// No standard claimed.
    None,
}

/// Third-party attestation recorded against a certificate.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct CertificateAttestation {
    pub verifier: Address,
    pub attested_at: u64,
    /// SHA-256 of the verifier's signed attestation payload.
    pub proof_hash: BytesN<32>,
}

/// Revocation record kept in the revocation registry.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct CertificateRevocation {
    pub id: u64,
    pub revoked_at: u64,
    /// Admin or oracle that revoked the certificate.
    pub revoked_by: Address,
    pub reason: String,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ExportCertificate {
    /// Sequential id, starting at 1.
    pub id: u64,
    pub meter_id: String,
    /// Meter owner at the time of issuance.
    pub producer: Address,
    /// Current holder.
    pub owner: Address,
    /// Exported energy in watt-hours (milli-kWh).
    pub energy_wh: u64,
    /// Inclusive start of the export period (Unix seconds).
    pub period_start: u64,
    /// Exclusive end of the export period (Unix seconds).
    pub period_end: u64,
    pub issued_at: u64,
    /// Admin or oracle that attested the export.
    pub issuer: Address,
    /// SHA-256 of the canonical off-chain meter reading payload.
    pub reading_hash: BytesN<32>,
    /// Set when the holder retires (claims) the certificate.
    pub retired_at: Option<u64>,
    /// Current lifecycle state.
    pub status: CertificateStatus,
    /// Standard the certificate claims compliance with.
    pub standard: CertificateStandard,
    /// Vintage (year of generation) for standard compliance.
    pub vintage: u32,
    /// ISO 3166-1 alpha-2 country code of generation.
    pub country: String,
    /// Cryptographic proof of authenticity: SHA-256 over the canonical
    /// certificate payload (id, meter, producer, energy, period, reading hash,
    /// standard, vintage, country).
    pub proof_hash: BytesN<32>,
    /// Third-party attestation, once verified.
    pub attestation: Option<CertificateAttestation>,
}

#[contracttype]
#[derive(Clone)]
enum CertKey {
    Count,
    Certificate(u64),
    Owned(Address),
    /// End of the most recent certified period for a meter.
    LastPeriodEnd(String),
    /// Registered third-party verifier.
    Verifier(Address),
    /// Revocation registry entry.
    Revocation(u64),
}

/// Compute the canonical authenticity proof for a certificate payload.
fn compute_proof(
    env: &Env,
    id: u64,
    meter_id: &String,
    producer: &Address,
    energy_wh: u64,
    period_start: u64,
    period_end: u64,
    reading_hash: &BytesN<32>,
    standard: CertificateStandard,
    vintage: u32,
    country: &String,
) -> BytesN<32> {
    let mut payload = soroban_sdk::Bytes::new(env);
    payload.extend_from_array(&id.to_be_bytes());
    payload.append(&meter_id.clone().into());
    payload.append(&producer.clone().into());
    payload.extend_from_array(&energy_wh.to_be_bytes());
    payload.extend_from_array(&period_start.to_be_bytes());
    payload.extend_from_array(&period_end.to_be_bytes());
    payload.extend_from_array(&reading_hash.to_array());
    payload.extend_from_array(&[standard as u8]);
    payload.extend_from_array(&vintage.to_be_bytes());
    payload.append(&country.clone().into());
    env.crypto().sha256(&payload).into()
}

fn load(env: &Env, id: u64) -> Result<ExportCertificate, ContractError> {
    env.storage()
        .persistent()
        .get(&CertKey::Certificate(id))
        .ok_or(ContractError::CertificateNotFound)
}

fn owned(env: &Env, owner: &Address) -> Vec<u64> {
    env.storage()
        .persistent()
        .get(&CertKey::Owned(owner.clone()))
        .unwrap_or_else(|| Vec::new(env))
}

fn set_owned(env: &Env, owner: &Address, ids: &Vec<u64>) {
    let key = CertKey::Owned(owner.clone());
    if ids.is_empty() {
        env.storage().persistent().remove(&key);
    } else {
        env.storage().persistent().set(&key, ids);
    }
}

#[contractimpl]
impl SolarGridContract {
    /// Mint an export certificate for `meter_id`. `issuer` must be the admin
    /// or the registered oracle and must authorize the call. Returns the new
    /// certificate id.
    ///
    /// Errors: `ContractPaused`, `Unauthorized` (issuer is neither admin nor
    /// oracle), `InvalidAmount` (zero energy), `MeterNotFound`,
    /// `InvalidCertificatePeriod` (empty or future period) and
    /// `CertificatePeriodOverlap` (period starts before the meter's last
    /// certified period ended).
    ///
    /// Emits `cert_mint` with topics `(solargrid, cert_mint, id)` and data
    /// `(meter_id, producer, energy_wh, period_start, period_end, reading_hash)`.
    pub fn mint_export_certificate(
        env: Env,
        issuer: Address,
        meter_id: String,
        energy_wh: u64,
        period_start: u64,
        period_end: u64,
        reading_hash: BytesN<32>,
    ) -> Result<u64, ContractError> {
        Self::issue_certificate(
            env,
            issuer,
            meter_id,
            energy_wh,
            period_start,
            period_end,
            reading_hash,
            CertificateStandard::None,
            0,
            String::from_str(&env, ""),
        )
    }

    /// Issue a verifiable generation certificate with standard-compliance
    /// metadata. Same authorization and double-counting rules as
    /// [`Self::mint_export_certificate`]; additionally records the standard,
    /// vintage and country and computes the authenticity `proof_hash`.
    ///
    /// Emits `cert_mint` (see above) and `cert_std` with topics
    /// `(solargrid, cert_std, id)` and data `(standard, vintage, country)`.
    #[allow(clippy::too_many_arguments)]
    pub fn issue_certificate(
        env: Env,
        issuer: Address,
        meter_id: String,
        energy_wh: u64,
        period_start: u64,
        period_end: u64,
        reading_hash: BytesN<32>,
        standard: CertificateStandard,
        vintage: u32,
        country: String,
    ) -> Result<u64, ContractError> {
        if Self::pause_is_active(&env) {
            return Err(ContractError::ContractPaused);
        }
        let admin: Address = env
            .storage()
            .instance()
            .get(&ADMIN)
            .ok_or(ContractError::NotInitialized)?;
        let oracle: Option<Address> = env.storage().instance().get(&ORACLE);
        if issuer != admin && oracle.as_ref() != Some(&issuer) {
            return Err(ContractError::Unauthorized);
        }
        issuer.require_auth();

        if energy_wh == 0 {
            return Err(ContractError::InvalidAmount);
        }
        let now = env.ledger().timestamp();
        if period_start >= period_end || period_end > now {
            return Err(ContractError::InvalidCertificatePeriod);
        }
        let meter = Self::get_meter_or_error(&env, &DataKey::Meter(meter_id.clone()))?;
        let last_key = CertKey::LastPeriodEnd(meter_id.clone());
        let last_end: u64 = env.storage().persistent().get(&last_key).unwrap_or(0);
        if period_start < last_end {
            return Err(ContractError::CertificatePeriodOverlap);
        }

        let id: u64 = env
            .storage()
            .instance()
            .get::<CertKey, u64>(&CertKey::Count)
            .unwrap_or(0)
            + 1;
        let proof_hash = compute_proof(
            &env,
            id,
            &meter_id,
            &meter.owner,
            energy_wh,
            period_start,
            period_end,
            &reading_hash,
            standard,
            vintage,
            &country,
        );
        let certificate = ExportCertificate {
            id,
            meter_id: meter_id.clone(),
            producer: meter.owner.clone(),
            owner: meter.owner.clone(),
            energy_wh,
            period_start,
            period_end,
            issued_at: now,
            issuer,
            reading_hash: reading_hash.clone(),
            retired_at: None,
            status: CertificateStatus::Issued,
            standard,
            vintage,
            country: country.clone(),
            proof_hash,
            attestation: None,
        };
        env.storage().instance().set(&CertKey::Count, &id);
        env.storage()
            .persistent()
            .set(&CertKey::Certificate(id), &certificate);
        env.storage().persistent().set(&last_key, &period_end);
        let mut ids = owned(&env, &meter.owner);
        ids.push_back(id);
        set_owned(&env, &meter.owner, &ids);

        env.events().publish(
            (EVT_NS, symbol_short!("cert_mint"), id),
            (
                meter_id,
                meter.owner,
                energy_wh,
                period_start,
                period_end,
                reading_hash,
            ),
        );
        env.events().publish(
            (EVT_NS, symbol_short!("cert_std"), id),
            (standard, vintage, country),
        );
        Ok(id)
    }

    /// Full certificate record.
    pub fn get_export_certificate(env: Env, id: u64) -> Result<ExportCertificate, ContractError> {
        load(&env, id)
    }

    /// Number of certificates ever minted (ids run from 1 to this value).
    pub fn get_certificate_count(env: Env) -> u64 {
        env.storage().instance().get(&CertKey::Count).unwrap_or(0)
    }

    /// Ids of the certificates currently held by `owner`, oldest first.
    /// `limit` is capped at [`MAX_CERTIFICATE_PAGE`].
    pub fn get_certificates_by_owner(
        env: Env,
        owner: Address,
        offset: u32,
        limit: u32,
    ) -> Vec<u64> {
        let ids = owned(&env, &owner);
        let end = offset
            .saturating_add(limit.min(MAX_CERTIFICATE_PAGE))
            .min(ids.len());
        if offset >= end {
            return Vec::new(&env);
        }
        ids.slice(offset..end)
    }

    /// End of the most recently certified export period for a meter (0 when
    /// none), i.e. the earliest valid `period_start` for the next mint.
    pub fn get_last_certified_period_end(env: Env, meter_id: String) -> u64 {
        env.storage()
            .persistent()
            .get(&CertKey::LastPeriodEnd(meter_id))
            .unwrap_or(0)
    }

    /// Transfer a certificate to `to`. The current holder must authorize.
    /// Retired or revoked certificates cannot be transferred.
    pub fn transfer_export_certificate(
        env: Env,
        id: u64,
        to: Address,
    ) -> Result<(), ContractError> {
        let mut certificate = load(&env, id)?;
        certificate.owner.require_auth();
        if certificate.status == CertificateStatus::Revoked {
            return Err(ContractError::CertificateRevoked);
        }
        if certificate.retired_at.is_some() || certificate.status == CertificateStatus::Retired {
            return Err(ContractError::CertificateRetired);
        }
        let from = certificate.owner.clone();
        if from == to {
            return Ok(());
        }

        let mut remaining = Vec::new(&env);
        for held in owned(&env, &from).iter() {
            if held != id {
                remaining.push_back(held);
            }
        }
        set_owned(&env, &from, &remaining);
        let mut received = owned(&env, &to);
        received.push_back(id);
        set_owned(&env, &to, &received);

        certificate.owner = to.clone();
        env.storage()
            .persistent()
            .set(&CertKey::Certificate(id), &certificate);
        env.events()
            .publish((EVT_NS, symbol_short!("cert_xfer"), id), (from, to));
        Ok(())
    }

    /// Retire (claim) a certificate. The holder must authorize; this is
    /// irreversible and the certificate stays with the retiring holder.
    pub fn retire_export_certificate(env: Env, id: u64) -> Result<(), ContractError> {
        let mut certificate = load(&env, id)?;
        certificate.owner.require_auth();
        if certificate.status == CertificateStatus::Revoked {
            return Err(ContractError::CertificateRevoked);
        }
        if certificate.retired_at.is_some() || certificate.status == CertificateStatus::Retired {
            return Err(ContractError::CertificateRetired);
        }
        let now = env.ledger().timestamp();
        certificate.retired_at = Some(now);
        certificate.status = CertificateStatus::Retired;
        env.storage()
            .persistent()
            .set(&CertKey::Certificate(id), &certificate);
        env.events().publish(
            (EVT_NS, symbol_short!("cert_ret"), id),
            (certificate.owner, certificate.energy_wh, now),
        );
        Ok(())
    }

    /// Register (`enabled = true`) or remove a third-party verifier. Only the
    /// admin may call this and must authorize.
    pub fn set_certificate_verifier(
        env: Env,
        verifier: Address,
        enabled: bool,
    ) -> Result<(), ContractError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&ADMIN)
            .ok_or(ContractError::NotInitialized)?;
        admin.require_auth();
        let key = CertKey::Verifier(verifier.clone());
        if enabled {
            env.storage().persistent().set(&key, &true);
        } else {
            env.storage().persistent().remove(&key);
        }
        env.events()
            .publish((EVT_NS, symbol_short!("cert_vrfy"), verifier), enabled);
        Ok(())
    }

    /// True when `verifier` is a registered third-party verifier.
    pub fn is_certificate_verifier(env: Env, verifier: Address) -> bool {
        env.storage()
            .persistent()
            .get(&CertKey::Verifier(verifier))
            .unwrap_or(false)
    }

    /// Attest a certificate as a registered third-party verifier. The
    /// verifier must authorize and supply `proof_hash`, the SHA-256 of its
    /// signed attestation payload. Moves an `Issued` certificate to
    /// `Verified`.
    ///
    /// Errors: `Unauthorized` (not a registered verifier),
    /// `CertificateNotFound`, `CertificateRevoked`, `CertificateRetired`,
    /// `CertificateAlreadyVerified`.
    ///
    /// Emits `cert_attest` with topics `(solargrid, cert_attest, id)` and data
    /// `(verifier, proof_hash)`.
    pub fn attest_certificate(
        env: Env,
        verifier: Address,
        id: u64,
        proof_hash: BytesN<32>,
    ) -> Result<(), ContractError> {
        verifier.require_auth();
        if !Self::is_certificate_verifier(env.clone(), verifier.clone()) {
            return Err(ContractError::Unauthorized);
        }
        let mut certificate = load(&env, id)?;
        match certificate.status {
            CertificateStatus::Revoked => return Err(ContractError::CertificateRevoked),
            CertificateStatus::Retired => return Err(ContractError::CertificateRetired),
            CertificateStatus::Verified => {
                return Err(ContractError::CertificateAlreadyVerified)
            }
            CertificateStatus::Issued => {}
        }
        let now = env.ledger().timestamp();
        certificate.attestation = Some(CertificateAttestation {
            verifier: verifier.clone(),
            attested_at: now,
            proof_hash: proof_hash.clone(),
        });
        certificate.status = CertificateStatus::Verified;
        env.storage()
            .persistent()
            .set(&CertKey::Certificate(id), &certificate);
        env.events().publish(
            (EVT_NS, symbol_short!("cert_attest"), id),
            (verifier, proof_hash),
        );
        Ok(())
    }

    /// Revoke a certificate (admin or oracle only, must authorize) and record
    /// it in the revocation registry. Revocation is permanent.
    ///
    /// Errors: `Unauthorized`, `CertificateNotFound`, `CertificateRevoked`.
    ///
    /// Emits `cert_revoke` with topics `(solargrid, cert_revoke, id)` and data
    /// `(revoked_by, reason)`.
    pub fn revoke_certificate(
        env: Env,
        revoker: Address,
        id: u64,
        reason: String,
    ) -> Result<(), ContractError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&ADMIN)
            .ok_or(ContractError::NotInitialized)?;
        let oracle: Option<Address> = env.storage().instance().get(&ORACLE);
        if revoker != admin && oracle.as_ref() != Some(&revoker) {
            return Err(ContractError::Unauthorized);
        }
        revoker.require_auth();

        let mut certificate = load(&env, id)?;
        if certificate.status == CertificateStatus::Revoked {
            return Err(ContractError::CertificateRevoked);
        }
        let now = env.ledger().timestamp();
        certificate.status = CertificateStatus::Revoked;
        env.storage()
            .persistent()
            .set(&CertKey::Certificate(id), &certificate);
        let revocation = CertificateRevocation {
            id,
            revoked_at: now,
            revoked_by: revoker.clone(),
            reason: reason.clone(),
        };
        env.storage()
            .persistent()
            .set(&CertKey::Revocation(id), &revocation);
        env.events().publish(
            (EVT_NS, symbol_short!("cert_revoke"), id),
            (revoker, reason),
        );
        Ok(())
    }

    /// Revocation registry entry for `id`, if the certificate was revoked.
    pub fn get_certificate_revocation(
        env: Env,
        id: u64,
    ) -> Option<CertificateRevocation> {
        env.storage().persistent().get(&CertKey::Revocation(id))
    }

    /// True when certificate `id` has been revoked.
    pub fn is_certificate_revoked(env: Env, id: u64) -> bool {
        env.storage()
            .persistent()
            .get::<CertKey, CertificateRevocation>(&CertKey::Revocation(id))
            .is_some()
    }

    /// Recompute the authenticity proof for a certificate and compare it with
    /// the stored `proof_hash`. Returns false for unknown or revoked
    /// certificates.
    pub fn verify_certificate_proof(env: Env, id: u64) -> bool {
        let certificate = match load(&env, id) {
            Ok(c) => c,
            Err(_) => return false,
        };
        if certificate.status == CertificateStatus::Revoked {
            return false;
        }
        let expected = compute_proof(
            &env,
            certificate.id,
            &certificate.meter_id,
            &certificate.producer,
            certificate.energy_wh,
            certificate.period_start,
            certificate.period_end,
            &certificate.reading_hash,
            certificate.standard,
            certificate.vintage,
            &certificate.country,
        );
        expected == certificate.proof_hash
    }

    /// True when certificate `id` exists and was minted from readings whose
    /// SHA-256 is `reading_hash`. Lets a verifier check a downloaded
    /// certificate against the chain without trusting the issuer's server.
    pub fn verify_export_certificate(env: Env, id: u64, reading_hash: BytesN<32>) -> bool {
        load(&env, id)
            .map(|c| c.reading_hash == reading_hash)
            .unwrap_or(false)
    }
}
