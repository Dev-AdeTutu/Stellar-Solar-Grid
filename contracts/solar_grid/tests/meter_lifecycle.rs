//! Meter registration, metadata, access, deactivation and schema migration
//! (Issue #874).
mod common;

use common::Fixture;
use solar_grid::{
    ContractError, DataKey, LegacyMeter, LegacyMeterV1, LegacyMeterV2, LegacyMeterV5, PaymentPlan,
};
use soroban_sdk::{testutils::Address as _, vec, Address, Map, String};

fn metadata(fx: &Fixture, pairs: &[(&str, &str)]) -> Map<String, String> {
    let mut m = Map::new(&fx.env);
    for (k, v) in pairs {
        m.set(fx.id(k), fx.id(v));
    }
    m
}

#[test]
fn register_with_metadata_round_trips() {
    let fx = Fixture::new();
    let owner = Address::generate(&fx.env);
    fx.client.allowlist_add(&owner);
    let meter = fx.id("MD1");
    let md = metadata(&fx, &[("site", "Lagos"), ("panel", "400W")]);
    fx.client
        .register_meter_with_metadata(&meter, &owner, &Some(md.clone()));
    assert_eq!(fx.client.get_meter_metadata(&meter), md);

    let updated = metadata(&fx, &[("site", "Abuja")]);
    fx.client.update_meter_metadata(&meter, &updated);
    assert_eq!(fx.client.get_meter_metadata(&meter), updated);
}

#[test]
fn metadata_limits_are_enforced() {
    let fx = Fixture::new();
    let (meter, _) = fx.register("MD2");
    let mut too_many = Map::new(&fx.env);
    for i in 0..11u32 {
        let key = String::from_str(&fx.env, &alloc_key(i));
        too_many.set(key, fx.id("v"));
    }
    assert_eq!(
        fx.client.try_update_meter_metadata(&meter, &too_many),
        Err(Ok(ContractError::InvalidMetadata))
    );
    let long_value = "x".repeat(101);
    let too_long = metadata(&fx, &[("k", &long_value)]);
    assert_eq!(
        fx.client.try_update_meter_metadata(&meter, &too_long),
        Err(Ok(ContractError::InvalidMetadata))
    );
    assert_eq!(fx.client.get_meter_metadata(&meter).len(), 0);
}

fn alloc_key(i: u32) -> std::string::String {
    format!("key{i}")
}

#[test]
fn deregister_removes_meter_from_every_index() {
    let fx = Fixture::new();
    let (m1, owner) = fx.register("DR1");
    let m2 = fx.id("DR2");
    fx.client.register_meter(&m2, &owner);
    assert_eq!(fx.client.get_meter_count(), 2);

    fx.client.deregister_meter(&m1);
    assert_eq!(fx.client.get_meter_count(), 1);
    assert_eq!(
        fx.client.get_meters_by_owner(&owner),
        vec![&fx.env, m2.clone()]
    );
    assert_eq!(
        fx.client.get_all_meters_paginated(&0, &10),
        vec![&fx.env, m2]
    );
    assert_eq!(
        fx.client.try_get_meter(&m1).err(),
        Some(Ok(ContractError::MeterNotFound))
    );
    assert_eq!(
        fx.client.try_deregister_meter(&m1),
        Err(Ok(ContractError::MeterNotFound))
    );
}

#[test]
fn access_status_reports_grace_period() {
    let fx = Fixture::new();
    fx.set_time(10_000);
    fx.oracle();
    fx.client.set_grace_period(&600);
    let (meter, _) = fx.register_and_fund("GRACE", 1_000, PaymentPlan::UsageBased);

    fx.client.update_usage(&meter, &1, &1_000);
    let status = fx.client.check_access_status(&meter);
    assert!(status.has_access);
    assert!(status.in_grace_period);
    assert_eq!(status.grace_expires_at, Some(10_600));

    fx.advance(600);
    let status = fx.client.check_access_status(&meter);
    assert!(!status.has_access);
    assert!(!status.in_grace_period);

    // The next usage report after the grace window deactivates the meter.
    fx.client.update_usage(&meter, &1, &0);
    assert!(!fx.client.get_meter(&meter).active);
}

