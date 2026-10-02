//! Shared fixtures for the solar_grid integration test suites (Issue #874).
#![allow(dead_code)]

use solar_grid::{PaymentPlan, SolarGridContract, SolarGridContractClient};
use soroban_sdk::{testutils::Address as _, token, Address, Env, String};

/// A freshly deployed contract wired to a Stellar Asset Contract payment token.
pub struct Fixture {
    pub env: Env,
    pub client: SolarGridContractClient<'static>,
    pub contract_id: Address,
    pub admin: Address,
    pub token: Address,
}

impl Fixture {
    /// Deploy through the constructor with every authorization mocked.
    pub fn new() -> Self {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(Address::generate(&env))
            .address();
        let contract_id = env.register(SolarGridContract, (&admin, &token));
        let client = SolarGridContractClient::new(&env, &contract_id);
        Self {
            env,
            client,
            contract_id,
            admin,
            token,
        }
    }

    pub fn id(&self, s: &str) -> String {
        String::from_str(&self.env, s)
    }

    pub fn token_client(&self) -> token::Client<'static> {
        token::Client::new(&self.env, &self.token)
    }

    pub fn mint(&self, to: &Address, amount: i128) {
        token::StellarAssetClient::new(&self.env, &self.token).mint(to, &amount);
    }

    /// Register a new oracle address and return it.
    pub fn oracle(&self) -> Address {
        let oracle = Address::generate(&self.env);
        self.client.set_oracle(&oracle);
        oracle
    }

    /// Allowlist a fresh owner and register `meter_id` for them.
    pub fn register(&self, meter_id: &str) -> (String, Address) {
        let owner = Address::generate(&self.env);
        let id = self.id(meter_id);
        self.client.allowlist_add(&owner);
        self.client.register_meter(&id, &owner);
        (id, owner)
    }

    /// Register `meter_id`, mint `amount` to the owner and pay it in.
    pub fn register_and_fund(
        &self,
        meter_id: &str,
        amount: i128,
        plan: PaymentPlan,
    ) -> (String, Address) {
        let (id, owner) = self.register(meter_id);
        self.mint(&owner, amount);
        self.client.make_payment(&id, &owner, &amount, &plan, &None);
        (id, owner)
    }

    pub fn set_time(&self, timestamp: u64) {
        use soroban_sdk::testutils::Ledger;
        self.env.ledger().with_mut(|li| li.timestamp = timestamp);
    }

    pub fn advance(&self, secs: u64) {
        use soroban_sdk::testutils::Ledger;
        self.env.ledger().with_mut(|li| li.timestamp += secs);
    }
}
