//! Energy token staking (Issue #899).
//!
//! Users stake the configured stake token to earn rewards and governance
//! voting power.
//!
//! Rewards: the admin funds a reward reserve (`fund_staking_rewards`) and sets
//! a `reward_rate` (reward units emitted per second across all stakers). Rewards
//! are distributed pro-rata to stake using a reward-per-share accumulator, so
//! every operation is O(1) regardless of the number of stakers. Emission stops
//! when the reserve is exhausted, so the contract can never promise more
//! rewards than it holds.
//!
//! Unstaking is two-step: `request_unstake` moves tokens into a cooldown bucket
//! (they stop earning rewards and stop counting toward voting power
//! immediately), and `withdraw_unstaked` returns them once `cooldown_secs` has
//! passed. A new request while tokens are already cooling down adds to the
//! bucket and restarts the cooldown for the whole bucket.
//!
//! Voting power = actively staked amount (`get_voting_power`). Governance
//! callers pass this value as the vote weight.
//!
//! Pause behaviour: `stake` is blocked while the contract is paused; exits
//! (`request_unstake`, `withdraw_unstaked`, `claim_staking_rewards`) are
//! always allowed so users are never locked in.

use crate::{ContractError, SolarGridContract, SolarGridContractArgs, SolarGridContractClient};
use soroban_sdk::{contractimpl, contracttype, symbol_short, token, Address, Env};

/// Fixed-point scale for `acc_reward_per_share`.
pub const ACC_SCALE: i128 = 1_000_000_000_000;
/// Upper bound on the cooldown (90 days) so a misconfiguration can't trap funds.
pub const MAX_COOLDOWN_SECS: u64 = 90 * 86_400;

