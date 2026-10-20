//! Points-based loyalty rewards program (Issue #975).
//!
//! Users earn rewards for payments and usage.
//! 1 point per 1 XLM (10,000,000 stroops) spent.
//! Points can be redeemed for tariff discounts.
//! Tiers:
//! - Bronze: 0 - 499 points (0% base discount)
//! - Silver: 500 - 1999 points (5% discount)
//! - Gold: 2000+ points (10% discount)

use crate::{ContractError, SolarGridContract, SolarGridContractArgs, SolarGridContractClient, EVT_NS};
use soroban_sdk::{contractimpl, contracttype, Address, Env, Symbol};

pub const STROOPS_PER_XLM: i128 = 10_000_000;

#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum LoyaltyTier {
    Bronze = 0,
    Silver = 1,
    Gold = 2,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LoyaltyAccount {
    pub user: Address,
    pub points: u64,
    pub tier: LoyaltyTier,
    pub total_earned: u64,
    pub total_redeemed: u64,
}

#[contracttype]
#[derive(Clone)]
pub enum LoyaltyKey {
    Account(Address),
}

impl LoyaltyTier {
    pub fn from_points(points: u64) -> Self {
        if points >= 2000 {
            LoyaltyTier::Gold
        } else if points >= 500 {
            LoyaltyTier::Silver
        } else {
            LoyaltyTier::Bronze
        }
    }

    pub fn discount_percent(&self) -> u32 {
        match self {
            LoyaltyTier::Bronze => 0,
            LoyaltyTier::Silver => 5,
            LoyaltyTier::Gold => 10,
        }
    }
}

#[contractimpl]
impl SolarGridContract {
    /// Retrieve the loyalty account for a user, returning default Bronze if not found.
    pub fn get_loyalty_account(env: Env, user: Address) -> LoyaltyAccount {
        let key = LoyaltyKey::Account(user.clone());
        env.storage().persistent().get(&key).unwrap_or(LoyaltyAccount {
            user,
            points: 0,
            tier: LoyaltyTier::Bronze,
            total_earned: 0,
            total_redeemed: 0,
        })
    }

    /// Add loyalty points to a user's account and adjust their tier.
    /// Emits `PointsEarned`.
    pub fn add_loyalty_points(
        env: Env,
        user: Address,
        points: u64,
    ) -> Result<LoyaltyAccount, ContractError> {
        Self::require_not_paused(&env)?;
        if points == 0 {
            return Err(ContractError::InvalidLoyaltyPoints);
        }

        let mut account = Self::get_loyalty_account(env.clone(), user.clone());
        account.points = account.points.saturating_add(points);
        account.total_earned = account.total_earned.saturating_add(points);
        account.tier = LoyaltyTier::from_points(account.points);

        env.storage()
            .persistent()
            .set(&LoyaltyKey::Account(user.clone()), &account);

        env.events().publish(
            (EVT_NS, Symbol::new(&env, "points_earned"), user),
            (points, account.points, account.tier as u32),
        );

        Ok(account)
    }

    /// Helper to earn points on payments (1 point per XLM spent).
    pub fn earn_points_on_payment(
        env: Env,
        user: Address,
        payment_stroops: i128,
    ) -> Result<LoyaltyAccount, ContractError> {
        if payment_stroops <= 0 {
            return Err(ContractError::InvalidAmount);
        }
        let points = (payment_stroops / STROOPS_PER_XLM).max(1) as u64;
        Self::add_loyalty_points(env, user, points)
    }

    /// Redeem loyalty points for discounts.
    /// Emits `PointsRedeemed`.
    pub fn redeem_points(
        env: Env,
        user: Address,
        points: u64,
    ) -> Result<LoyaltyAccount, ContractError> {
        user.require_auth();
        Self::require_not_paused(&env)?;

        if points == 0 {
            return Err(ContractError::InvalidLoyaltyPoints);
        }

        let mut account = Self::get_loyalty_account(env.clone(), user.clone());
        if account.points < points {
            return Err(ContractError::InsufficientLoyaltyPoints);
        }

        account.points -= points;
        account.total_redeemed = account.total_redeemed.saturating_add(points);
        account.tier = LoyaltyTier::from_points(account.points);

        env.storage()
            .persistent()
            .set(&LoyaltyKey::Account(user.clone()), &account);

        env.events().publish(
            (EVT_NS, Symbol::new(&env, "points_redeemed"), user),
            (points, account.points, account.tier as u32),
        );

        Ok(account)
    }

    /// Get current discount percentage for user's tier (Bronze: 0%, Silver: 5%, Gold: 10%).
    pub fn get_loyalty_discount(env: Env, user: Address) -> u32 {
        let account = Self::get_loyalty_account(env, user);
        account.tier.discount_percent()
    }
}
