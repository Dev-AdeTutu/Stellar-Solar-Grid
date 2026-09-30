//! Payments, delegation, auto top-up, meter groups, referrals, time-of-use
//! pricing and revenue sharing (Issue #874).
mod common;

use common::Fixture;
use solar_grid::{ContractError, PaymentPlan, PricingSchedule, PricingWindow, RATE_SCALE};
use soroban_sdk::{testutils::Address as _, token, vec, Address, Vec};

// ── Delegated payments ───────────────────────────────────────────────────────

#[test]
fn delegate_can_pay_until_removed() {
    let fx = Fixture::new();
    let (meter, _owner) = fx.register("DLG");
    let delegate = Address::generate(&fx.env);
    fx.mint(&delegate, 1_000);

    assert_eq!(
        fx.client
            .try_make_delegated_payment(&meter, &delegate, &100, &PaymentPlan::Daily, &None),
        Err(Ok(ContractError::Unauthorized))
    );
    fx.client.add_delegate(&meter, &delegate);
    assert_eq!(
        fx.client.get_delegates(&meter),
        vec![&fx.env, delegate.clone()]
    );

    fx.client
        .make_delegated_payment(&meter, &delegate, &300, &PaymentPlan::Daily, &None);
    assert_eq!(fx.client.get_meter_balance(&meter), 300);
    assert_eq!(fx.client.get_payer_paid(&meter, &delegate), 300);
    assert!(fx.client.get_meter(&meter).active);
    assert_eq!(fx.client.get_provider_revenue(&fx.admin), 300);

    fx.client.remove_delegate(&meter, &delegate);
    assert_eq!(fx.client.get_delegates(&meter).len(), 0);
    assert_eq!(
        fx.client
            .try_make_delegated_payment(&meter, &delegate, &100, &PaymentPlan::Daily, &None),
        Err(Ok(ContractError::Unauthorized))
    );
}

#[test]
fn delegated_payment_validates_amount_and_pause() {
    let fx = Fixture::new();
    let (meter, _owner) = fx.register("DLG2");
    let delegate = Address::generate(&fx.env);
    fx.client.add_delegate(&meter, &delegate);
    assert_eq!(
        fx.client
            .try_make_delegated_payment(&meter, &delegate, &0, &PaymentPlan::Daily, &None),
        Err(Ok(ContractError::InvalidAmount))
    );
    fx.client.pause();
    assert_eq!(
        fx.client
            .try_make_delegated_payment(&meter, &delegate, &1, &PaymentPlan::Daily, &None),
        Err(Ok(ContractError::ContractPaused))
    );
}

// ── Auto top-up ──────────────────────────────────────────────────────────────

#[test]
fn auto_topup_pulls_allowance_below_threshold() {
    let fx = Fixture::new();
    let (meter, owner) = fx.register_and_fund("ATU", 100, PaymentPlan::UsageBased);
    assert_eq!(
        fx.client.try_trigger_auto_topup(&meter),
        Err(Ok(ContractError::AutoTopupNotConfigured))
    );
    assert_eq!(
        fx.client.try_enable_auto_topup(&meter, &0, &10),
        Err(Ok(ContractError::InvalidAutoTopup))
    );

    fx.client.enable_auto_topup(&meter, &500, &1_000);
    let cfg = fx.client.get_auto_topup(&meter).unwrap();
    assert_eq!((cfg.threshold, cfg.amount, cfg.enabled), (500, 1_000, true));

    fx.mint(&owner, 5_000);
    let expiry = fx.env.ledger().sequence() + 1_000;
    fx.token_client()
        .approve(&owner, &fx.client.address, &5_000, &expiry);

    assert!(fx.client.trigger_auto_topup(&meter));
    assert_eq!(fx.client.get_meter_balance(&meter), 1_100);
    // Above the threshold now: a concurrent trigger is a no-op.
    assert!(!fx.client.trigger_auto_topup(&meter));

    fx.client.disable_auto_topup(&meter);
    assert!(!fx.client.get_auto_topup(&meter).unwrap().enabled);
}

// ── Meter groups ─────────────────────────────────────────────────────────────

