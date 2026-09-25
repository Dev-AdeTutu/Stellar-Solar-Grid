//! Tests for multi-currency payments (#837) and warranty tracking (#838).

use crate::{ContractError, SolarGridContract, SolarGridContractClient, RATE_SCALE};
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token, Address, Env, Map, String,
};

fn setup() -> (Env, SolarGridContractClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register_contract(None, SolarGridContract);
    let client = SolarGridContractClient::new(&env, &id);
    let admin = Address::generate(&env);
    let tok = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    client.initialize(&admin, &tok);
    (env, client, admin)
}

#[test]
fn add_and_query_supported_assets() {
    let (env, client, _) = setup();
    let usdc = Address::generate(&env);
    let eurc = Address::generate(&env);
    client.add_supported_asset(&usdc, &RATE_SCALE);
    client.add_supported_asset(&eurc, &(RATE_SCALE * 11 / 10));
    let list = client.supported_assets();
    assert_eq!(list.len(), 2);
    assert_eq!(list.get(1).unwrap().rate, RATE_SCALE * 11 / 10);
    assert_eq!(
        client.try_add_supported_asset(&usdc, &0),
        Err(Ok(ContractError::InvalidConfiguration))
    );
    client.remove_supported_asset(&usdc);
    assert_eq!(client.supported_assets().len(), 1);
}

#[test]
fn payment_in_supported_asset_is_converted() {
    let (env, client, _) = setup();
    let eurc_admin = Address::generate(&env);
    let eurc = env.register_stellar_asset_contract_v2(eurc_admin).address();
    let payer = Address::generate(&env);
    token::StellarAssetClient::new(&env, &eurc).mint(&payer, &1_000);
    let meter = String::from_str(&env, "M1");
    client.register_meter(&meter, &payer);

    client.add_supported_asset(&eurc, &(RATE_SCALE * 2));
    let credited = client.make_asset_payment(&meter, &payer, &eurc, &100);
    assert_eq!(credited, 200);
    assert_eq!(client.get_asset_payment_balance(&meter), 200);
    assert_eq!(token::Client::new(&env, &eurc).balance(&payer), 900);
}

#[test]
fn payment_in_unsupported_asset_rejected() {
    let (env, client, _) = setup();
    let payer = Address::generate(&env);
    let meter = String::from_str(&env, "M1");
    client.register_meter(&meter, &payer);
    assert_eq!(
        client.try_make_asset_payment(&meter, &payer, &Address::generate(&env), &100),
        Err(Ok(ContractError::InvalidConfiguration))
    );
}

#[test]
fn warranty_validation_and_expiry_query() {
    let (env, client, _) = setup();
    env.ledger().set_timestamp(1_000);
    let owner = Address::generate(&env);
    let m1 = String::from_str(&env, "M1");
    let m2 = String::from_str(&env, "M2");
    client.register_meter(&m1, &owner);
    client.register_meter(&m2, &owner);

    let mut bad = Map::new(&env);
    bad.set(String::from_str(&env, "warranty_expires_at"), String::from_str(&env, "2027-01-01"));
    assert_eq!(
        client.try_update_meter_metadata(&m1, &bad),
        Err(Ok(ContractError::InvalidMetadata))
    );

    let mut soon = Map::new(&env);
    soon.set(String::from_str(&env, "warranty_expires_at"), String::from_str(&env, "5000"));
    soon.set(String::from_str(&env, "warranty_provider"), String::from_str(&env, "SunCo"));
    soon.set(String::from_str(&env, "warranty_terms"), String::from_str(&env, "2y parts"));
    client.update_meter_metadata(&m1, &soon);

    let mut later = Map::new(&env);
    later.set(String::from_str(&env, "warranty_expires_at"), String::from_str(&env, "999999"));
    client.update_meter_metadata(&m2, &later);

    assert_eq!(client.get_warranty_expiry(&m1), Some(5000));
    let expiring = client.get_meters_with_expiring_warranty(&10_000);
    assert_eq!(expiring.len(), 1);
    assert_eq!(expiring.get(0).unwrap(), m1);
}
