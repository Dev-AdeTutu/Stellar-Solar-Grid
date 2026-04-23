#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, vec, Address, Env, Symbol, Vec,
};

// ── Storage keys ──────────────────────────────────────────────────────────────

const ADMIN: Symbol = symbol_short!("ADMIN");
const ALLOWLIST: Symbol = symbol_short!("ALLOWLIST");

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
    pub balance: i128,       // in stroops (1 XLM = 10_000_000 stroops)
    pub units_used: u64,     // kWh * 1000 (milli-kWh for precision)
    pub plan: PaymentPlan,
    pub last_payment: u64,   // ledger timestamp
}

#[contracttype]
pub enum DataKey {
    Meter(Symbol),
    OwnerMeters(Address),
}

// ── Event topics (contract namespace) ────────────────────────────────────────

const EVT_NS: Symbol = symbol_short!("solargrid");


#[contract]
pub struct SolarGridContract;

#[contractimpl]
impl SolarGridContract {
    /// Initialize the contract with an admin address.
    pub fn initialize(env: Env, admin: Address) {
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
    /// `amount` is in stroops. `plan` sets the billing cycle.
    ///
    /// Emits:
    /// - `payment_received { meter_id, payer, amount, plan }`
    /// - `meter_activated  { meter_id }` (always, since payment activates the meter)
    pub fn make_payment(
        env: Env,
        meter_id: Symbol,
        payer: Address,
        amount: i128,
        plan: PaymentPlan,
    ) {
        payer.require_auth();
        if amount <= 0 {
            panic!("amount must be positive");
        }
        let key = DataKey::Meter(meter_id.clone());
        let mut meter: Meter = env.storage().persistent().get(&key).expect("meter not found");
        meter.balance += amount;
        meter.active = true;
        meter.plan = plan.clone();
        meter.last_payment = env.ledger().timestamp();
        env.storage().persistent().set(&key, &meter);

        // payment_received
        env.events().publish(
            (symbol_short!("pmt_rcvd"), EVT_NS, meter_id.clone()),
            (payer, amount, plan),
        );
        // meter_activated — payment always activates the meter
        env.events().publish(
            (symbol_short!("mtr_actv"), EVT_NS, meter_id),
            (),
        );
    }

    /// Check whether a meter currently has active energy access.
    pub fn check_access(env: Env, meter_id: Symbol) -> bool {
        let key = DataKey::Meter(meter_id);
        let meter: Meter = env.storage().persistent().get(&key).expect("meter not found");
        meter.active && meter.balance > 0
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
        meter.balance -= cost;
        let deactivated = if meter.balance <= 0 {
            meter.balance = 0;
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
    use soroban_sdk::{symbol_short, testutils::Address as _, Env};

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

    #[test]
    fn test_register_and_pay() {
        let (env, client, _admin) = setup();

        let user = Address::generate(&env);
        let meter_id = symbol_short!("METER1");

        allowlist_and_register(&client, &meter_id, &user);

        // Before payment — inactive
        assert!(!client.check_access(&meter_id));

        // Make payment
        client.make_payment(&meter_id, &user, &5_000_000_i128, &PaymentPlan::Daily);
        assert!(client.check_access(&meter_id));

        // Simulate usage that drains balance
        client.update_usage(&meter_id, &100_u64, &5_000_000_i128);
        assert!(!client.check_access(&meter_id));
    }

    /// Registering the same meter_id twice should panic.
    #[test]
    #[should_panic(expected = "meter already registered")]
    fn test_register_meter_duplicate_panics() {
        let (env, client, _admin) = setup();

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

        let user = Address::generate(&env);
        let meter_id = symbol_short!("METER3");

        allowlist_and_register(&client, &meter_id, &user);
        client.make_payment(&meter_id, &user, &0_i128, &PaymentPlan::Daily);
    }

    /// make_payment with a negative amount should panic.
    #[test]
    #[should_panic(expected = "amount must be positive")]
    fn test_make_payment_negative_amount_panics() {
        let (env, client, _admin) = setup();

        let user = Address::generate(&env);
        let meter_id = symbol_short!("METER4");

        allowlist_and_register(&client, &meter_id, &user);
        client.make_payment(&meter_id, &user, &-1_i128, &PaymentPlan::Daily);
    }

    /// update_usage drains balance correctly and deactivates at zero.
    #[test]
    fn test_update_usage_balance_drains_correctly() {
        let (env, client, _admin) = setup();

        let user = Address::generate(&env);
        let meter_id = symbol_short!("METER5");

        allowlist_and_register(&client, &meter_id, &user);
        client.make_payment(&meter_id, &user, &10_000_000_i128, &PaymentPlan::UsageBased);

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

    /// set_active called by a non-admin should panic (auth not mocked for non-admin).
    #[test]
    #[should_panic]
    fn test_set_active_non_admin_panics() {
        let env = Env::default();
        // Only mock auth for the non-admin user, not the contract admin
        let contract_id = env.register_contract(None, SolarGridContract);
        let client = SolarGridContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let non_admin = Address::generate(&env);
        let meter_id = symbol_short!("METER6");

        // Initialize with real admin (mock all for setup only)
        env.mock_all_auths();
        client.initialize(&admin);
        client.allowlist_add(&non_admin);
        client.register_meter(&meter_id, &non_admin);
        client.make_payment(&meter_id, &non_admin, &1_000_000_i128, &PaymentPlan::Daily);

        // Stop mocking all auths — now only non_admin is authorized
        // set_active requires admin auth, so this must panic
        env.set_auths(&[soroban_sdk::auth::ContractContext {
            contract: contract_id.clone(),
            fn_name: soroban_sdk::symbol_short!("set_active"),
            args: (meter_id.clone(), false).into_val(&env),
        }
        .into()]);
        client.set_active(&meter_id, &false);
    }

    /// check_access returns false when balance is zero even if active flag is true.
    #[test]
    fn test_check_access_false_when_balance_zero() {
        let (env, client, _admin) = setup();

        let user = Address::generate(&env);
        let meter_id = symbol_short!("METER7");

        allowlist_and_register(&client, &meter_id, &user);

        // Newly registered meter: active=false, balance=0
        assert!(!client.check_access(&meter_id));

        // Pay then fully drain
        client.make_payment(&meter_id, &user, &2_000_000_i128, &PaymentPlan::Weekly);
        assert!(client.check_access(&meter_id));

        client.update_usage(&meter_id, &10_u64, &2_000_000_i128);
        assert!(!client.check_access(&meter_id));

        let meter = client.get_meter(&meter_id);
        assert_eq!(meter.balance, 0);
        assert!(!meter.active);
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
        let count = list.iter().filter(|a| a == user).count();
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
}
