#![cfg(test)]
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Ledger},
    Address, Env, String,
};
use stellar_solar_dao::{GovernanceDaoContract, GovernanceDaoContractClient, ProposalStatus, VotingMode};

#[test]
fn test_dao_lifecycle_quadratic_voting_timelock_and_treasury() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, GovernanceDaoContract);
    let client = GovernanceDaoContractClient::new(&env, &contract_id);

    let founder = Address::generate(&env);
    let voter_b = Address::generate(&env);
    let recipient = Address::generate(&env);

    client.initialize(&founder, &1000, &3600, &1800, &10);
    client.mint_governance_tokens(&voter_b, &100);
    client.deposit_treasury(&founder, &5000);

    assert_eq!(client.token_balance(&voter_b), 100);
    assert_eq!(client.treasury_balance(), 5000);

    let prop_id = client.create_proposal(
        &founder,
        &String::from_str(&env, "Upgrade Feed-In Tariff"),
        &String::from_str(&env, "Increase solar grid tariff parameter to 150 and fund grant"),
        &symbol_short!("TARIFF"),
        &150,
        &Some(recipient.clone()),
        &1200,
        &VotingMode::Quadratic,
    );

    // Quadratic voting: 100 tokens -> 10 voting weight
    client.cast_vote(&prop_id, &voter_b, &true, &100);
    // Founder casts 400 tokens -> 20 voting weight
    client.cast_vote(&prop_id, &founder, &true, &400);

    let prop = client.get_proposal(&prop_id);
    assert_eq!(prop.votes_for, 30);

    // Advance past voting period
    env.ledger().with_mut(|li| {
        li.timestamp += 3601;
    });

    let status = client.queue_proposal(&prop_id);
    assert_eq!(status, ProposalStatus::Queued);

    // Advance past timelock delay
    env.ledger().with_mut(|li| {
        li.timestamp += 1801;
    });

    client.execute_proposal(&prop_id);

    let executed = client.get_proposal(&prop_id);
    assert_eq!(executed.status, ProposalStatus::Executed);
    assert_eq!(client.get_parameter(&symbol_short!("TARIFF")), 150);
    assert_eq!(client.treasury_balance(), 3800);
}
