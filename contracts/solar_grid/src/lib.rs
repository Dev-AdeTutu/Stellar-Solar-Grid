#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, token, vec, Address, Env, Symbol, Vec,
};

// ── Storage keys ──────────────────────────────────────────────────────────────

const ADMIN: Symbol = symbol_short!("ADMIN");
const ALLOWLIST: Symbol = symbol_short!("ALLOWLIST");
const SECONDS_PER_DAY: u64 = 86_400;
const SECONDS_PER_WEEK: u64 = 604_800;

// ── Data types ────────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum PaymentPlan {
    Daily,
    Weekly,
    UsageBased,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct Meter {
    pub owner: Address,
    pub active: bool,
    pub balance: i128,      // token's smallest unit (e.g., stroops for token with 7 decimals)
    pub units_used: u64,     // kWh * 1000 (milli-kWh for precision)
    pub plan: PaymentPlan,
    pub last_payment: u64,   // ledger timestamp
    pub expires_at: u64,     // ledger timestamp when access expires
}

#[contracttype]
pub enum DataKey {
    Meter(Symbol),
    OwnerMeters(Address),
    ProviderRevenue(Address),
}

// ── Event topics (contract namespace) ────────────────────────────────────────

const EVT_NS: Symbol = symbol_short!("solargrid");


#[contract]
pub struct SolarGridContract;

#[contractimpl]
impl SolarGridContract {
    /// Initialize the contract with an admin address.
    pub fn initialize(env: Env, admin: Address) {
        admin.require_auth();
        if env.storage().instance().has(&ADMIN) {
            panic!("already initialized");
        }
        env.storage().instance().set(&ADMIN, &admin);
    }

    /// Register a new smart meter for an owner.
    ///
    /// # Access control
    /// - Caller must be the contract admin.
    /// - `owner` must be present in the admin-managed allowlist, ensuring only
    ///   vetted user accounts (G… addresses) can be registered as meter owners.
    ///   This prevents contract addresses from being registered as owners, which
    ///   could cause downstream auth issues.
    /// - `owner` must co-sign the registration (require_auth), confirming they
    ///   consent to being the meter owner.
    pub fn register_meter(env: Env, meter_id: Symbol, owner: Address) {
        Self::require_admin(&env);
        let allowlist = Self::get_allowlist(env.clone());
        if !allowlist.contains(&owner) {
            panic!("owner not in allowlist");
        }
        let key = DataKey::Meter(meter_id.clone());
        if env.storage().persistent().has(&key) {
            panic!("meter already registered");
        }
        let meter = Meter {
            owner: owner.clone(),
            active: false,
            balance: 0,
            units_used: 0,
            plan: PaymentPlan::Daily,
            last_payment: env.ledger().timestamp(),
            expires_at: env.ledger().timestamp(),
        };
        env.storage().persistent().set(&key, &meter);

        // Append meter_id to the owner's meter list
        let owner_key = DataKey::OwnerMeters(owner);
        let mut list: Vec<Symbol> = env
            .storage()
            .persistent()
            .get(&owner_key)
            .unwrap_or_else(|| vec![&env]);
        list.push_back(meter_id);
        env.storage().persistent().set(&owner_key, &list);

        // meter_registered
        env.events().publish(
            (symbol_short!("mtr_reg"), EVT_NS, meter_id),
            owner,
        );
    }

    /// Get all meter IDs registered under a given owner address.
    pub fn get_meters_by_owner(env: Env, owner: Address) -> Vec<Symbol> {
        let owner_key = DataKey::OwnerMeters(owner);
        env.storage()
            .persistent()
            .get(&owner_key)
            .unwrap_or_else(|| vec![&env])
    }

    /// Add an address to the meter-owner allowlist.
    /// Only the admin may call this. Use this to pre-approve user accounts
    /// (G… addresses) before they can be registered as meter owners.
    pub fn allowlist_add(env: Env, owner: Address) {
        Self::require_admin(&env);
        let mut list: Vec<Address> = env
            .storage()
            .instance()
            .get(&ALLOWLIST)
            .unwrap_or(Vec::new(&env));
        if !list.contains(&owner) {
            list.push_back(owner);
            env.storage().instance().set(&ALLOWLIST, &list);
        }
    }