#[test]
fn group_batch_payment_splits_amount_with_remainder() {
    let fx = Fixture::new();
    let (m1, owner) = fx.register("G1");
    let m2 = fx.id("G2");
    let m3 = fx.id("G3");
    fx.client.register_meter(&m2, &owner);
    fx.client.register_meter(&m3, &owner);

    let group = fx.id("HOME");
    fx.client.create_meter_group(&group, &fx.id("Home"), &owner);
    assert_eq!(
        fx.client
            .try_create_meter_group(&group, &fx.id("Dup"), &owner),
        Err(Ok(ContractError::MeterGroupAlreadyExists))
    );
    for m in [&m1, &m2, &m3] {
        fx.client.add_meter_to_group(&group, m);
    }
    fx.client.add_meter_to_group(&group, &m1); // idempotent

    fx.mint(&owner, 100);
    let paid = fx
        .client
        .batch_pay_group(&group, &owner, &100, &PaymentPlan::Weekly, &None);
    assert_eq!(paid.len(), 3);
    // 100 / 3 = 33 remainder 1: the first meter receives the extra unit.
    assert_eq!(fx.client.get_meter_balance(&m1), 34);
    assert_eq!(fx.client.get_meter_balance(&m2), 33);
    assert_eq!(fx.client.get_meter_balance(&m3), 33);

    let stats = fx.client.get_group_stats(&group);
    assert_eq!(
        (stats.meter_count, stats.active_count, stats.total_balance),
        (3, 3, 100)
    );

    fx.client.remove_meter_from_group(&group, &m3);
    assert_eq!(fx.client.get_group_stats(&group).meter_count, 2);
}

#[test]
fn groups_only_accept_the_owners_meters() {
    let fx = Fixture::new();
    let (_mine, owner) = fx.register("GA");
    let (theirs, _) = fx.register("GB");
    let group = fx.id("GRP");
    fx.client.create_meter_group(&group, &fx.id("g"), &owner);
    assert_eq!(
        fx.client.try_add_meter_to_group(&group, &theirs),
        Err(Ok(ContractError::Unauthorized))
    );
    let missing = fx.id("NOGRP");
    assert_eq!(
        fx.client.try_get_group_stats(&missing),
        Err(Ok(ContractError::MeterGroupNotFound))
    );
    assert_eq!(
        fx.client
            .try_batch_pay_group(&group, &owner, &10, &PaymentPlan::Daily, &None),
        Err(Ok(ContractError::InvalidAmount)),
        "empty groups cannot be paid"
    );
}

// ── Referrals ────────────────────────────────────────────────────────────────

#[test]
fn referral_credit_accrues_on_referred_payments() {
    let fx = Fixture::new();
    fx.client.set_referral_bonus_percent(&10);
    let referrer = Address::generate(&fx.env);
    let (meter, payer) = fx.register("REF");
    fx.client.set_referrer(&payer, &referrer);

    fx.mint(&payer, 1_000);
    fx.client
        .make_payment(&meter, &payer, &1_000, &PaymentPlan::Daily, &None);
    assert_eq!(fx.client.get_referral_credit(&referrer), 100);
    let stats = fx.client.get_referral_stats(&referrer);
    assert_eq!((stats.referred_count, stats.total_credits), (1, 100));
}

#[test]
fn referral_rules_are_enforced() {
    let fx = Fixture::new();
    let a = Address::generate(&fx.env);
    let b = Address::generate(&fx.env);
    assert_eq!(
        fx.client.try_set_referral_bonus_percent(&101),
        Err(Ok(ContractError::InvalidReferral))
    );
    assert_eq!(
        fx.client.try_set_referrer(&a, &a),
        Err(Ok(ContractError::InvalidReferral))
    );
    fx.client.set_referrer(&a, &b);
    assert_eq!(
        fx.client.try_set_referrer(&a, &b),
        Err(Ok(ContractError::InvalidReferral))
    );
}

// ── Time-of-use pricing ──────────────────────────────────────────────────────

const DAY: u64 = 86_400;

fn window(start: u32, end: u32, rate: i128) -> PricingWindow {
    PricingWindow {
        start_minute: start,
        end_minute: end,
        rate,
    }
}

#[test]
fn time_of_use_schedule_picks_weekday_and_weekend_rates() {
    let fx = Fixture::new();
    fx.client.set_unit_price(&5);
    let schedule = PricingSchedule {
        weekday: vec![&fx.env, window(0, 360, 2), window(1_080, 1_320, 20)],
        weekend: vec![&fx.env, window(0, 1_440, 3)],
    };
    fx.client.set_pricing_schedule(&schedule);

    // 1970-01-01 was a Thursday.
    fx.set_time(60 * 60); // Thu 01:00 → off-peak window
    assert_eq!(fx.client.get_current_rate(), 2);
    fx.set_time(19 * 60 * 60); // Thu 19:00 → peak window
    assert_eq!(fx.client.get_current_rate(), 20);
    assert_eq!(fx.client.compute_cost(&1_000), 20);
    fx.set_time(12 * 60 * 60); // Thu 12:00 → no window, falls back to unit price
    assert_eq!(fx.client.get_current_rate(), 5);
    fx.set_time(2 * DAY + 12 * 60 * 60); // Sat 12:00 → weekend rate
    assert_eq!(fx.client.get_current_rate(), 3);
}

