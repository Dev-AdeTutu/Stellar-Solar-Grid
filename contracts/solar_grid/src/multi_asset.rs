//! Multi-currency payment support (Issue #837).
//!
//! Admins whitelist Stellar assets (USDC, EURC, ...) together with a
//! conversion rate into the canonical payment token. Payments in a supported
//! asset are converted to canonical units before being credited, so every
//! balance and revenue figure in the contract stays in a single unit.

use crate::{ContractError, SolarGridContract, SolarGridContractArgs, SolarGridContractClient};
use soroban_sdk::{contractimpl, contracttype, symbol_short, token, Address, Env, Symbol, Vec};

/// Fixed-point scale for conversion rates: `rate = canonical units per 1 asset unit * RATE_SCALE`.
pub const RATE_SCALE: i128 = 10_000_000;

const SUPPORTED_ASSETS: Symbol = symbol_short!("SUP_ASST");

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct SupportedAsset {
    pub asset: Address,
    /// Canonical units per asset unit, scaled by `RATE_SCALE`.
    pub rate: i128,
}

#[contracttype]
#[derive(Clone)]
enum AssetKey {
    Rate(Address),
    MeterCanonicalBalance(soroban_sdk::String),
}

/// Convert `amount` of an asset into canonical units using `rate`.
pub fn to_canonical(amount: i128, rate: i128) -> Result<i128, ContractError> {
    amount
        .checked_mul(rate)
        .map(|v| v / RATE_SCALE)
        .ok_or(ContractError::InvalidAmount)
}

#[contractimpl]
impl SolarGridContract {
    /// Admin: whitelist `asset` (or update its rate). `rate` must be > 0.
    pub fn add_supported_asset(env: Env, asset: Address, rate: i128) -> Result<(), ContractError> {
        Self::require_admin(&env)?;
        if rate <= 0 {
            return Err(ContractError::InvalidConfiguration);
        }
        let mut list: Vec<Address> = env
            .storage()
            .instance()
            .get(&SUPPORTED_ASSETS)
            .unwrap_or(Vec::new(&env));
        if !list.contains(&asset) {
            list.push_back(asset.clone());
            env.storage().instance().set(&SUPPORTED_ASSETS, &list);
        }
        env.storage().persistent().set(&AssetKey::Rate(asset.clone()), &rate);
        env.events()
            .publish((symbol_short!("solar"), symbol_short!("asset_add")), (asset, rate));
        Ok(())
    }

    /// Admin: remove `asset` from the whitelist.
    pub fn remove_supported_asset(env: Env, asset: Address) -> Result<(), ContractError> {
        Self::require_admin(&env)?;
        let list: Vec<Address> = env
            .storage()
            .instance()
            .get(&SUPPORTED_ASSETS)
            .unwrap_or(Vec::new(&env));
        let mut next = Vec::new(&env);
        for a in list.iter() {
            if a != asset {
                next.push_back(a);
            }
        }
        env.storage().instance().set(&SUPPORTED_ASSETS, &next);
        env.storage().persistent().remove(&AssetKey::Rate(asset));
        Ok(())
    }

    /// Admin: update the conversion rate of an already-supported asset.
    pub fn set_asset_rate(env: Env, asset: Address, rate: i128) -> Result<(), ContractError> {
        Self::require_admin(&env)?;
        if rate <= 0 {
            return Err(ContractError::InvalidConfiguration);
        }
        let key = AssetKey::Rate(asset);
        if !env.storage().persistent().has(&key) {
            return Err(ContractError::InvalidConfiguration);
        }
        env.storage().persistent().set(&key, &rate);
        Ok(())
    }

    /// List every supported asset with its current conversion rate.
    pub fn supported_assets(env: Env) -> Vec<SupportedAsset> {
        let list: Vec<Address> = env
            .storage()
            .instance()
            .get(&SUPPORTED_ASSETS)
            .unwrap_or(Vec::new(&env));
        let mut out = Vec::new(&env);
        for asset in list.iter() {
            if let Some(rate) = env.storage().persistent().get(&AssetKey::Rate(asset.clone())) {
                out.push_back(SupportedAsset { asset, rate });
            }
        }
        out
    }

    /// Pay for a meter in any supported asset. The asset amount is transferred
    /// to the contract and the meter is credited in canonical units.
    /// Returns the credited canonical amount.
    pub fn make_asset_payment(
        env: Env,
        meter_id: soroban_sdk::String,
        payer: Address,
        asset: Address,
        amount: i128,
    ) -> Result<i128, ContractError> {
        payer.require_auth();
        if amount <= 0 {
            return Err(ContractError::InvalidAmount);
        }
        // Ensure the meter exists.
        Self::get_meter_metadata(env.clone(), meter_id.clone())?;
        let rate: i128 = env
            .storage()
            .persistent()
            .get(&AssetKey::Rate(asset.clone()))
            .ok_or(ContractError::InvalidConfiguration)?;
        let canonical = to_canonical(amount, rate)?;
        if canonical <= 0 {
            return Err(ContractError::InvalidAmount);
        }
        let key = AssetKey::MeterCanonicalBalance(meter_id.clone());
        let bal: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        env.storage().persistent().set(&key, &bal.saturating_add(canonical));

        token::Client::new(&env, &asset).transfer(&payer, &env.current_contract_address(), &amount);
        env.events().publish(
            (symbol_short!("solar"), symbol_short!("asset_pay"), meter_id),
            (payer, asset, amount, canonical),
        );
        Ok(canonical)
    }

    /// Canonical-unit balance credited to a meter via `make_asset_payment`.
    pub fn get_asset_payment_balance(env: Env, meter_id: soroban_sdk::String) -> i128 {
        env.storage()
            .persistent()
            .get(&AssetKey::MeterCanonicalBalance(meter_id))
            .unwrap_or(0)
    }
}