#[test]
fn topping_up_clears_grace_period() {
    let fx = Fixture::new();
    fx.oracle();
    fx.client.set_grace_period(&600);
    let (meter, owner) = fx.register_and_fund("GRACE2", 100, PaymentPlan::UsageBased);
    fx.client.update_usage(&meter, &1, &100);
    assert!(fx.client.check_access_status(&meter).in_grace_period);

    fx.mint(&owner, 50);
    fx.client
        .make_payment(&meter, &owner, &50, &PaymentPlan::UsageBased, &None);
    let status = fx.client.check_access_status(&meter);
    assert!(status.has_access);
    assert!(!status.in_grace_period);
}

#[test]
fn meter_full_view_and_emergency_contact() {
    let fx = Fixture::new();
    let (meter, _) = fx.register_and_fund("FULL", 777, PaymentPlan::Weekly);
    let view = fx.client.get_meter_full(&meter);
    assert_eq!(view.balance, 777);
    assert!(view.meter.active);

    assert_eq!(fx.client.get_emergency_contact(&meter), None);
    let contact = Address::generate(&fx.env);
    fx.client
        .set_emergency_contact(&meter, &Some(contact.clone()));
    assert_eq!(fx.client.get_emergency_contact(&meter), Some(contact));
    fx.client.set_emergency_contact(&meter, &None);
    assert_eq!(fx.client.get_emergency_contact(&meter), None);
}

#[test]
fn set_meter_active_requires_balance_to_activate() {
    let fx = Fixture::new();
    let (meter, _) = fx.register("ACT");
    assert_eq!(
        fx.client.try_set_meter_active(&meter, &true),
        Err(Ok(ContractError::CannotActivateWithoutBalance))
    );
    let (funded, _) = fx.register_and_fund("ACT2", 10, PaymentPlan::Daily);
    fx.client.set_meter_active(&funded, &false);
    assert!(!fx.client.get_meter(&funded).active);
    fx.client.set_meter_active(&funded, &true);
    assert!(fx.client.get_meter(&funded).active);
}

#[test]
fn batch_deactivate_reports_per_meter_outcome() {
    let fx = Fixture::new();
    let (active, _) = fx.register_and_fund("BD_A", 10, PaymentPlan::Daily);
    let (inactive, _) = fx.register("BD_I");
    let missing = fx.id("BD_X");

    let summary =
        fx.client
            .batch_deactivate_meters(&vec![&fx.env, active.clone(), inactive, missing]);
    assert_eq!(summary.total, 3);
    assert_eq!(summary.deactivated, 1);
    assert_eq!(summary.skipped, 2);
    assert_eq!(summary.results.get(0).unwrap().reason, fx.id("ok"));
    assert_eq!(summary.results.get(1).unwrap().reason, fx.id("inactive"));
    assert_eq!(summary.results.get(2).unwrap().reason, fx.id("not_found"));
    assert!(!fx.client.get_meter(&active).active);

    // The alias behaves identically.
    let again = fx.client.batch_deactivate(&vec![&fx.env, active]);
    assert_eq!(again.deactivated, 0);
}

#[test]
fn batch_deactivate_caps_batch_size() {
    let fx = Fixture::new();
    let mut ids = vec![&fx.env];
    for _ in 0..51 {
        ids.push_back(fx.id("X"));
    }
    assert_eq!(
        fx.client.try_batch_deactivate_meters(&ids).err(),
        Some(Ok(ContractError::BatchTooLarge))
    );
}

#[test]
fn installation_date_is_admin_set_and_not_in_future() {
    let fx = Fixture::new();
    fx.set_time(5_000);
    let (meter, _) = fx.register("INST");
    assert_eq!(fx.client.get_installed_at(&meter), 5_000);
    fx.client.set_installation_date(&meter, &1_234);
    assert_eq!(fx.client.get_installed_at(&meter), 1_234);
    assert_eq!(
        fx.client.try_set_installation_date(&meter, &5_001),
        Err(Ok(ContractError::InvalidInstallationDate))
    );
}

#[test]
fn ownership_transfer_updates_indexes_and_history() {
    let fx = Fixture::new();
    let (meter, old_owner) = fx.register_and_fund("XFER", 500, PaymentPlan::Daily);
    let new_owner = Address::generate(&fx.env);
    assert_eq!(
        fx.client.try_transfer_meter(&meter, &new_owner),
        Err(Ok(ContractError::OwnerNotAllowlisted))
    );
    fx.client.allowlist_add(&new_owner);
    fx.client.transfer_meter(&meter, &new_owner);

    assert_eq!(fx.client.get_meter(&meter).owner, new_owner);
    assert_eq!(fx.client.get_meters_by_owner(&old_owner).len(), 0);
    assert_eq!(
        fx.client.get_meters_by_owner(&new_owner),
        vec![&fx.env, meter.clone()]
    );
    // The prepaid balance travels with the meter.
    assert_eq!(fx.client.get_meter_balance(&meter), 500);
}