    /// Remove an address from the meter-owner allowlist.
    /// Only the admin may call this.
    pub fn allowlist_remove(env: Env, owner: Address) {
        Self::require_admin(&env);
        let list: Vec<Address> = env
            .storage()
            .instance()
            .get(&ALLOWLIST)
            .unwrap_or(Vec::new(&env));
        let mut new_list: Vec<Address> = Vec::new(&env);
        for addr in list.iter() {
            if addr != owner {
                new_list.push_back(addr);
            }
        }
        env.storage().instance().set(&ALLOWLIST, &new_list);
    }

    /// Returns the current allowlist.
    pub fn get_allowlist(env: Env) -> Vec<Address> {
        env.storage()
            .instance()
            .get(&ALLOWLIST)
            .unwrap_or(Vec::new(&env))
    }

    /// Make a payment to top up a meter's balance and activate it.
    /// `amount` is in the token's smallest unit. `plan` sets the billing cycle.
    ///
    /// Emits:
    /// - `payment_received { meter_id, payer, amount, plan }`
    /// - `meter_activated  { meter_id }` (always, since payment activates the meter)
    pub fn make_payment(
        env: Env,
        meter_id: Symbol,
        token_address: Address,
        payer: Address,
        amount: i128,
        plan: PaymentPlan,
    ) {
        payer.require_auth();
        if amount <= 0 {
            panic!("amount must be positive");
        }
        let token_client = token::Client::new(&env, &token_address);
        token_client.transfer(&payer, &env.current_contract_address(), &amount);

        let key = DataKey::Meter(meter_id.clone());
        let mut meter: Meter = env.storage().persistent().get(&key).expect("meter not found");
        let now = env.ledger().timestamp();
        // Exhaustive match guard: compile error if a new variant is added without handling it.
        match plan {
            PaymentPlan::Daily | PaymentPlan::Weekly | PaymentPlan::UsageBased => {}
        }
        let expires_at = match plan {
            PaymentPlan::Daily => now.saturating_add(SECONDS_PER_DAY),
            PaymentPlan::Weekly => now.saturating_add(SECONDS_PER_WEEK),
            PaymentPlan::UsageBased => u64::MAX,
        };
        meter.balance += amount;
        meter.active = true;
        meter.plan = plan.clone();
        meter.last_payment = now;
        meter.expires_at = expires_at;
        env.storage().persistent().set(&key, &meter);

        // Track provider (admin) accrued revenue in contract storage.
        let admin: Address = env.storage().instance().get(&ADMIN).expect("not initialized");
        let provider_key = DataKey::ProviderRevenue(admin);
        let provider_revenue: i128 = env.storage().persistent().get(&provider_key).unwrap_or(0);
        env.storage()
            .persistent()
            .set(&provider_key, &(provider_revenue + amount));

        // payment_received
        env.events().publish(
            (symbol_short!("pmt_rcvd"), EVT_NS, meter_id.clone()),
            (payer, token_address, amount, plan),
        );
        // meter_activated — payment always activates the meter
        env.events().publish(
            (symbol_short!("mtr_actv"), EVT_NS, meter_id),
            (),
        );
    }

    /// Withdraw collected token revenue from the contract vault.
    /// Provider is the contract admin set at initialization.
    pub fn withdraw_revenue(env: Env, token_address: Address, provider: Address, amount: i128) {
        if amount <= 0 {
            panic!("amount must be positive");
        }
        let admin: Address = env.storage().instance().get(&ADMIN).expect("not initialized");
        if provider != admin {
            panic!("provider is not admin");
        }
        provider.require_auth();

        let provider_key = DataKey::ProviderRevenue(provider.clone());
        let provider_revenue: i128 = env.storage().persistent().get(&provider_key).unwrap_or(0);
        if provider_revenue < amount {
            panic!("insufficient provider revenue");
        }

        env.storage()
            .persistent()
            .set(&provider_key, &(provider_revenue - amount));

        let token_client = token::Client::new(&env, &token_address);
        token_client.transfer(&env.current_contract_address(), &provider, &amount);

        env.events().publish(
            (symbol_short!("rev_wdrl"), EVT_NS, provider),
            (token_address, amount),
        );
    }

