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

// ── Time-weighted voting (#1056) ────────────────────────────────────────────

const YEAR: u64 = 365 * 24 * 3600;

fn setup_tw(env: &Env) -> (GovernanceDaoContractClient<'_>, Address) {
    env.mock_all_auths();
    let contract_id = env.register_contract(None, GovernanceDaoContract);
    let client = GovernanceDaoContractClient::new(env, &contract_id);
    let founder = Address::generate(env);
    client.initialize(&founder, &1000, &3600, &1800, &10);
    (client, founder)
}

#[test]
fn test_voting_power_grows_with_hold_duration() {
    let env = Env::default();
    env.ledger().with_mut(|l| l.timestamp = 1_000);
    let (client, _) = setup_tw(&env);
    let holder = Address::generate(&env);
    client.mint_governance_tokens(&holder, &100);

    assert_eq!(client.voting_power(&holder), 100);
    env.ledger().with_mut(|l| l.timestamp = 1_000 + YEAR / 2);
    assert_eq!(client.voting_power(&holder), 150);
    env.ledger().with_mut(|l| l.timestamp = 1_000 + 5 * YEAR);
    assert_eq!(client.voting_power(&holder), 200); // capped at +100%
}

#[test]
fn test_top_up_dilutes_hold_age() {
    let env = Env::default();
    env.ledger().with_mut(|l| l.timestamp = 1_000);
    let (client, _) = setup_tw(&env);
    let holder = Address::generate(&env);
    client.mint_governance_tokens(&holder, &100);
    env.ledger().with_mut(|l| l.timestamp = 1_000 + YEAR);
    client.mint_governance_tokens(&holder, &100);
    // Average age is half a year → +50% on 200 tokens.
    assert_eq!(client.voting_power(&holder), 300);
}

#[test]
fn test_lock_grants_boost() {
    let env = Env::default();
    env.ledger().with_mut(|l| l.timestamp = 1_000);
    let (client, _) = setup_tw(&env);
    let holder = Address::generate(&env);
    client.mint_governance_tokens(&holder, &100);
    client.lock_tokens(&holder, &100, &(4 * YEAR));
    assert_eq!(client.voting_power(&holder), 200);
    // Expired lock no longer boosts (hold bonus is capped at +100%).
    env.ledger().with_mut(|l| l.timestamp = 1_000 + 4 * YEAR + 1);
    assert_eq!(client.voting_power(&holder), 200);
}

#[test]
#[should_panic(expected = "Cannot shorten lock")]
fn test_lock_cannot_be_shortened() {
    let env = Env::default();
    let (client, _) = setup_tw(&env);
    let holder = Address::generate(&env);
    client.mint_governance_tokens(&holder, &100);
    client.lock_tokens(&holder, &100, &YEAR);
    client.lock_tokens(&holder, &100, &(YEAR / 2));
}

#[test]
fn test_time_weighted_vote_counts_boost() {
    let env = Env::default();
    env.ledger().with_mut(|l| l.timestamp = 1_000);
    let (client, founder) = setup_tw(&env);
    let veteran = Address::generate(&env);
    client.mint_governance_tokens(&veteran, &100);
    env.ledger().with_mut(|l| l.timestamp = 1_000 + YEAR);

    let id = client.create_proposal(
        &founder,
        &String::from_str(&env, "TW"),
        &String::from_str(&env, "time weighted"),
        &symbol_short!("fee"),
        &5,
        &None,
        &0,
        &VotingMode::TimeWeighted,
    );
    client.cast_vote(&id, &veteran, &true, &100);
    assert_eq!(client.get_proposal(&id).votes_for, 200);
}

#[test]
#[should_panic(expected = "Tokens acquired after proposal creation cannot vote")]
fn test_sybil_fresh_tokens_rejected() {
    let env = Env::default();
    env.ledger().with_mut(|l| l.timestamp = 1_000);
    let (client, founder) = setup_tw(&env);
    let id = client.create_proposal(
        &founder,
        &String::from_str(&env, "TW"),
        &String::from_str(&env, "time weighted"),
        &symbol_short!("fee"),
        &5,
        &None,
        &0,
        &VotingMode::TimeWeighted,
    );
    env.ledger().with_mut(|l| l.timestamp = 1_010);
    let sybil = Address::generate(&env);
    client.mint_governance_tokens(&sybil, &50);
    client.cast_vote(&id, &sybil, &true, &50);
}