// ── Schema migration ─────────────────────────────────────────────────────────

fn write_raw<V: soroban_sdk::IntoVal<soroban_sdk::Env, soroban_sdk::Val>>(
    fx: &Fixture,
    meter: &String,
    value: &V,
) {
    fx.env.as_contract(&fx.client.address, || {
        fx.env
            .storage()
            .persistent()
            .set(&DataKey::Meter(meter.clone()), value);
    });
}

#[test]
fn legacy_v1_meter_is_migrated_on_read() {
    let fx = Fixture::new();
    let meter = fx.id("V1");
    let owner = Address::generate(&fx.env);
    write_raw(
        &fx,
        &meter,
        &LegacyMeterV1 {
            version: 1,
            owner: owner.clone(),
            active: true,
            units_used: 9,
            plan: PaymentPlan::Weekly,
            last_payment: 77,
            expires_at: 999,
        },
    );
    fx.client.migrate_meter_to_v2(&meter);
    let m = fx.client.get_meter(&meter);
    assert_eq!(
        (m.version, m.owner, m.units_used, m.expires_at),
        (6, owner, 9, 999)
    );
    assert_eq!(m.installed_at, 77);
    assert_eq!(m.daily_limit, 0);
}

#[test]
fn legacy_v2_meter_keeps_daily_limit() {
    let fx = Fixture::new();
    let meter = fx.id("V2");
    write_raw(
        &fx,
        &meter,
        &LegacyMeterV2 {
            version: 2,
            owner: Address::generate(&fx.env),
            active: false,
            units_used: 0,
            plan: PaymentPlan::Daily,
            last_payment: 5,
            expires_at: 5,
            daily_limit: 321,
            day_spent: 12,
            day_start: 5,
            grace_expires_at: None,
        },
    );
    fx.client.migrate_meter_to_v3(&meter);
    let m = fx.client.get_meter(&meter);
    assert_eq!((m.version, m.daily_limit, m.day_spent), (6, 321, 12));
    assert!(m.auto_deactivate);
}

#[test]
fn legacy_v5_meter_gets_installation_date() {
    let fx = Fixture::new();
    let meter = fx.id("V5");
    let contact = Address::generate(&fx.env);
    write_raw(
        &fx,
        &meter,
        &LegacyMeterV5 {
            version: 5,
            owner: Address::generate(&fx.env),
            active: true,
            units_used: 1,
            plan: PaymentPlan::Monthly,
            last_payment: 4_242,
            expires_at: 9_000,
            daily_limit: 0,
            day_spent: 0,
            day_start: 0,
            grace_expires_at: None,
            emergency_contact: Some(contact.clone()),
            auto_deactivate: false,
        },
    );
    fx.client.migrate_meter_v5(&meter);
    let m = fx.client.get_meter(&meter);
    assert_eq!(m.version, 6);
    assert_eq!(m.installed_at, 4_242);
    assert_eq!(m.emergency_contact, Some(contact));
    assert!(!m.auto_deactivate);
}

#[test]
fn legacy_v0_meter_migrates_through_any_read_path() {
    let fx = Fixture::new();
    let meter = fx.id("V0");
    write_raw(
        &fx,
        &meter,
        &LegacyMeter {
            owner: Address::generate(&fx.env),
            active: true,
            balance: 50,
            units_used: 3,
            plan: PaymentPlan::UsageBased,
            last_payment: 10,
            expires_at: u64::MAX,
        },
    );
    // A plain read migrates and persists the entry.
    assert!(fx.client.check_access_status(&meter).has_access == false);
    assert_eq!(fx.client.get_meter(&meter).version, 6);
    // And the admin entry point is then a no-op.
    fx.client.migrate_meter(&meter);
    assert_eq!(fx.client.get_meter(&meter).units_used, 3);
}

#[test]
fn migrate_unknown_meter_returns_not_found() {
    let fx = Fixture::new();
    let meter = fx.id("NONE");
    assert_eq!(
        fx.client.try_migrate_meter(&meter),
        Err(Ok(ContractError::MeterNotFound))
    );
    assert_eq!(
        fx.client.try_migrate_meter_v5(&meter),
        Err(Ok(ContractError::MeterNotFound))
    );
}