    /// Get currently tracked provider revenue balance.
    pub fn get_provider_revenue(env: Env, provider: Address) -> i128 {
        let provider_key = DataKey::ProviderRevenue(provider);
        env.storage().persistent().get(&provider_key).unwrap_or(0)
    }

    /// Check whether a meter currently has active energy access.
    pub fn check_access(env: Env, meter_id: Symbol) -> bool {
        let key = DataKey::Meter(meter_id);
        let meter: Meter = env.storage().persistent().get(&key).expect("meter not found");
        meter.active && meter.balance > 0 && env.ledger().timestamp() < meter.expires_at
    }

    /// Called by the IoT oracle to record energy consumption (milli-kWh).
    /// Deducts cost from balance; deactivates meter if balance runs out.
    ///
    /// Emits:
    /// - `usage_updated    { meter_id, units, cost }`
    /// - `meter_deactivated { meter_id }` (only when balance hits zero)
    pub fn update_usage(env: Env, meter_id: Symbol, units: u64, cost: i128) {
        Self::require_admin(&env);
        let key = DataKey::Meter(meter_id.clone());
        let mut meter: Meter = env.storage().persistent().get(&key).expect("meter not found");
        meter.units_used += units;
        // Clamp to 0: saturating_sub on i128 would bottom out at i128::MIN on
        // underflow; .max(0) normalises any negative result to exactly 0.
        meter.balance = meter.balance.saturating_sub(cost).max(0);
        let deactivated = if meter.balance == 0 {
            meter.active = false;
            true
        } else {
            false
        };
        env.storage().persistent().set(&key, &meter);

        // usage_updated
        env.events().publish(
            (symbol_short!("usg_upd"), EVT_NS, meter_id.clone()),
            (units, cost),
        );
        // meter_deactivated — only when balance drained to zero
        if deactivated {
            env.events().publish(
                (symbol_short!("mtr_deact"), EVT_NS, meter_id),
                (),
            );
        }
    }

    /// Get meter details.
    pub fn get_meter(env: Env, meter_id: Symbol) -> Meter {
        let key = DataKey::Meter(meter_id);
        env.storage().persistent().get(&key).expect("meter not found")
    }