#[test]
fn invalid_pricing_windows_are_rejected() {
    let fx = Fixture::new();
    let cases: [Vec<PricingWindow>; 4] = [
        vec![&fx.env, window(100, 100, 1)],
        vec![&fx.env, window(0, 1_441, 1)],
        vec![&fx.env, window(0, 10, 0)],
        vec![&fx.env, window(0, 100, 1), window(50, 200, 1)],
    ];
    for weekday in cases {
        let schedule = PricingSchedule {
            weekday,
            weekend: vec![&fx.env],
        };
        assert_eq!(
            fx.client.try_set_pricing_schedule(&schedule),
            Err(Ok(ContractError::InvalidConfiguration))
        );
    }
    assert_eq!(
        fx.client.try_set_unit_price(&0),
        Err(Ok(ContractError::InvalidConfiguration))
    );
}

// ── Revenue sharing ──────────────────────────────────────────────────────────

#[test]
fn distribute_and_transfer_pays_collaborators_by_share() {
    let fx = Fixture::new();
    fx.register_and_fund("REV", 10_000, PaymentPlan::UsageBased);
    let a = Address::generate(&fx.env);
    let b = Address::generate(&fx.env);
    fx.client.add_collaborator(&a, &6_000);
    fx.client.add_collaborator(&b, &2_500);
    assert_eq!(
        fx.client
            .try_add_collaborator(&Address::generate(&fx.env), &2_000),
        Err(Ok(ContractError::InvalidAmount)),
        "total shares cannot exceed 100%"
    );

    let payouts = fx.client.distribute_and_transfer(&1_000);
    assert_eq!(payouts.get(a.clone()), Some(600));
    assert_eq!(payouts.get(b.clone()), Some(250));
    assert_eq!(fx.token_client().balance(&a), 600);
    assert_eq!(fx.token_client().balance(&b), 250);

    let summary = fx.client.get_revenue_summary();
    assert!(summary.len() >= 2);
    assert_eq!(
        fx.client.try_distribute_and_transfer(&0),
        Err(Ok(ContractError::InvalidAmount))
    );
}

#[test]
fn refunds_are_capped_by_what_the_payer_paid() {
    let fx = Fixture::new();
    let (meter, owner) = fx.register_and_fund("RFD", 1_000, PaymentPlan::UsageBased);
    let reason = fx.id("duplicate charge");
    fx.client.set_refund_limit(&500);
    fx.client.refund_payment(&meter, &400, &owner, &reason);
    assert_eq!(fx.client.get_payer_refunded(&meter, &owner), 400);
    assert_eq!(fx.client.get_meter_balance(&meter), 600);
    assert_eq!(
        fx.client.try_refund_payment(&meter, &601, &owner, &reason),
        Err(Ok(ContractError::RefundExceedsPayments))
    );

    assert_eq!(
        fx.client.try_refund_payment(&meter, &200, &owner, &reason),
        Err(Ok(ContractError::RefundLimitExceeded)),
        "400 of the 500 daily limit is already used"
    );
    // The rolling window resets after 24 hours.
    fx.advance(86_401);
    fx.client.refund_payment(&meter, &200, &owner, &reason);
    assert_eq!(fx.client.get_payer_refunded(&meter, &owner), 600);
}

// ── Multi-asset ──────────────────────────────────────────────────────────────

#[test]
fn asset_rate_updates_apply_to_new_payments() {
    let fx = Fixture::new();
    let (meter, payer) = fx.register("MA");
    let usdc = fx
        .env
        .register_stellar_asset_contract_v2(Address::generate(&fx.env))
        .address();
    token::StellarAssetClient::new(&fx.env, &usdc).mint(&payer, &1_000);

    fx.client.add_supported_asset(&usdc, &RATE_SCALE);
    assert_eq!(
        fx.client.make_asset_payment(&meter, &payer, &usdc, &100),
        100
    );
    fx.client.set_asset_rate(&usdc, &(RATE_SCALE * 3));
    assert_eq!(
        fx.client.make_asset_payment(&meter, &payer, &usdc, &100),
        300
    );
    assert_eq!(fx.client.get_asset_payment_balance(&meter), 400);
    assert_eq!(
        fx.client.try_set_asset_rate(&usdc, &0),
        Err(Ok(ContractError::InvalidConfiguration))
    );
}
