#![cfg(test)]
use soroban_sdk::{testutils::Address as _, Address, Env, String};
use stellar_solar_bridge::{
    CrossChainBridgeContract, CrossChainBridgeContractClient, TargetChain,
};

#[test]
fn test_cross_chain_wrap_unwrap_unified_balance_and_payment() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, CrossChainBridgeContract);
    let client = CrossChainBridgeContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let user = Address::generate(&env);

    client.initialize(&admin);

    // Wrap 500 SOLAR to Ethereum and 300 SOLAR to Polygon
    let receipt_eth = client.wrap_to_chain(
        &user,
        &TargetChain::Ethereum,
        &String::from_str(&env, "0x71C...89A"),
        &500,
    );
    assert_eq!(receipt_eth.amount, 500);
    assert!(receipt_eth.is_wrapped);

    client.wrap_to_chain(
        &user,
        &TargetChain::Polygon,
        &String::from_str(&env, "0x71C...89A"),
        &300,
    );

    // Verify unified balance across Stellar (1000) + Ethereum (500) + Polygon (300) = 1800
    let unified = client.unified_balance(&user, &1000);
    assert_eq!(unified, 1800);

    // Unwrap 200 wSOLAR from Ethereum back to Stellar
    let unwrapped = client.unwrap_from_chain(&user, &TargetChain::Ethereum, &101, &200);
    assert_eq!(unwrapped, 200);
    assert_eq!(client.unified_balance(&user, &1200), 1800);

    // Execute a cross-chain meter payment from Polygon
    let payment_receipt = client.cross_chain_payment(
        &user,
        &TargetChain::Polygon,
        &String::from_str(&env, "MTR-SOLAR-900"),
        &125,
    );
    assert_eq!(payment_receipt.amount, 125);
}
