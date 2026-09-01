use solar_grid::{ContractError, PaymentPlan, SolarGridContract, SolarGridContractClient};
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token, Address, Env, String,
};

fn setup() -> (Env, SolarGridContractClient<'static>, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token_address = env
        .register_stellar_asset_contract_v2(token_admin)
        .address();
    let contract_id = env.register(SolarGridContract, (&admin, &token_address));
    let client = SolarGridContractClient::new(&env, &contract_id);
    (env, client, admin, token_address)
}

#[test]
fn pause_blocks_payment_and_registration_but_allows_usage_updates() {
    let (env, client, _admin, token_address) = setup();
    let token_admin = token::StellarAssetClient::new(&env, &token_address);
    let oracle = Address::generate(&env);
    client.set_oracle(&oracle);

    let owner = Address::generate(&env);
    let meter_id = String::from_str(&env, "PAUSE_MAIN");
    client.allowlist_add(&owner);
    client.register_meter(&meter_id, &owner);
    token_admin.mint(&owner, &2_000_i128);
    client.make_payment(&meter_id, &owner, &1_000_i128, &PaymentPlan::Daily, &None);

    client.pause();
    assert!(client.is_paused());

    assert_eq!(
        client.try_make_payment(&meter_id, &owner, &100_i128, &PaymentPlan::Daily, &None),
        Err(Ok(ContractError::ContractPaused))
    );

    let new_meter_id = String::from_str(&env, "PAUSE_REGISTER");
    assert_eq!(
        client.try_register_meter(&new_meter_id, &owner),
        Err(Ok(ContractError::ContractPaused))
    );

    client.update_usage(&meter_id, &1_u64, &10_i128);
    assert_eq!(client.get_meter_balance(&meter_id), 990_i128);
}

#[test]
fn pause_expires_at_48_hours_and_allows_payments_again() {
    let (env, client, _admin, token_address) = setup();
    let token_admin = token::StellarAssetClient::new(&env, &token_address);
    let owner = Address::generate(&env);
    let meter_id = String::from_str(&env, "PAUSE_EXPIRY");
    client.allowlist_add(&owner);
    client.register_meter(&meter_id, &owner);
    token_admin.mint(&owner, &1_000_i128);

    env.ledger().with_mut(|li| li.timestamp = 10);
    client.pause();
    assert!(client.is_paused());

    env.ledger().with_mut(|li| li.timestamp = 10 + 48 * 60 * 60);
    assert!(!client.is_paused());

    // The automatic expiry is equivalent to an explicit unpause.
    client.make_payment(&meter_id, &owner, &1_000_i128, &PaymentPlan::Daily, &None);
}
