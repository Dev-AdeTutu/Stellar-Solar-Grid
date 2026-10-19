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

use crate::{
    ContractError, DataKey, SolarGridContract, SolarGridContractArgs, SolarGridContractClient,
    ADMIN, EVT_NS, ORACLE,
};
use soroban_sdk::{contractimpl, contracttype, symbol_short, Address, BytesN, Env, String, Vec};

/// Maximum page size for `get_certificates_by_owner`.
pub const MAX_CERTIFICATE_PAGE: u32 = 100;

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
}

#[contracttype]
#[derive(Clone)]
enum CertKey {
    Count,
    Certificate(u64),
    Owned(Address),
    /// End of the most recent certified period for a meter.
    LastPeriodEnd(String),
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
    /// Retired certificates cannot be transferred.
    pub fn transfer_export_certificate(
        env: Env,
        id: u64,
        to: Address,
    ) -> Result<(), ContractError> {
        let mut certificate = load(&env, id)?;
        certificate.owner.require_auth();
        if certificate.retired_at.is_some() {
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
        if certificate.retired_at.is_some() {
            return Err(ContractError::CertificateRetired);
        }
        let now = env.ledger().timestamp();
        certificate.retired_at = Some(now);
        env.storage()
            .persistent()
            .set(&CertKey::Certificate(id), &certificate);
        env.events().publish(
            (EVT_NS, symbol_short!("cert_ret"), id),
            (certificate.owner, certificate.energy_wh, now),
        );
        Ok(())
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
