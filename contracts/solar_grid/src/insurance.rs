//! Meter Insurance Integration (Issue #1008).
//!
//! Tracks meter insurance policies, premium payments, and claims on-chain.
//! Emits `InsurancePurchased` and `ClaimFiled` events.

use crate::{
    ContractError, DataKey, SolarGridContract, SolarGridContractArgs, SolarGridContractClient,
    EVT_NS,
};
use soroban_sdk::{contractimpl, contracttype, token, Address, Env, String, Symbol, Vec};

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct InsurancePolicy {
    pub meter_id: String,
    pub owner: Address,
    pub provider: Address,
    pub premium: i128,
    pub coverage: i128,
    pub expiry: u64,
    pub active: bool,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum ClaimStatus {
    Pending,
    Approved,
    Rejected,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct InsuranceClaim {
    pub id: u64,
    pub meter_id: String,
    pub claimant: Address,
    pub provider: Address,
    pub amount: i128,
    pub reason: String,
    pub filed_at: u64,
    pub status: ClaimStatus,
}

#[contracttype]
#[derive(Clone)]
enum InsuranceKey {
    Policy(String),
    ClaimCount,
    Claim(u64),
    MeterClaims(String),
}

#[contractimpl]
impl SolarGridContract {
    /// Purchase or renew an insurance policy for `meter_id`.
    /// Transfers `premium` from the meter owner to `provider` using the configured contract token.
    /// Emits `InsurancePurchased`.
    pub fn purchase_insurance(
        env: Env,
        meter_id: String,
        provider: Address,
        premium: i128,
        coverage: i128,
        duration_secs: u64,
    ) -> Result<InsurancePolicy, ContractError> {
        Self::require_not_paused(&env)?;
        if premium <= 0 || coverage <= 0 || duration_secs == 0 {
            return Err(ContractError::InvalidAmount);
        }

        let meter = Self::get_meter_or_error(&env, &DataKey::Meter(meter_id.clone()))?;
        meter.owner.require_auth();

        let now = env.ledger().timestamp();
        let expiry = now
            .checked_add(duration_secs)
            .ok_or(ContractError::TimestampOverflow)?;

        let token_address = Self::get_token_address(&env)?;
        let token_client = token::Client::new(&env, &token_address);
        token_client.transfer(&meter.owner, &provider, &premium);

        let policy = InsurancePolicy {
            meter_id: meter_id.clone(),
            owner: meter.owner.clone(),
            provider: provider.clone(),
            premium,
            coverage,
            expiry,
            active: true,
        };

        env.storage()
            .persistent()
            .set(&InsuranceKey::Policy(meter_id.clone()), &policy);

        env.events().publish(
            (EVT_NS, Symbol::new(&env, "InsurancePurchased"), meter_id),
            (provider, premium, coverage, expiry),
        );

        Ok(policy)
    }

    /// File an insurance claim against an active, non-expired policy on `meter_id`.
    /// Emits `ClaimFiled`.
    pub fn file_insurance_claim(
        env: Env,
        meter_id: String,
        amount: i128,
        reason: String,
    ) -> Result<u64, ContractError> {
        Self::require_not_paused(&env)?;
        if amount <= 0 {
            return Err(ContractError::InvalidAmount);
        }

        let meter = Self::get_meter_or_error(&env, &DataKey::Meter(meter_id.clone()))?;
        meter.owner.require_auth();

        let policy: InsurancePolicy = env
            .storage()
            .persistent()
            .get(&InsuranceKey::Policy(meter_id.clone()))
            .ok_or(ContractError::InsurancePolicyNotFound)?;

        let now = env.ledger().timestamp();
        if !policy.active || now > policy.expiry {
            return Err(ContractError::InsurancePolicyExpired);
        }
        if amount > policy.coverage {
            return Err(ContractError::ClaimExceedsCoverage);
        }

        let next_id: u64 = env
            .storage()
            .instance()
            .get(&InsuranceKey::ClaimCount)
            .unwrap_or(0u64)
            .saturating_add(1);
        env.storage()
            .instance()
            .set(&InsuranceKey::ClaimCount, &next_id);

        let claim = InsuranceClaim {
            id: next_id,
            meter_id: meter_id.clone(),
            claimant: meter.owner.clone(),
            provider: policy.provider.clone(),
            amount,
            reason: reason.clone(),
            filed_at: now,
            status: ClaimStatus::Pending,
        };

        env.storage()
            .persistent()
            .set(&InsuranceKey::Claim(next_id), &claim);

        let mut meter_claims: Vec<u64> = env
            .storage()
            .persistent()
            .get(&InsuranceKey::MeterClaims(meter_id.clone()))
            .unwrap_or_else(|| Vec::new(&env));
        meter_claims.push_back(next_id);
        env.storage()
            .persistent()
            .set(&InsuranceKey::MeterClaims(meter_id.clone()), &meter_claims);

        env.events().publish(
            (EVT_NS, Symbol::new(&env, "ClaimFiled"), meter_id),
            (next_id, policy.provider, amount, reason),
        );

        Ok(next_id)
    }

    /// Return the current insurance policy for `meter_id`, if any, updating `active` if expired.
    pub fn get_insurance_policy(env: Env, meter_id: String) -> Option<InsurancePolicy> {
        let mut policy: InsurancePolicy = env
            .storage()
            .persistent()
            .get(&InsuranceKey::Policy(meter_id))?;
        if env.ledger().timestamp() > policy.expiry {
            policy.active = false;
        }
        Some(policy)
    }

    /// Return whether `meter_id` currently has active, unexpired insurance coverage.
    pub fn is_meter_insured(env: Env, meter_id: String) -> bool {
        match Self::get_insurance_policy(env, meter_id) {
            Some(p) => p.active,
            None => false,
        }
    }

    /// Return all insurance claims filed for `meter_id`.
    pub fn get_meter_claims(env: Env, meter_id: String) -> Vec<InsuranceClaim> {
        let ids: Vec<u64> = env
            .storage()
            .persistent()
            .get(&InsuranceKey::MeterClaims(meter_id))
            .unwrap_or_else(|| Vec::new(&env));
        let mut out = Vec::new(&env);
        for id in ids.iter() {
            if let Some(claim) = env
                .storage()
                .persistent()
                .get::<InsuranceKey, InsuranceClaim>(&InsuranceKey::Claim(id))
            {
                out.push_back(claim);
            }
        }
        out
    }
}
