//! Dynamic Pricing Engine (#973).
use crate::{ContractError, SolarGridContract};
use soroban_sdk::{contractimpl, contracttype, symbol_short, Address, Env};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DynamicPricing {
    pub base_price: i128,
    pub current_multiplier: u32, // percentage scale (100 = 1.0x)
    pub min_price: i128,
    pub max_price: i128,
    pub last_updated_at: u64,
}

#[contracttype]
enum PricingKey {
    Config,
}

#[contractimpl]
impl SolarGridContract {
    /// Update dynamic pricing multiplier (admin function).
    pub fn update_pricing_multiplier(env: Env, admin: Address, multiplier: u32) -> Result<i128, ContractError> {
        admin.require_auth();
        if multiplier < 10 || multiplier > 1000 {
            return Err(ContractError::InvalidConfiguration);
        }
        let mut pricing: DynamicPricing = env
            .storage()
            .instance()
            .get(&PricingKey::Config)
            .unwrap_or(DynamicPricing {
                base_price: 1000,
                current_multiplier: 100,
                min_price: 100,
                max_price: 10000,
                last_updated_at: env.ledger().timestamp(),
            });
        pricing.current_multiplier = multiplier;
        pricing.last_updated_at = env.ledger().timestamp();
        env.storage().instance().set(&PricingKey::Config, &pricing);

        let price = (pricing.base_price * multiplier as i128) / 100;
        let final_price = price.clamp(pricing.min_price, pricing.max_price);

        env.events().publish(
            (symbol_short!("solar"), symbol_short!("price_upd")),
            (multiplier, final_price, pricing.last_updated_at),
        );

        Ok(final_price)
    }

    /// Retrieve the real-time dynamic electricity price.
    pub fn get_current_price(env: Env) -> i128 {
        let pricing: DynamicPricing = env
            .storage()
            .instance()
            .get(&PricingKey::Config)
            .unwrap_or(DynamicPricing {
                base_price: 1000,
                current_multiplier: 100,
                min_price: 100,
                max_price: 10000,
                last_updated_at: env.ledger().timestamp(),
            });
        let price = (pricing.base_price * pricing.current_multiplier as i128) / 100;
        price.clamp(pricing.min_price, pricing.max_price)
    }
}