#[contracttype]
#[derive(Clone)]
enum StakeKey {
    Config,
    Pool,
    Position(Address),
    Unstaking(Address),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StakingConfig {
    pub stake_token: Address,
    pub reward_token: Address,
    /// Reward units emitted per second, shared by all stakers.
    pub reward_rate: i128,
    pub cooldown_secs: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StakingPool {
    pub total_staked: i128,
    /// Accumulated reward per staked unit, scaled by `ACC_SCALE`.
    pub acc_reward_per_share: i128,
    pub last_update: u64,
    /// Funded rewards not yet allocated to stakers.
    pub reward_reserve: i128,
    /// Rewards allocated to stakers since inception (claimed or not).
    pub total_distributed: i128,
    pub staker_count: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
struct StakePosition {
    amount: i128,
    reward_debt: i128,
    pending_rewards: i128,
    staked_at: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UnstakeRequest {
    pub amount: i128,
    pub unlock_at: u64,
}

/// Read-only view of a staker's position.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StakeInfo {
    pub staked: i128,
    pub pending_rewards: i128,
    pub unstaking: i128,
    pub unlock_at: u64,
    pub voting_power: i128,
    pub staked_at: u64,
}

fn mul_div(a: i128, b: i128, d: i128) -> Result<i128, ContractError> {
    a.checked_mul(b)
        .map(|v| v / d)
        .ok_or(ContractError::InvalidAmount)
}

fn load_config(env: &Env) -> Result<StakingConfig, ContractError> {
    env.storage()
        .instance()
        .get(&StakeKey::Config)
        .ok_or(ContractError::StakingNotConfigured)
}

fn load_pool(env: &Env) -> StakingPool {
    env.storage().instance().get(&StakeKey::Pool).unwrap_or(StakingPool {
        total_staked: 0,
        acc_reward_per_share: 0,
        last_update: env.ledger().timestamp(),
        reward_reserve: 0,
        total_distributed: 0,
        staker_count: 0,
    })
}

fn load_position(env: &Env, staker: &Address) -> StakePosition {
    env.storage()
        .persistent()
        .get(&StakeKey::Position(staker.clone()))
        .unwrap_or(StakePosition {
            amount: 0,
            reward_debt: 0,
            pending_rewards: 0,
            staked_at: 0,
        })
}

fn save_position(env: &Env, staker: &Address, pos: &StakePosition) {
    let key = StakeKey::Position(staker.clone());
    if pos.amount == 0 && pos.pending_rewards == 0 {
        env.storage().persistent().remove(&key);
    } else {
        env.storage().persistent().set(&key, pos);
    }
}

/// Advance the accumulator to `now`, capping emission at the funded reserve.
fn accrue(pool: &mut StakingPool, rate: i128, now: u64) -> Result<(), ContractError> {
    if now <= pool.last_update {
        return Ok(());
    }
    if pool.total_staked > 0 && rate > 0 && pool.reward_reserve > 0 {
        let elapsed = (now - pool.last_update) as i128;
        let emitted = rate
            .checked_mul(elapsed)
            .ok_or(ContractError::InvalidAmount)?
            .min(pool.reward_reserve);
        let delta = mul_div(emitted, ACC_SCALE, pool.total_staked)?;
        // Only deduct what the accumulator actually allocates, so rounding
        // dust stays in the reserve instead of being lost.
        let allocated = mul_div(delta, pool.total_staked, ACC_SCALE)?;
        pool.acc_reward_per_share = pool
            .acc_reward_per_share
            .checked_add(delta)
            .ok_or(ContractError::InvalidAmount)?;
        pool.reward_reserve -= allocated;
        pool.total_distributed += allocated;
    }
    pool.last_update = now;
    Ok(())
}

/// Move rewards earned since the last touch into `pending_rewards`.
fn settle(pos: &mut StakePosition, pool: &StakingPool) -> Result<(), ContractError> {
    let accrued = mul_div(pos.amount, pool.acc_reward_per_share, ACC_SCALE)?;
    pos.pending_rewards += accrued - pos.reward_debt;
    Ok(())
}

fn reset_debt(pos: &mut StakePosition, pool: &StakingPool) -> Result<(), ContractError> {
    pos.reward_debt = mul_div(pos.amount, pool.acc_reward_per_share, ACC_SCALE)?;
    Ok(())
}

/// Load config + pool and bring the pool up to date.
fn touch_pool(env: &Env) -> Result<(StakingConfig, StakingPool), ContractError> {
    let cfg = load_config(env)?;
    let mut pool = load_pool(env);
    accrue(&mut pool, cfg.reward_rate, env.ledger().timestamp())?;
    Ok((cfg, pool))
}

#[contractimpl]
impl SolarGridContract {
    /// Admin: configure (or reconfigure) staking. The stake token cannot be
    /// changed while anything is staked or cooling down.
    pub fn configure_staking(
        env: Env,
        stake_token: Address,
        reward_token: Address,
        reward_rate: i128,
        cooldown_secs: u64,
    ) -> Result<(), ContractError> {
        Self::require_admin(&env)?;
        if reward_rate < 0 || cooldown_secs > MAX_COOLDOWN_SECS {
            return Err(ContractError::InvalidConfiguration);
        }
        // Staking balances must never share a token with payment funds:
        // `emergency_withdraw` and revenue withdrawals sweep the contract's
        // payment-token balance, which would otherwise include user stakes.
        if let Ok(payment_token) = Self::get_token_address(&env) {
            if stake_token == payment_token || reward_token == payment_token {
                return Err(ContractError::InvalidConfiguration);
            }
        }
        for asset in Self::supported_assets(env.clone()).iter() {
            if asset.asset == stake_token || asset.asset == reward_token {
                return Err(ContractError::InvalidConfiguration);
            }
        }
        let mut pool = load_pool(&env);
        if let Some(prev) = env
            .storage()
            .instance()
            .get::<StakeKey, StakingConfig>(&StakeKey::Config)
        {
            // Accrue at the old rate before switching.
            accrue(&mut pool, prev.reward_rate, env.ledger().timestamp())?;
            if (prev.stake_token != stake_token || prev.reward_token != reward_token)
                && (pool.total_staked > 0 || pool.reward_reserve > 0 || pool.total_distributed > 0)
            {
                return Err(ContractError::InvalidConfiguration);
            }
        } else {
            pool.last_update = env.ledger().timestamp();
        }
        let cfg = StakingConfig {
            stake_token,
            reward_token,
            reward_rate,
            cooldown_secs,
        };
        env.storage().instance().set(&StakeKey::Config, &cfg);
        env.storage().instance().set(&StakeKey::Pool, &pool);
        env.events().publish(
            (symbol_short!("solar"), symbol_short!("stk_cfg")),
            (reward_rate, cooldown_secs),
        );
        Ok(())
    }

    /// Deposit `amount` of the reward token into the reward reserve. Anyone may fund.
    pub fn fund_staking_rewards(env: Env, from: Address, amount: i128) -> Result<(), ContractError> {
        from.require_auth();
        if amount <= 0 {
            return Err(ContractError::InvalidAmount);
        }
        let (cfg, mut pool) = touch_pool(&env)?;
        pool.reward_reserve = pool
            .reward_reserve
            .checked_add(amount)
            .ok_or(ContractError::InvalidAmount)?;
        env.storage().instance().set(&StakeKey::Pool, &pool);
        token::Client::new(&env, &cfg.reward_token).transfer(
            &from,
            &env.current_contract_address(),
            &amount,
        );
        env.events()
            .publish((symbol_short!("solar"), symbol_short!("stk_fund")), (from, amount));
        Ok(())
    }

    /// Stake `amount` of the stake token.
    pub fn stake(env: Env, staker: Address, amount: i128) -> Result<(), ContractError> {
        staker.require_auth();
        if Self::pause_is_active(&env) {
            return Err(ContractError::ContractPaused);
        }
        if amount <= 0 {
            return Err(ContractError::InvalidAmount);
        }
        let (cfg, mut pool) = touch_pool(&env)?;
        let mut pos = load_position(&env, &staker);
        settle(&mut pos, &pool)?;
        if pos.amount == 0 {
            pool.staker_count += 1;
            pos.staked_at = env.ledger().timestamp();
        }
        pos.amount = pos.amount.checked_add(amount).ok_or(ContractError::InvalidAmount)?;
        pool.total_staked = pool
            .total_staked
            .checked_add(amount)
            .ok_or(ContractError::InvalidAmount)?;
        reset_debt(&mut pos, &pool)?;

        // Effects before interaction; a failed transfer reverts the whole call.
        save_position(&env, &staker, &pos);
        env.storage().instance().set(&StakeKey::Pool, &pool);
        token::Client::new(&env, &cfg.stake_token).transfer(
            &staker,
            &env.current_contract_address(),
            &amount,
        );
        env.events()
            .publish((symbol_short!("solar"), symbol_short!("staked")), (staker, amount));
        Ok(())
    }

    /// Begin unstaking `amount`. Tokens stop earning immediately and can be
    /// withdrawn after the cooldown. Returns the unlock timestamp.
    pub fn request_unstake(env: Env, staker: Address, amount: i128) -> Result<u64, ContractError> {
        staker.require_auth();
        if amount <= 0 {
            return Err(ContractError::InvalidAmount);
        }
        let (cfg, mut pool) = touch_pool(&env)?;
        let mut pos = load_position(&env, &staker);
        if amount > pos.amount {
            return Err(ContractError::InsufficientStake);
        }
        settle(&mut pos, &pool)?;
        pos.amount -= amount;
        pool.total_staked -= amount;
        if pos.amount == 0 {
            pool.staker_count = pool.staker_count.saturating_sub(1);
            pos.staked_at = 0;
        }
        reset_debt(&mut pos, &pool)?;

        let key = StakeKey::Unstaking(staker.clone());
        let prev: Option<UnstakeRequest> = env.storage().persistent().get(&key);
        let unlock_at = env.ledger().timestamp().saturating_add(cfg.cooldown_secs);
        let request = UnstakeRequest {
            amount: prev.map(|p| p.amount).unwrap_or(0) + amount,
            unlock_at,
        };
        env.storage().persistent().set(&key, &request);
        save_position(&env, &staker, &pos);
        env.storage().instance().set(&StakeKey::Pool, &pool);
        env.events().publish(
            (symbol_short!("solar"), symbol_short!("unstk_req")),
            (staker, amount, unlock_at),
        );
        Ok(unlock_at)
    }

    /// Return cooled-down tokens to the staker. Returns the amount withdrawn.
    pub fn withdraw_unstaked(env: Env, staker: Address) -> Result<i128, ContractError> {
        staker.require_auth();
        let cfg = load_config(&env)?;
        let key = StakeKey::Unstaking(staker.clone());
        let request: UnstakeRequest = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(ContractError::NoPendingUnstake)?;
        if env.ledger().timestamp() < request.unlock_at {
            return Err(ContractError::CooldownNotElapsed);
        }
        env.storage().persistent().remove(&key);
        token::Client::new(&env, &cfg.stake_token).transfer(
            &env.current_contract_address(),
            &staker,
            &request.amount,
        );
        env.events().publish(
            (symbol_short!("solar"), symbol_short!("unstaked")),
            (staker, request.amount),
        );
        Ok(request.amount)
    }

    /// Move tokens that are cooling down back into the active stake.
    pub fn cancel_unstake(env: Env, staker: Address) -> Result<i128, ContractError> {
        staker.require_auth();
        if Self::pause_is_active(&env) {
            return Err(ContractError::ContractPaused);
        }
        let key = StakeKey::Unstaking(staker.clone());
        let request: UnstakeRequest = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(ContractError::NoPendingUnstake)?;
        let (_cfg, mut pool) = touch_pool(&env)?;
        let mut pos = load_position(&env, &staker);
        settle(&mut pos, &pool)?;
        if pos.amount == 0 {
            pool.staker_count += 1;
            pos.staked_at = env.ledger().timestamp();
        }
        pos.amount += request.amount;
        pool.total_staked += request.amount;
        reset_debt(&mut pos, &pool)?;
        env.storage().persistent().remove(&key);
        save_position(&env, &staker, &pos);
        env.storage().instance().set(&StakeKey::Pool, &pool);
        env.events().publish(
            (symbol_short!("solar"), symbol_short!("unstk_cxl")),
            (staker, request.amount),
        );
        Ok(request.amount)
    }

    /// Pay out all accrued rewards. Returns the amount claimed.
    pub fn claim_staking_rewards(env: Env, staker: Address) -> Result<i128, ContractError> {
        staker.require_auth();
        let (cfg, pool) = touch_pool(&env)?;
        let mut pos = load_position(&env, &staker);
        settle(&mut pos, &pool)?;
        reset_debt(&mut pos, &pool)?;
        let reward = pos.pending_rewards;
        pos.pending_rewards = 0;
        save_position(&env, &staker, &pos);
        env.storage().instance().set(&StakeKey::Pool, &pool);
        if reward > 0 {
            token::Client::new(&env, &cfg.reward_token).transfer(
                &env.current_contract_address(),
                &staker,
                &reward,
            );
            env.events()
                .publish((symbol_short!("solar"), symbol_short!("stk_claim")), (staker, reward));
        }
        Ok(reward)
    }

    pub fn get_staking_config(env: Env) -> Result<StakingConfig, ContractError> {
        load_config(&env)
    }

    /// Pool totals, projected to the current ledger time (read-only).
    pub fn get_staking_pool(env: Env) -> Result<StakingPool, ContractError> {
        Ok(touch_pool(&env)?.1)
    }

    /// A staker's position with rewards projected to the current ledger time.
    pub fn get_stake_info(env: Env, staker: Address) -> Result<StakeInfo, ContractError> {
        let (_cfg, pool) = touch_pool(&env)?;
        let mut pos = load_position(&env, &staker);
        settle(&mut pos, &pool)?;
        let unstaking: Option<UnstakeRequest> = env
            .storage()
            .persistent()
            .get(&StakeKey::Unstaking(staker));
        Ok(StakeInfo {
            staked: pos.amount,
            pending_rewards: pos.pending_rewards,
            unstaking: unstaking.as_ref().map(|u| u.amount).unwrap_or(0),
            unlock_at: unstaking.map(|u| u.unlock_at).unwrap_or(0),
            voting_power: pos.amount,
            staked_at: pos.staked_at,
        })
    }

    /// Governance voting power: the actively staked amount (cooling-down
    /// tokens don't count, so power can't be reused after exiting).
    pub fn get_voting_power(env: Env, voter: Address) -> i128 {
        load_position(&env, &voter).amount
    }

    /// Sum of all voting power, for quorum calculations.
    pub fn get_total_voting_power(env: Env) -> i128 {
        load_pool(&env).total_staked
    }
}