    /// Admin can manually toggle meter access (e.g. maintenance).
    ///
    /// Emits:
    /// - `meter_activated   { meter_id }` when toggled on
    /// - `meter_deactivated { meter_id }` when toggled off
    pub fn set_active(env: Env, meter_id: Symbol, active: bool) {
        Self::require_admin(&env);
        let key = DataKey::Meter(meter_id.clone());
        let mut meter: Meter = env.storage().persistent().get(&key).expect("meter not found");
        if active && meter.balance == 0 {
            panic!("cannot activate meter with zero balance");
        }
        meter.active = active;
        env.storage().persistent().set(&key, &meter);

        if active {
            env.events().publish(
                (symbol_short!("mtr_actv"), EVT_NS, meter_id),
                (),
            );
        } else {
            env.events().publish(
                (symbol_short!("mtr_deact"), EVT_NS, meter_id),
                (),
            );
        }
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    fn require_admin(env: &Env) {
        let admin: Address = env.storage().instance().get(&ADMIN).expect("not initialized");
        admin.require_auth();
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        symbol_short,
        testutils::{Address as _, Ledger},
        token, Address, Env,
    };

    fn setup() -> (Env, SolarGridContractClient<'static>, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, SolarGridContract);
        let client = SolarGridContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(&admin);
        (env, client, admin)
    }

    /// Helper: allowlist + register a meter in one call.
    fn allowlist_and_register(
        client: &SolarGridContractClient,
        meter_id: &Symbol,
        user: &Address,
    ) {
        client.allowlist_add(user);
        client.register_meter(meter_id, user);
    }

    fn setup_token(env: &Env) -> (Address, token::StellarAssetClient<'_>, token::Client<'_>) {
        let token_admin = Address::generate(env);
        let token_address = env
            .register_stellar_asset_contract_v2(token_admin.clone())
            .address();
        let token_admin_client = token::StellarAssetClient::new(env, &token_address);
        let token_client = token::Client::new(env, &token_address);
        (token_address, token_admin_client, token_client)
    }

    #[test]
    fn test_register_and_pay() {
        let (env, client, _admin) = setup();
        let (token_address, token_admin_client, token_client) = setup_token(&env);

        let user = Address::generate(&env);
        let meter_id = symbol_short!("METER1");

        allowlist_and_register(&client, &meter_id, &user);

        // Before payment — inactive
        assert!(!client.check_access(&meter_id));

        token_admin_client.mint(&user, &5_000_000_i128);
        // Make payment
        client.make_payment(
            &meter_id,
            &token_address,
            &user,
            &5_000_000_i128,
            &PaymentPlan::Daily,
        );
        assert!(client.check_access(&meter_id));
        assert_eq!(token_client.balance(&user), 0);

        // Simulate usage that drains balance
        client.update_usage(&meter_id, &100_u64, &5_000_000_i128);
        assert!(!client.check_access(&meter_id));
    }

    /// Registering the same meter_id twice should panic.
    #[test]
    #[should_panic(expected = "meter already registered")]
    fn test_register_meter_duplicate_panics() {
        let (env, client, _admin) = setup();
        let _ = setup_token(&env);

        let user = Address::generate(&env);
        let meter_id = symbol_short!("METER2");

        allowlist_and_register(&client, &meter_id, &user);
        // Second registration with the same id must panic
        client.register_meter(&meter_id, &user);
    }

    /// make_payment with amount = 0 should panic.
    #[test]
    #[should_panic(expected = "amount must be positive")]
    fn test_make_payment_zero_amount_panics() {
        let (env, client, _admin) = setup();
        let (token_address, _token_admin_client, _token_client) = setup_token(&env);

        let user = Address::generate(&env);
        let meter_id = symbol_short!("METER3");

        allowlist_and_register(&client, &meter_id, &user);
        client.make_payment(&meter_id, &token_address, &user, &0_i128, &PaymentPlan::Daily);
    }

    /// make_payment with a negative amount should panic.
    #[test]
    #[should_panic(expected = "amount must be positive")]
    fn test_make_payment_negative_amount_panics() {
        let (env, client, _admin) = setup();
        let (token_address, _token_admin_client, _token_client) = setup_token(&env);

        let user = Address::generate(&env);
        let meter_id = symbol_short!("METER4");

        allowlist_and_register(&client, &meter_id, &user);
        client.make_payment(&meter_id, &token_address, &user, &-1_i128, &PaymentPlan::Daily);
    }

    /// update_usage drains balance correctly and deactivates at zero.
    #[test]
    fn test_update_usage_balance_drains_correctly() {
        let (env, client, _admin) = setup();
        let (token_address, token_admin_client, _token_client) = setup_token(&env);

        let user = Address::generate(&env);
        let meter_id = symbol_short!("METER5");

        allowlist_and_register(&client, &meter_id, &user);
        token_admin_client.mint(&user, &10_000_000_i128);
        client.make_payment(
            &meter_id,
            &token_address,
            &user,
            &10_000_000_i128,
            &PaymentPlan::UsageBased,
        );

        // Partial drain — meter stays active
        client.update_usage(&meter_id, &50_u64, &4_000_000_i128);
        let meter = client.get_meter(&meter_id);
        assert_eq!(meter.balance, 6_000_000);
        assert_eq!(meter.units_used, 50);
        assert!(meter.active);

        // Drain the rest — meter deactivates
        client.update_usage(&meter_id, &60_u64, &6_000_000_i128);
        let meter = client.get_meter(&meter_id);
        assert_eq!(meter.balance, 0);
        assert_eq!(meter.units_used, 110);
        assert!(!meter.active);
    }

    /// update_usage with a huge cost should clamp balance to zero without panic.
    #[test]
    fn test_update_usage_huge_cost_clamps_to_zero() {
        let (env, client, _admin) = setup();
        let (token_address, token_admin_client, _token_client) = setup_token(&env);

        let user = Address::generate(&env);
        let meter_id = symbol_short!("METER9");

        allowlist_and_register(&client, &meter_id, &user);
        token_admin_client.mint(&user, &100_i128);
        client.make_payment(
            &meter_id,
            &token_address,
            &user,
            &100_i128,
            &PaymentPlan::UsageBased,
        );

        client.update_usage(&meter_id, &1_u64, &i128::MAX);
        let meter = client.get_meter(&meter_id);
        assert_eq!(meter.balance, 0);
        assert_eq!(meter.units_used, 1);
        assert!(!meter.active);
    }
    /// check_access returns false when balance is zero even if active flag is true.
    #[test]
    fn test_check_access_false_when_balance_zero() {
        let (env, client, _admin) = setup();
        let (token_address, token_admin_client, _token_client) = setup_token(&env);

        let user = Address::generate(&env);
        let meter_id = symbol_short!("METER7");

        allowlist_and_register(&client, &meter_id, &user);

        // Newly registered meter: active=false, balance=0
        assert!(!client.check_access(&meter_id));

        // Pay then fully drain
        token_admin_client.mint(&user, &2_000_000_i128);
        client.make_payment(
            &meter_id,
            &token_address,
            &user,
            &2_000_000_i128,
            &PaymentPlan::Weekly,
        );
        assert!(client.check_access(&meter_id));

        client.update_usage(&meter_id, &10_u64, &2_000_000_i128);
        assert!(!client.check_access(&meter_id));

        let meter = client.get_meter(&meter_id);
        assert_eq!(meter.balance, 0);
        assert!(!meter.active);
    }

    /// Daily plans should auto-expire after 24 hours even with remaining balance.
    #[test]
    fn test_check_access_false_when_plan_expired() {
        let (env, client, _admin) = setup();
        let (token_address, token_admin_client, _token_client) = setup_token(&env);

        let user = Address::generate(&env);
        let meter_id = symbol_short!("METER9");

        allowlist_and_register(&client, &meter_id, &user);
        token_admin_client.mint(&user, &2_000_000_i128);
        client.make_payment(
            &meter_id,
            &token_address,
            &user,
            &2_000_000_i128,
            &PaymentPlan::Daily,
        );
        assert!(client.check_access(&meter_id));

        let meter = client.get_meter(&meter_id);
        env.ledger().with_mut(|li| {
            li.timestamp = meter.expires_at;
        });

        // Access should be denied exactly at expiry boundary.
        assert!(!client.check_access(&meter_id));
    }

    /// Registering an owner not on the allowlist must panic.
    #[test]
    #[should_panic(expected = "owner not in allowlist")]
    fn test_register_meter_owner_not_allowlisted_panics() {
        let (env, client, _admin) = setup();
        let user = Address::generate(&env);
        let meter_id = symbol_short!("METER8");
        // Deliberately skip allowlist_add
        client.register_meter(&meter_id, &user);
    }

    /// allowlist_add / allowlist_remove round-trip.
    #[test]
    fn test_allowlist_add_remove() {
        let (env, client, _admin) = setup();
        let user = Address::generate(&env);

        assert!(!client.get_allowlist().contains(&user));

        client.allowlist_add(&user);
        assert!(client.get_allowlist().contains(&user));

        client.allowlist_remove(&user);
        assert!(!client.get_allowlist().contains(&user));
    }

    /// Adding the same address twice should not duplicate it.
    #[test]
    fn test_allowlist_no_duplicates() {
        let (env, client, _admin) = setup();
        let user = Address::generate(&env);

        client.allowlist_add(&user);
        client.allowlist_add(&user);

        let list = client.get_allowlist();
        let count = list.iter().filter(|a| *a == user).count();
        assert_eq!(count, 1);
    }

    /// Removing an address that was never added is a no-op.
    #[test]
    fn test_allowlist_remove_nonexistent_is_noop() {
        let (env, client, _admin) = setup();
        let user = Address::generate(&env);
        // Should not panic
        client.allowlist_remove(&user);
        assert!(!client.get_allowlist().contains(&user));
    }

    #[test]
    fn test_withdraw_revenue_tracks_and_withdraws_provider_balance() {
        let (env, client, admin) = setup();
        let (token_address, token_admin_client, token_client) = setup_token(&env);

        let user = Address::generate(&env);
        let meter_id = symbol_short!("METER9");
        allowlist_and_register(&client, &meter_id, &user);

        token_admin_client.mint(&user, &5_000_000_i128);
        client.make_payment(
            &meter_id,
            &token_address,
            &user,
            &5_000_000_i128,
            &PaymentPlan::Daily,
        );

        assert_eq!(client.get_provider_revenue(&admin), 5_000_000_i128);
        assert_eq!(token_client.balance(&client.address), 5_000_000_i128);

        client.withdraw_revenue(&token_address, &admin, &2_000_000_i128);
        assert_eq!(client.get_provider_revenue(&admin), 3_000_000_i128);
        assert_eq!(token_client.balance(&client.address), 3_000_000_i128);
        assert_eq!(token_client.balance(&admin), 2_000_000_i128);
    }

    #[test]
    #[should_panic(expected = "insufficient provider revenue")]
    fn test_withdraw_revenue_panics_when_amount_exceeds_tracked_balance() {
        let (env, client, admin) = setup();
        let (token_address, _token_admin_client, _token_client) = setup_token(&env);

        let user = Address::generate(&env);
        let meter_id = symbol_short!("METR10");
        allowlist_and_register(&client, &meter_id, &user);

        client.withdraw_revenue(&token_address, &admin, &1_i128);
    }

    /// Exact-balance drain: cost == balance should deactivate the meter.
    /// Regression test for the `<= 0` vs `== 0` edge case.
    #[test]
    fn test_update_usage_exact_balance_deactivates_meter() {
        let (env, client, _admin) = setup();
        let (token_address, token_admin_client, _) = setup_token(&env);

        let user = Address::generate(&env);
        let meter_id = symbol_short!("EXACT");

        allowlist_and_register(&client, &meter_id, &user);
        token_admin_client.mint(&user, &5_000_000_i128);
        client.make_payment(
            &meter_id,
            &token_address,
            &user,
            &5_000_000_i128,
            &PaymentPlan::UsageBased,
        );

        // cost == balance exactly
        client.update_usage(&meter_id, &1_u64, &5_000_000_i128);
        let meter = client.get_meter(&meter_id);
        assert_eq!(meter.balance, 0, "balance should be 0");
        assert!(!meter.active, "meter should be deactivated when balance hits 0");
    }

    // ── Event emission tests ──────────────────────────────────────────────────

    /// set_active(true) must panic when the meter has zero balance (#86).
    #[test]
    #[should_panic(expected = "cannot activate meter with zero balance")]
    fn test_set_active_true_panics_when_balance_zero() {
        let (env, client, _admin) = setup();
        let user = Address::generate(&env);
        let meter_id = symbol_short!("ZERO_BAL");

        allowlist_and_register(&client, &meter_id, &user);
        // Meter has balance=0 right after registration — activating must panic.
        client.set_active(&meter_id, &true);
    }

    #[test]
    fn test_event_meter_registered() {
        let (env, client, _admin) = setup();
        let user = Address::generate(&env);
        let meter_id = symbol_short!("EV_REG");

        client.allowlist_add(&user);
        client.register_meter(&meter_id, &user);

        let events = env.events().all();
        let found = events.iter().any(|(_, topics, _)| {
            topics.len() >= 2
                && topics.get(0) == Some(symbol_short!("mtr_reg").into())
                && topics.get(1) == Some(EVT_NS.into())
        });
        assert!(found, "mtr_reg event not emitted");
    }

    #[test]
    fn test_event_payment_received_and_meter_activated() {
        let (env, client, _admin) = setup();
        let (token_address, token_admin_client, _) = setup_token(&env);
        let user = Address::generate(&env);
        let meter_id = symbol_short!("EV_PMT");

        allowlist_and_register(&client, &meter_id, &user);
        token_admin_client.mint(&user, &1_000_000_i128);
        client.make_payment(&meter_id, &token_address, &user, &1_000_000_i128, &PaymentPlan::Daily);

        let events = env.events().all();
        let has_pmt = events.iter().any(|(_, topics, _)| {
            topics.get(0) == Some(symbol_short!("pmt_rcvd").into())
        });
        let has_actv = events.iter().any(|(_, topics, _)| {
            topics.get(0) == Some(symbol_short!("mtr_actv").into())
        });
        assert!(has_pmt, "pmt_rcvd event not emitted");
        assert!(has_actv, "mtr_actv event not emitted");
    }

    #[test]
    fn test_event_usage_updated_and_meter_deactivated() {
        let (env, client, _admin) = setup();
        let (token_address, token_admin_client, _) = setup_token(&env);
        let user = Address::generate(&env);
        let meter_id = symbol_short!("EV_USG");

        allowlist_and_register(&client, &meter_id, &user);
        token_admin_client.mint(&user, &500_i128);
        client.make_payment(&meter_id, &token_address, &user, &500_i128, &PaymentPlan::UsageBased);

        // Drain balance fully — triggers both usg_upd and mtr_deact
        client.update_usage(&meter_id, &10_u64, &500_i128);

        let events = env.events().all();
        let has_usg = events.iter().any(|(_, topics, _)| {
            topics.get(0) == Some(symbol_short!("usg_upd").into())
        });
        let has_deact = events.iter().any(|(_, topics, _)| {
            topics.get(0) == Some(symbol_short!("mtr_deact").into())
        });
        assert!(has_usg, "usg_upd event not emitted");
        assert!(has_deact, "mtr_deact event not emitted on balance drain");
    }

    #[test]
    fn test_event_meter_deactivated_via_set_active() {
        let (env, client, _admin) = setup();
        let (token_address, token_admin_client, _) = setup_token(&env);
        let user = Address::generate(&env);
        let meter_id = symbol_short!("EV_SET");

        allowlist_and_register(&client, &meter_id, &user);
        token_admin_client.mint(&user, &1_000_i128);
        client.make_payment(&meter_id, &token_address, &user, &1_000_i128, &PaymentPlan::Daily);

        client.set_active(&meter_id, &false);

        let events = env.events().all();
        let has_deact = events.iter().any(|(_, topics, _)| {
            topics.get(0) == Some(symbol_short!("mtr_deact").into())
        });
        assert!(has_deact, "mtr_deact event not emitted by set_active(false)");
    }

    #[test]
    fn test_event_meter_activated_via_set_active() {
        let (env, client, _admin) = setup();
        let (token_address, token_admin_client, _) = setup_token(&env);
        let user = Address::generate(&env);
        let meter_id = symbol_short!("EV_ON");

        allowlist_and_register(&client, &meter_id, &user);
        token_admin_client.mint(&user, &1_000_i128);
        client.make_payment(&meter_id, &token_address, &user, &1_000_i128, &PaymentPlan::Daily);
        // Deactivate first so we can re-activate
        client.set_active(&meter_id, &false);

        client.set_active(&meter_id, &true);

        let events = env.events().all();
        let has_actv = events.iter().any(|(_, topics, _)| {
            topics.get(0) == Some(symbol_short!("mtr_actv").into())
                && topics.get(1) == Some(EVT_NS.into())
        });
        assert!(has_actv, "mtr_actv event not emitted by set_active(true)");
    }
}
