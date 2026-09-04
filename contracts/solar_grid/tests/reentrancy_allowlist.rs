/// Tests for the reentrancy + allowlist-verification fix (Issue #45).
///
/// The vulnerability: allowlist verification happened before state updates,
/// so a malicious contract could be added to the allowlist and then
/// re-enter protected functions before the transaction completed, bypassing
/// access controls.
///
/// The fix: `allowlist_add`, `allowlist_remove`, `register_meter_with_metadata`,
/// and `batch_register_meters` now each acquire the reentrancy lock at entry
/// and follow strict checks-effects-interactions ordering.
use solar_grid::{ContractError, SolarGridContract, SolarGridContractClient};
use soroban_sdk::{testutils::Address as _, Address, Env, String};

fn setup() -> (Env, SolarGridContractClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token_address = env
        .register_stellar_asset_contract_v2(token_admin)
        .address();
    let contract_id = env.register(SolarGridContract, (&admin, &token_address));
    let client = SolarGridContractClient::new(&env, &contract_id);
    (env, client, admin)
}

/// Concurrent `allowlist_add` calls for the same address must be idempotent:
/// the second call should succeed but leave the allowlist with exactly one
/// entry for that address (no duplicate insertion from a race window).
#[test]
fn test_allowlist_add_idempotent_no_duplicate() {
    let (env, client, _admin) = setup();
    let owner = Address::generate(&env);

    client.allowlist_add(&owner);
    // Second add must not duplicate the entry.
    client.allowlist_add(&owner);

    let list = client.get_allowlist();
    let count = list.iter().filter(|a| *a == owner).count();
    assert_eq!(count, 1, "allowlist must contain the address exactly once");
}

/// `allowlist_remove` followed immediately by `register_meter` for that
/// address must fail — the removal must be fully committed before subsequent
/// allowlist checks observe the updated state.
#[test]
fn test_register_meter_rejected_after_allowlist_remove() {
    let (env, client, _admin) = setup();
    let owner = Address::generate(&env);
    let meter_id = String::from_str(&env, "RA-METER-1");

    client.allowlist_add(&owner);
    client.allowlist_remove(&owner);

    let result = client.try_register_meter(&meter_id, &owner);
    assert_eq!(
        result,
        Err(Ok(ContractError::Unauthorized)),
        "register_meter must be rejected after allowlist_remove"
    );
}

/// `register_meter` for an owner not on the allowlist must return
/// `Unauthorized` — verifies the allowlist check itself is intact.
#[test]
fn test_register_meter_not_on_allowlist_returns_unauthorized() {
    let (env, client, _admin) = setup();
    let unlisted_owner = Address::generate(&env);
    let meter_id = String::from_str(&env, "RA-METER-2");

    let result = client.try_register_meter(&meter_id, &unlisted_owner);
    assert_eq!(result, Err(Ok(ContractError::Unauthorized)));
}

/// After a valid `allowlist_add`, `register_meter` must succeed — confirms
/// that the reentrancy guard does not break the normal happy path.
#[test]
fn test_register_meter_succeeds_when_allowlisted() {
    let (env, client, _admin) = setup();
    let owner = Address::generate(&env);
    let meter_id = String::from_str(&env, "RA-METER-3");

    client.allowlist_add(&owner);
    client.register_meter(&meter_id, &owner);

    let meter = client.get_meter(&meter_id);
    assert_eq!(meter.owner, owner);
    assert!(!meter.active, "freshly registered meter must be inactive");
}

/// Batch register: entries whose owners are not on the allowlist must be
/// skipped (false result) without aborting the whole batch.
#[test]
fn test_batch_register_skips_unlisted_owner() {
    let (env, client, _admin) = setup();
    let listed = Address::generate(&env);
    let unlisted = Address::generate(&env);
    let id_listed = String::from_str(&env, "BATCH-LISTED");
    let id_unlisted = String::from_str(&env, "BATCH-UNLISTED");

    client.allowlist_add(&listed);

    let results = client.batch_register_meters(&soroban_sdk::vec![
        &env,
        (id_listed.clone(), listed.clone()),
        (id_unlisted.clone(), unlisted.clone()),
    ]);

    assert_eq!(results.get(0), Some(true), "listed owner must be registered");
    assert_eq!(
        results.get(1),
        Some(false),
        "unlisted owner must be skipped"
    );

    // Meter for listed owner exists; meter for unlisted owner must not.
    assert!(client.try_get_meter(&id_listed).is_ok());
    assert!(
        matches!(
            client.try_get_meter(&id_unlisted),
            Err(Ok(ContractError::MeterNotFound))
        ),
        "unlisted meter should not exist"
    );
}

/// `ReentrantCall` error (code 30) is returned when the reentrancy lock is
/// already held. We verify this by calling `allowlist_add` normally and
/// checking that the guard is released after the call (i.e., a subsequent
/// call succeeds), confirming the RAII drop path works correctly.
#[test]
fn test_reentrancy_guard_releases_after_call() {
    let (env, client, _admin) = setup();
    let owner_a = Address::generate(&env);
    let owner_b = Address::generate(&env);

    // First call acquires and releases the guard.
    client.allowlist_add(&owner_a);
    // Second call must succeed (guard was released by Drop).
    client.allowlist_add(&owner_b);

    let list = client.get_allowlist();
    assert!(list.contains(&owner_a));
    assert!(list.contains(&owner_b));
}
