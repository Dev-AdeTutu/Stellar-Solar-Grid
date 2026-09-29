//! Resource ("gas") regression tests (Issue #874).
//!
//! Soroban charges fees for CPU instructions, ledger entry reads/writes and
//! event size, and rejects transactions that exceed the network limits. These
//! tests pin an upper bound for the hot paths so an accidental extra storage
//! write or unbounded loop fails CI instead of surfacing on mainnet.
//!
//! The ceilings leave roughly 2x headroom over the measured native-execution
//! cost. They are regression guards, not fee quotes: Wasm VM overhead is not
//! included when contracts are registered natively. If a change legitimately
//! needs more, raise the ceiling in the same PR and explain why.
mod common;

use common::Fixture;
use solar_grid::PaymentPlan;
use soroban_sdk::{testutils::Address as _, vec, Address, String, Vec};

struct Ceiling {
    instructions: i64,
    write_entries: u32,
}

fn assert_within(fx: &Fixture, op: &str, ceiling: Ceiling) {
    let used = fx.env.cost_estimate().resources();
    assert!(
        used.instructions <= ceiling.instructions,
        "{op}: {} instructions exceeds ceiling {}",
        used.instructions,
        ceiling.instructions
    );
    assert!(
        used.write_entries <= ceiling.write_entries,
        "{op}: {} ledger writes exceeds ceiling {}",
        used.write_entries,
        ceiling.write_entries
    );
}

#[test]
fn register_meter_cost() {
    let fx = Fixture::new();
    let owner = Address::generate(&fx.env);
    fx.client.allowlist_add(&owner);
    fx.client.register_meter(&fx.id("B_REG"), &owner);
    assert_within(
        &fx,
        "register_meter",
        Ceiling {
            instructions: 350_000,
            write_entries: 5,
        },
    );
}

#[test]
fn make_payment_cost() {
    let fx = Fixture::new();
    let (meter, owner) = fx.register("B_PAY");
    fx.mint(&owner, 1_000);
    fx.client
        .make_payment(&meter, &owner, &1_000, &PaymentPlan::Daily, &None);
    assert_within(
        &fx,
        "make_payment",
        Ceiling {
            instructions: 850_000,
            write_entries: 8,
        },
    );
}

#[test]
fn update_usage_cost() {
    let fx = Fixture::new();
    fx.oracle();
    let (meter, _) = fx.register_and_fund("B_USE", 10_000, PaymentPlan::UsageBased);
    fx.client.update_usage(&meter, &10, &100);
    assert_within(
        &fx,
        "update_usage",
        Ceiling {
            instructions: 400_000,
            write_entries: 3,
        },
    );
}

#[test]
fn check_access_is_read_only() {
    let fx = Fixture::new();
    let (meter, _) = fx.register_and_fund("B_ACC", 10, PaymentPlan::Daily);
    fx.client.check_access(&meter);
    let used = fx.env.cost_estimate().resources();
    assert_eq!(
        used.write_entries, 0,
        "check_access must not write ledger entries"
    );
}

/// Largest usage batch the backend should submit in one transaction. Each
/// update writes the meter and its balance (2 entries), so the network's
/// 50-entry write limit caps a batch at ~24 meters — far below the
/// contract's own 200-entry `BatchTooLarge` cap.
const SAFE_USAGE_BATCH: u32 = 20;

#[test]
fn usage_batch_fits_mainnet_limits() {
    let fx = Fixture::new();
    fx.oracle();
    let mut updates: Vec<(String, u64, i128)> = vec![&fx.env];
    for i in 0..SAFE_USAGE_BATCH {
        let (meter, _) = fx.register_and_fund(&format!("B{i:03}"), 10_000, PaymentPlan::UsageBased);
        updates.push_back((meter, 1, 10));
    }
    // Mainnet limits are enforced by default in the test environment, so this
    // call itself fails if the batch would be rejected on the network.
    let failed = fx.client.batch_update_usage(&updates);
    assert_eq!(failed.len(), 0);
    let used = fx.env.cost_estimate().resources();
    assert!(
        used.write_entries <= 2 * SAFE_USAGE_BATCH + 2,
        "{} writes",
        used.write_entries
    );
}

#[test]
fn fee_estimate_for_repeat_payment_is_bounded() {
    let fx = Fixture::new();
    let (meter, owner) = fx.register("B_FEE");
    fx.mint(&owner, 2_000);
    // The first payment creates the balance/payer entries and pays their
    // initial rent; measure the steady-state cost of a top-up instead.
    fx.client
        .make_payment(&meter, &owner, &1_000, &PaymentPlan::Weekly, &None);
    fx.client
        .make_payment(&meter, &owner, &1_000, &PaymentPlan::Weekly, &None);
    let fee = fx.env.cost_estimate().fee();
    // 1 XLM = 10_000_000 stroops; a repeat top-up should stay under 0.2 XLM.
    assert!(
        fee.total < 2_000_000,
        "estimated fee {} stroops: {:?}",
        fee.total,
        fee
    );
}
