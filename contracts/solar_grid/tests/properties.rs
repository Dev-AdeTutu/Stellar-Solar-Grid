//! Property-based tests for arithmetic and accounting invariants (Issue #874).
//!
//! Each case deploys a fresh contract, so case counts are kept modest to keep
//! CI fast; raise them locally with `PROPTEST_CASES=1000 cargo test`.
mod common;

use common::Fixture;
use proptest::prelude::*;
use solar_grid::{calculate_prorated_duration, ContractError, PaymentPlan};
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, Map, String};

fn plan_strategy() -> impl Strategy<Value = PaymentPlan> {
    prop_oneof![
        Just(PaymentPlan::Daily),
        Just(PaymentPlan::Weekly),
        Just(PaymentPlan::Monthly),
        Just(PaymentPlan::UsageBased),
    ]
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]

    /// Pro-rating never panics, is zero for non-positive amounts, at least one
    /// second for positive amounts, and monotonic in the amount paid.
    #[test]
    fn prorated_duration_is_total_and_monotonic(a in any::<i128>(), b in any::<i128>(), plan in plan_strategy()) {
        let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
        let d_lo = calculate_prorated_duration(lo, &plan);
        let d_hi = calculate_prorated_duration(hi, &plan);
        if lo <= 0 { prop_assert_eq!(d_lo, 0); } else { prop_assert!(d_lo >= 1); }
        if plan == PaymentPlan::UsageBased && hi > 0 { prop_assert_eq!(d_hi, u64::MAX); }
        prop_assert!(d_lo <= d_hi);
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(48))]

    /// compute_cost is units * price / 1000 for any price and never panics.
    #[test]
    fn compute_cost_matches_formula(units in any::<u64>(), price in 1i128..=1_000_000_000_000) {
        let fx = Fixture::new();
        fx.client.set_unit_price(&price);
        let expected = i128::from(units).saturating_mul(price) / 1000;
        prop_assert_eq!(fx.client.compute_cost(&units), expected);
    }

    /// Balance accounting: after any sequence of payments and usage charges the
    /// stored balance equals max(0, paid - charged) at every step, never goes
    /// negative, and the contract always holds every token that was paid in.
    #[test]
    fn meter_balance_never_negative(
        payments in prop::collection::vec(1i128..1_000_000, 1..6),
        charges in prop::collection::vec(0i128..2_000_000, 0..6),
    ) {
        let fx = Fixture::new();
        fx.oracle();
        fx.client.set_grace_period(&u64::MAX);
        let total_paid: i128 = payments.iter().sum();
        let (meter, owner) = fx.register("PROP");
        fx.mint(&owner, total_paid);

        let mut expected: i128 = 0;
        for p in &payments {
            fx.client.make_payment(&meter, &owner, p, &PaymentPlan::UsageBased, &None);
            expected += p;
        }
        for c in &charges {
            fx.client.update_usage(&meter, &1, c);
            expected = (expected - c).max(0);
            let balance = fx.client.get_meter_balance(&meter);
            prop_assert!(balance >= 0);
            prop_assert_eq!(balance, expected);
        }
        prop_assert_eq!(fx.token_client().balance(&fx.client.address), total_paid);
        prop_assert_eq!(fx.client.get_payer_paid(&meter, &owner), total_paid);
    }

    /// Refunds can never exceed what a payer contributed, no matter how the
    /// requests are split.
    #[test]
    fn refunds_never_exceed_payments(
        paid in 1i128..1_000_000,
        requests in prop::collection::vec(1i128..500_000, 1..8),
    ) {
        let fx = Fixture::new();
        let (meter, owner) = fx.register("RFND");
        fx.mint(&owner, paid);
        fx.client.make_payment(&meter, &owner, &paid, &PaymentPlan::UsageBased, &None);
        let reason = String::from_str(&fx.env, "prop");

        let mut refunded = 0i128;
        for r in &requests {
            match fx.client.try_refund_payment(&meter, r, &owner, &reason) {
                Ok(Ok(())) => refunded += r,
                Err(Ok(ContractError::RefundExceedsPayments)) => prop_assert!(refunded + r > paid),
                other => prop_assert!(false, "unexpected result {:?}", other),
            }
        }
        prop_assert!(refunded <= paid);
        prop_assert_eq!(fx.client.get_payer_refunded(&meter, &owner), refunded);
        prop_assert_eq!(fx.token_client().balance(&owner), refunded);
    }

    /// Metadata validation accepts exactly the maps within the documented
    /// limits (<= 10 pairs, values <= 100 bytes).
    #[test]
    fn metadata_validation_matches_limits(pairs in 0usize..14, value_len in 0usize..130) {
        let fx = Fixture::new();
        let (meter, _) = fx.register("META");
        let mut md = Map::new(&fx.env);
        let value = "v".repeat(value_len);
        for i in 0..pairs {
            md.set(String::from_str(&fx.env, &format!("k{i}")), String::from_str(&fx.env, &value));
        }
        let ok = pairs <= 10 && (pairs == 0 || value_len <= 100);
        let result = fx.client.try_update_meter_metadata(&meter, &md);
        if ok {
            prop_assert_eq!(result, Ok(Ok(())));
        } else {
            prop_assert_eq!(result, Err(Ok(ContractError::InvalidMetadata)));
        }
    }

    /// Staking rewards paid out never exceed what was funded, for any stake
    /// sizes and elapsed time.
    #[test]
    fn staking_rewards_bounded_by_funding(
        stakes in prop::collection::vec(1i128..1_000_000, 1..4),
        funded in 0i128..100_000,
        rate in 0i128..1_000,
        elapsed in 0u64..100_000,
    ) {
        let fx = Fixture::new();
        let stake_token = fx.env.register_stellar_asset_contract_v2(Address::generate(&fx.env)).address();
        let reward_token = fx.env.register_stellar_asset_contract_v2(Address::generate(&fx.env)).address();
        fx.client.configure_staking(&stake_token, &reward_token, &rate, &0);
        if funded > 0 {
            let funder = Address::generate(&fx.env);
            soroban_sdk::token::StellarAssetClient::new(&fx.env, &reward_token).mint(&funder, &funded);
            fx.client.fund_staking_rewards(&funder, &funded);
        }
        let mut stakers = std::vec::Vec::new();
        for s in &stakes {
            let who = Address::generate(&fx.env);
            soroban_sdk::token::StellarAssetClient::new(&fx.env, &stake_token).mint(&who, s);
            fx.client.stake(&who, s);
            stakers.push(who);
        }
        fx.advance(elapsed);
        let mut claimed = 0i128;
        for who in &stakers {
            claimed += fx.client.claim_staking_rewards(who);
        }
        prop_assert!(claimed <= funded);
        let pool = fx.client.get_staking_pool();
        prop_assert!(pool.reward_reserve >= 0);
        prop_assert_eq!(pool.reward_reserve + pool.total_distributed, funded);
    }
}
