//! Staking lifecycle, reward accounting and guard-rail tests (Issues #874, #899).
mod common;

use common::Fixture;
use solar_grid::ContractError;
use soroban_sdk::{testutils::Address as _, token, Address};

struct Staking {
    fx: Fixture,
    stake_token: Address,
    reward_token: Address,
}

const RATE: i128 = 10; // reward units per second
const COOLDOWN: u64 = 3_600;

fn setup() -> Staking {
    let fx = Fixture::new();
    fx.set_time(1_000);
    let stake_token = fx
        .env
        .register_stellar_asset_contract_v2(Address::generate(&fx.env))
        .address();
    let reward_token = fx
        .env
        .register_stellar_asset_contract_v2(Address::generate(&fx.env))
        .address();
    fx.client
        .configure_staking(&stake_token, &reward_token, &RATE, &COOLDOWN);
    Staking {
        fx,
        stake_token,
        reward_token,
    }
}

impl Staking {
    fn mint_stake(&self, to: &Address, amount: i128) {
        token::StellarAssetClient::new(&self.fx.env, &self.stake_token).mint(to, &amount);
    }
    fn fund(&self, amount: i128) {
        let funder = Address::generate(&self.fx.env);
        token::StellarAssetClient::new(&self.fx.env, &self.reward_token).mint(&funder, &amount);
        self.fx.client.fund_staking_rewards(&funder, &amount);
    }
    fn staker(&self, amount: i128) -> Address {
        let s = Address::generate(&self.fx.env);
        self.mint_stake(&s, amount);
        self.fx.client.stake(&s, &amount);
        s
    }
    fn reward_balance(&self, who: &Address) -> i128 {
        token::Client::new(&self.fx.env, &self.reward_token).balance(who)
    }
    fn stake_balance(&self, who: &Address) -> i128 {
        token::Client::new(&self.fx.env, &self.stake_token).balance(who)
    }
}

#[test]
fn staking_requires_configuration() {
    let fx = Fixture::new();
    let s = Address::generate(&fx.env);
    assert_eq!(
        fx.client.try_stake(&s, &10),
        Err(Ok(ContractError::StakingNotConfigured))
    );
    assert_eq!(
        fx.client.try_get_staking_config(),
        Err(Ok(ContractError::StakingNotConfigured))
    );
}

#[test]
fn configure_rejects_payment_token_and_bad_values() {
    let fx = Fixture::new();
    let other = fx
        .env
        .register_stellar_asset_contract_v2(Address::generate(&fx.env))
        .address();
    // The payment token must never hold stakes (emergency_withdraw sweeps it).
    assert_eq!(
        fx.client.try_configure_staking(&fx.token, &other, &1, &0),
        Err(Ok(ContractError::InvalidConfiguration))
    );
    assert_eq!(
        fx.client.try_configure_staking(&other, &fx.token, &1, &0),
        Err(Ok(ContractError::InvalidConfiguration))
    );
    assert_eq!(
        fx.client.try_configure_staking(&other, &other, &-1, &0),
        Err(Ok(ContractError::InvalidConfiguration))
    );
    assert_eq!(
        fx.client
            .try_configure_staking(&other, &other, &1, &(91 * 86_400)),
        Err(Ok(ContractError::InvalidConfiguration))
    );
}

#[test]
fn single_staker_earns_rate_times_elapsed() {
    let st = setup();
    st.fund(1_000_000);
    let alice = st.staker(500);

    st.fx.advance(100);
    let info = st.fx.client.get_stake_info(&alice);
    assert_eq!(info.staked, 500);
    assert_eq!(info.voting_power, 500);
    assert_eq!(info.pending_rewards, RATE * 100);

    assert_eq!(st.fx.client.claim_staking_rewards(&alice), RATE * 100);
    assert_eq!(st.reward_balance(&alice), RATE * 100);
    // Claiming twice in the same ledger pays nothing more.
    assert_eq!(st.fx.client.claim_staking_rewards(&alice), 0);
}

#[test]
fn rewards_split_pro_rata_between_stakers() {
    let st = setup();
    st.fund(1_000_000);
    let alice = st.staker(300);
    let bob = st.staker(100);

    st.fx.advance(40); // 400 units emitted: 3/4 to alice, 1/4 to bob
    assert_eq!(st.fx.client.get_stake_info(&alice).pending_rewards, 300);
    assert_eq!(st.fx.client.get_stake_info(&bob).pending_rewards, 100);

    let pool = st.fx.client.get_staking_pool();
    assert_eq!(pool.total_staked, 400);
    assert_eq!(pool.staker_count, 2);
    assert_eq!(pool.total_distributed, 400);
    assert_eq!(st.fx.client.get_total_voting_power(), 400);
}

