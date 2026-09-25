//! Meter warranty tracking (Issue #838).
//!
//! Warranty data lives in the meter's metadata map under standard keys.
//! `warranty_expires_at` must be a Unix timestamp (seconds) in decimal digits.

use crate::{ContractError, SolarGridContract, SolarGridContractArgs, SolarGridContractClient};
use soroban_sdk::{contractimpl, symbol_short, Env, Map, String, Symbol, Vec};

pub const WARRANTY_EXPIRES_AT: &str = "warranty_expires_at";
pub const WARRANTY_PROVIDER: &str = "warranty_provider";
pub const WARRANTY_TERMS: &str = "warranty_terms";

const METER_LIST: Symbol = symbol_short!("MLIST");

/// Parse a decimal Unix timestamp. Returns `None` for empty, non-digit or overflowing input.
pub fn parse_timestamp(value: &String) -> Option<u64> {
    let len = value.len() as usize;
    if len == 0 || len > 20 {
        return None;
    }
    let mut buf = [0u8; 20];
    value.copy_into_slice(&mut buf[..len]);
    let mut out: u64 = 0;
    for b in &buf[..len] {
        if !b.is_ascii_digit() {
            return None;
        }
        out = out.checked_mul(10)?.checked_add((b - b'0') as u64)?;
    }
    Some(out)
}

/// Validate the warranty keys in a metadata map (called from `validate_metadata`).
pub fn validate_warranty(env: &Env, metadata: &Map<String, String>) -> Result<(), ContractError> {
    if let Some(v) = metadata.get(String::from_str(env, WARRANTY_EXPIRES_AT)) {
        if parse_timestamp(&v).is_none() {
            return Err(ContractError::InvalidMetadata);
        }
    }
    Ok(())
}

#[contractimpl]
impl SolarGridContract {
    /// Warranty expiry timestamp for a meter, if set.
    pub fn get_warranty_expiry(env: Env, meter_id: String) -> Result<Option<u64>, ContractError> {
        let md = Self::get_meter_metadata(env.clone(), meter_id)?;
        Ok(md
            .get(String::from_str(&env, WARRANTY_EXPIRES_AT))
            .and_then(|v| parse_timestamp(&v)))
    }

    /// Meter IDs whose warranty expires within `within_secs` from now
    /// (already-expired warranties are included).
    pub fn get_meters_with_expiring_warranty(env: Env, within_secs: u64) -> Vec<String> {
        let deadline = env.ledger().timestamp().saturating_add(within_secs);
        let ids: Vec<String> = env
            .storage()
            .instance()
            .get(&METER_LIST)
            .unwrap_or(Vec::new(&env));
        let mut out = Vec::new(&env);
        for id in ids.iter() {
            if let Ok(Some(exp)) = Self::get_warranty_expiry(env.clone(), id.clone()) {
                if exp <= deadline {
                    out.push_back(id);
                }
            }
        }
        out
    }
}