#[test]
fn emission_is_capped_by_funded_reserve() {
    let st = setup();
    st.fund(250);
    let alice = st.staker(1_000);

    st.fx.advance(10_000); // would emit 100_000 but only 250 is funded
    assert_eq!(st.fx.client.get_stake_info(&alice).pending_rewards, 250);
    assert_eq!(st.fx.client.claim_staking_rewards(&alice), 250);
    assert_eq!(st.fx.client.get_staking_pool().reward_reserve, 0);
}

#[test]
fn unstake_cooldown_withdraw_flow() {
    let st = setup();
    let alice = st.staker(1_000);

    let unlock_at = st.fx.client.request_unstake(&alice, &400);
    assert_eq!(unlock_at, 1_000 + COOLDOWN);
    let info = st.fx.client.get_stake_info(&alice);
    assert_eq!(info.staked, 600);
    assert_eq!(info.unstaking, 400);
    assert_eq!(st.fx.client.get_voting_power(&alice), 600);

    assert_eq!(
        st.fx.client.try_withdraw_unstaked(&alice),
        Err(Ok(ContractError::CooldownNotElapsed))
    );
    st.fx.advance(COOLDOWN);
    assert_eq!(st.fx.client.withdraw_unstaked(&alice), 400);
    assert_eq!(st.stake_balance(&alice), 400);
    assert_eq!(
        st.fx.client.try_withdraw_unstaked(&alice),
        Err(Ok(ContractError::NoPendingUnstake))
    );
}

#[test]
fn request_unstake_rejects_more_than_staked() {
    let st = setup();
    let alice = st.staker(100);
    assert_eq!(
        st.fx.client.try_request_unstake(&alice, &101),
        Err(Ok(ContractError::InsufficientStake))
    );
    assert_eq!(
        st.fx.client.try_request_unstake(&alice, &0),
        Err(Ok(ContractError::InvalidAmount))
    );
}

#[test]
fn full_exit_decrements_staker_count_and_cancel_restores_it() {
    let st = setup();
    let alice = st.staker(100);
    st.fx.client.request_unstake(&alice, &100);
    assert_eq!(st.fx.client.get_staking_pool().staker_count, 0);

    assert_eq!(st.fx.client.cancel_unstake(&alice), 100);
    let pool = st.fx.client.get_staking_pool();
    assert_eq!(pool.staker_count, 1);
    assert_eq!(pool.total_staked, 100);
    assert_eq!(
        st.fx.client.try_cancel_unstake(&alice),
        Err(Ok(ContractError::NoPendingUnstake))
    );
}

#[test]
fn cooling_down_tokens_stop_earning() {
    let st = setup();
    st.fund(1_000_000);
    let alice = st.staker(100);
    let bob = st.staker(100);
    st.fx.client.request_unstake(&bob, &100);

    st.fx.advance(10);
    // All 100 units emitted go to alice; bob's cooling stake earns nothing.
    assert_eq!(st.fx.client.get_stake_info(&alice).pending_rewards, 100);
    assert_eq!(st.fx.client.get_stake_info(&bob).pending_rewards, 0);
}

#[test]
fn pause_blocks_stake_but_not_exits() {
    let st = setup();
    st.fund(1_000);
    let alice = st.staker(100);
    st.fx.client.pause();

    let bob = Address::generate(&st.fx.env);
    st.mint_stake(&bob, 10);
    assert_eq!(
        st.fx.client.try_stake(&bob, &10),
        Err(Ok(ContractError::ContractPaused))
    );

    st.fx.advance(5);
    assert_eq!(st.fx.client.claim_staking_rewards(&alice), 50);
    st.fx.client.request_unstake(&alice, &100);
    st.fx.advance(COOLDOWN);
    assert_eq!(st.fx.client.withdraw_unstaked(&alice), 100);
}

#[test]
fn stake_token_cannot_change_while_funds_are_held() {
    let st = setup();
    st.staker(10);
    let other = st
        .fx
        .env
        .register_stellar_asset_contract_v2(Address::generate(&st.fx.env))
        .address();
    assert_eq!(
        st.fx
            .client
            .try_configure_staking(&other, &st.reward_token, &RATE, &COOLDOWN),
        Err(Ok(ContractError::InvalidConfiguration))
    );
    // Rate and cooldown can still be tuned for the same tokens.
    st.fx
        .client
        .configure_staking(&st.stake_token, &st.reward_token, &5, &60);
    assert_eq!(st.fx.client.get_staking_config().reward_rate, 5);
}
