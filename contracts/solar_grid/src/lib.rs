#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, contracterror, symbol_short, token, vec, Address, Env, Symbol, Vec,
};

// ── Error types ───────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ContractError {
    NotInitialized    = 1,
    MeterAlreadyExists = 2,
    OracleNotSet      = 3,
    UnauthorizedOracle = 4,
}

// ── Storage keys ──────────────────────────────────────────────────────────────

const ADMIN: Symbol = symbol_short!("ADMIN");
const ALLOWLIST: Symbol = symbol_short!("ALLOWLIST");
const TOKEN: Symbol = symbol_short!("TOKEN");
const ORACLE: Symbol = symbol_short!("ORACLE");
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
    /// Schema version — increment when fields are added/changed.
    /// v1: initial layout (owner, active, balance, units_used, plan, last_payment, expires_at)
    pub version: u32,
    pub owner: Address,
    pub active: bool,
    pub units_used: u64,    // kWh * 1000 (milli-kWh for precision)
    pub plan: PaymentPlan,
    pub last_payment: u64,  // ledger timestamp
    pub expires_at: u64,    // ledger timestamp when access expires
}

/// v0 layout — kept for migration purposes only.
/// Remove once all persistent entries have been migrated to v1.
#[contracttype]
#[derive(Clone, Debug)]
pub struct LegacyMeter {
    pub owner: Address,
    pub active: bool,
    pub balance: i128,
    pub units_used: u64,
    pub plan: PaymentPlan,
    pub last_payment: u64,
    pub expires_at: u64,
}

/// Migrate a v0 (legacy) meter entry to the current v1 schema.
fn migrate_meter_v0(old: LegacyMeter) -> Meter {
    Meter {
        version: 1,
        owner: old.owner,
        active: old.active,
        units_used: old.units_used,
        plan: old.plan,
        last_payment: old.last_payment,
        expires_at: old.expires_at,
    }
}

#[contracttype]
pub enum DataKey {
    Meter(Symbol),
    OwnerMeters(Address),
    ProviderRevenue(Address),
    MeterBalance(Symbol),
}

// ── Event topics (contract namespace) ────────────────────────────────────────

const EVT_NS: Symbol = symbol_short!("solargrid");


#[contract]
pub struct SolarGridContract;

#[contractimpl]
impl SolarGridContract {
    /// Initialize the contract with an admin address and the SAC token address.
    pub fn initialize(env: Env, admin: Address, token_address: Address) {
        env.deployer().require_auth();
        if env.storage().instance().has(&ADMIN) {
            panic!("already initialized");
        }
        env.storage().instance().set(&ADMIN, &admin);
        env.storage().instance().set(&TOKEN, &token_address);
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
            env.panic_with_error(ContractError::MeterAlreadyExists);
        }
        let meter = Meter {
            version: 1,
            owner: owner.clone(),
            active: false,
            units_used: 0,
            plan: PaymentPlan::Daily,
            last_payment: env.ledger().timestamp(),
            expires_at: env.ledger().timestamp(),
        };
        env.storage().persistent().set(&key, &meter);

        // Append meter_id to the owner's meter list
        let owner_key = DataKey::OwnerMeters(owner.clone());
        let mut list: Vec<Symbol> = env
            .storage()
            .persistent()
            .get(&owner_key)
            .unwrap_or_else(|| vec![&env]);
        list.push_back(meter_id.clone());
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

    /// Register the IoT oracle address. Only admin may call this.
    pub fn set_oracle(env: Env, oracle: Address) {
        Self::require_admin(&env);
        env.storage().instance().set(&ORACLE, &oracle);
    }

    /// Return the registered oracle address, if any.
    pub fn get_oracle(env: Env) -> Option<Address> {
        env.storage().instance().get(&ORACLE)
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
        payer: Address,
        amount: i128,
        plan: PaymentPlan,
    ) {
        payer.require_auth();
        if amount <= 0 {
            panic!("amount must be positive");
        }
        let token_address: Address = env.storage().instance().get(&TOKEN).expect("not initialized");
        let token_client = token::Client::new(&env, &token_address);
        token_client.transfer(&payer, &env.current_contract_address(), &amount);

        let key = DataKey::Meter(meter_id.clone());
        let mut meter: Meter = env.storage().persistent().get(&key).expect("meter not found");
        let now = env.ledger().timestamp();
        match plan {
            PaymentPlan::Daily | PaymentPlan::Weekly | PaymentPlan::UsageBased => {}
        }
        let expires_at = match plan {
            PaymentPlan::Daily => now.saturating_add(SECONDS_PER_DAY),
            PaymentPlan::Weekly => now.saturating_add(SECONDS_PER_WEEK),
            PaymentPlan::UsageBased => u64::MAX,
        };

        // Track per-meter balance in contract storage
        let bal_key = DataKey::MeterBalance(meter_id.clone());
        let prev_bal: i128 = env.storage().persistent().get(&bal_key).unwrap_or(0);
        env.storage().persistent().set(&bal_key, &(prev_bal + amount));

        meter.active = true;
        meter.plan = plan.clone();
        meter.last_payment = now;
        meter.expires_at = expires_at;
        env.storage().persistent().set(&key, &meter);

        // Track provider (admin) accrued revenue
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
        // meter_activated
        env.events().publish(
            (symbol_short!("mtr_actv"), EVT_NS, meter_id),
            (),
        );
    }

    /// Withdraw accumulated revenue from the contract vault to the provider address.
    ///
    /// # Access control
    /// Only the contract admin may call this.
    ///
    /// # Panics
    /// - `"amount must be positive"` — if `amount <= 0`
    /// - `"provider is not admin"` — if caller is not the contract admin
    /// - `"insufficient provider revenue"` — if tracked balance < `amount`
    ///
    /// Emits: `rev_wdrl { provider, token_address, amount }`
    pub fn withdraw_revenue(env: Env, provider: Address, amount: i128) {
        if amount <= 0 {
            panic!("amount must be positive");
        }
        Self::require_initialized(&env);
        let admin: Address = env.storage().instance().get(&ADMIN).unwrap();
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

        let token_address: Address = env.storage().instance().get(&TOKEN).expect("not initialized");
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
        let key = DataKey::Meter(meter_id.clone());
        let meter: Meter = env.storage().persistent().get(&key).expect("meter not found");
        let bal_key = DataKey::MeterBalance(meter_id);
        let balance: i128 = env.storage().persistent().get(&bal_key).unwrap_or(0);
        meter.active && balance > 0 && env.ledger().timestamp() < meter.expires_at
    }

    /// Called by the IoT oracle to record energy consumption (milli-kWh).
    /// Deducts cost from balance; deactivates meter if balance runs out.
    ///
    /// Emits:
    /// - `usage_updated    { meter_id, units, cost }`
    /// - `meter_deactivated { meter_id }` (only when balance hits zero)
    pub fn update_usage(env: Env, meter_id: Symbol, units: u64, cost: i128) {
        Self::require_oracle(&env);
        let key = DataKey::Meter(meter_id.clone());
        let mut meter: Meter = env.storage().persistent().get(&key).expect("meter not found");
        let bal_key = DataKey::MeterBalance(meter_id.clone());
        let balance: i128 = env.storage().persistent().get(&bal_key).unwrap_or(0);
        let new_balance = balance.checked_sub(cost).unwrap_or(0).max(0);
        env.storage().persistent().set(&bal_key, &new_balance);
        meter.units_used += units;
        let deactivated = if new_balance == 0 {
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

    /// Batch update usage for multiple meters in a single transaction.
    /// Invalid meter IDs are skipped and logged via a `batch_skip` event.
    ///
    /// Emits per processed meter:
    /// - `usg_upd  { meter_id, units, cost }`
    /// - `mtr_deact { meter_id }` (when balance hits zero)
    ///
    /// Emits per skipped meter:
    /// - `batch_skip { meter_id }`
    pub fn batch_update_usage(env: Env, updates: Vec<(Symbol, u64, i128)>) {
        Self::require_oracle(&env);
        if updates.len() > 50 {
            panic!("batch too large");
        }
        for (meter_id, units, cost) in updates.iter() {
            let key = DataKey::Meter(meter_id.clone());
            let meter_opt: Option<Meter> = env.storage().persistent().get(&key);
            let mut meter = match meter_opt {
                Some(m) => m,
                None => {
                    env.events().publish(
                        (symbol_short!("btch_skip"), EVT_NS, meter_id.clone()),
                        (),
                    );
                    continue;
                }
            };
            let bal_key = DataKey::MeterBalance(meter_id.clone());
            let balance: i128 = env.storage().persistent().get(&bal_key).unwrap_or(0);
            let new_balance = balance.checked_sub(cost).unwrap_or(0).max(0);
            env.storage().persistent().set(&bal_key, &new_balance);
            meter.units_used += units;
            let deactivated = if new_balance == 0 {
                meter.active = false;
                true
            } else {
                false
            };
            env.storage().persistent().set(&key, &meter);
            env.events().publish(
                (symbol_short!("usg_upd"), EVT_NS, meter_id.clone()),
                (units, cost),
            );
            if deactivated {
                env.events().publish(
                    (symbol_short!("mtr_deact"), EVT_NS, meter_id),
                    (),
                );
            }
        }
    }

    /// Get the on-chain token balance held by this contract for a specific meter.
    pub fn get_meter_balance(env: Env, meter_id: Symbol) -> i128 {
        let bal_key = DataKey::MeterBalance(meter_id);
        env.storage().persistent().get(&bal_key).unwrap_or(0)
    }

    /// Get meter details.
    pub fn get_meter(env: Env, meter_id: Symbol) -> Meter {
        let key = DataKey::Meter(meter_id);
        env.storage().persistent().get(&key).expect("meter not found")
    }

    /// Admin can manually toggle meter access (e.g. maintenance).
    ///
    /// # Panics
    /// - `"cannot activate meter with zero balance"` — enforces the PAYG invariant:
    ///   a meter with no credit must never be activated.
    ///
    /// Emits:
    /// - `meter_activated   { meter_id }` when toggled on
    /// - `meter_deactivated { meter_id }` when toggled off
    pub fn set_active(env: Env, meter_id: Symbol, active: bool) {
        Self::require_admin(&env);
        let key = DataKey::Meter(meter_id.clone());
        let mut meter: Meter = env.storage().persistent().get(&key).expect("meter not found");
        if active {
            let bal_key = DataKey::MeterBalance(meter_id.clone());
            let balance: i128 = env.storage().persistent().get(&bal_key).unwrap_or(0);
            if balance == 0 {
                panic!("cannot activate meter with zero balance");
            }
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

    /// Migrate a single meter entry from the v0 (LegacyMeter) schema to v1 (Meter).
    /// Admin-only. Safe to call multiple times — skips entries already at v1.
    ///
    /// # Panics
    /// - `ContractError::NotInitialized` — if contract is not initialized
    /// - `"meter not found"` — if `meter_id` has no storage entry
    pub fn migrate_meter(env: Env, meter_id: Symbol) {
        Self::require_admin(&env);
        let key = DataKey::Meter(meter_id.clone());
        // Attempt to read as current Meter first; if it deserializes, already migrated.
        let legacy: LegacyMeter = env
            .storage()
            .persistent()
            .get(&key)
            .expect("meter not found");
        let migrated = migrate_meter_v0(legacy);
        env.storage().persistent().set(&key, &migrated);
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    fn require_initialized(env: &Env) {
        if !env.storage().instance().has(&ADMIN) {
            env.panic_with_error(ContractError::NotInitialized);
        }
    }

    fn require_admin(env: &Env) {
        Self::require_initialized(env);
        let admin: Address = env.storage().instance().get(&ADMIN).unwrap();
        admin.require_auth();
    }

    fn require_oracle(env: &Env) {
        Self::require_initialized(env);
        let oracle: Address = env
            .storage()
            .instance()
            .get(&ORACLE)
            .unwrap_or_else(|| env.panic_with_error(ContractError::OracleNotSet));
        oracle.require_auth();
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        symbol_short,
        testutils::{Address as _, Events, Ledger},
        token, Address, Env, Symbol, TryFromVal,
    };

    fn sym_eq(env: &Env, val: &soroban_sdk::Val, expected: Symbol) -> bool {
        Symbol::try_from_val(env, val).ok() == Some(expected)
    }

    fn setup() -> (Env, SolarGridContractClient<'static>, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, SolarGridContract);
        let client = SolarGridContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token_address = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        client.initialize(&admin, &token_address);
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

    /// Setup with a specific token registered in initialize.
    /// Returns (env, client, admin, token_address).
    /// Callers can construct token clients from token_address as needed.
    fn setup_with_token() -> (Env, SolarGridContractClient<'static>, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, SolarGridContract);
        let client = SolarGridContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token_address = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        client.initialize(&admin, &token_address);
        (env, client, admin, token_address)
    }

    /// Helper: generate an oracle address and register it on the contract.
    fn setup_oracle(env: &Env, client: &SolarGridContractClient) -> Address {
        let oracle = Address::generate(env);
        client.set_oracle(&oracle);
        oracle
    }

    #[test]
    fn test_register_and_pay() {
        let (env, client, _admin, token_address) = setup_with_token();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
        let token_client = token::Client::new(&env, &token_address);
        setup_oracle(&env, &client);

        let user = Address::generate(&env);
        let meter_id = symbol_short!("METER1");

        allowlist_and_register(&client, &meter_id, &user);
        assert!(!client.check_access(&meter_id));

        token_admin_client.mint(&user, &5_000_000_i128);
        client.make_payment(&meter_id, &user, &5_000_000_i128, &PaymentPlan::Daily);
        assert!(client.check_access(&meter_id));
        assert_eq!(token_client.balance(&user), 0);

        client.update_usage(&meter_id, &100_u64, &5_000_000_i128);
        assert!(!client.check_access(&meter_id));
    }

    /// Registering the same meter_id twice should return MeterAlreadyExists.
    #[test]
    fn test_register_meter_duplicate_returns_typed_error() {
        let (env, client, _admin, _token_address) = setup_with_token();
        let user = Address::generate(&env);
        let meter_id = symbol_short!("METER2");
        allowlist_and_register(&client, &meter_id, &user);
        let result = client.try_register_meter(&meter_id, &user);
        assert_eq!(
            result,
            Err(Ok(ContractError::MeterAlreadyExists))
        );
    }

    /// make_payment with amount = 0 should panic.
    #[test]
    #[should_panic(expected = "amount must be positive")]
    fn test_make_payment_zero_amount_panics() {
        let (env, client, _admin, _token_address) = setup_with_token();
        let user = Address::generate(&env);
        let meter_id = symbol_short!("METER3");
        allowlist_and_register(&client, &meter_id, &user);
        client.make_payment(&meter_id, &user, &0_i128, &PaymentPlan::Daily);
    }

    #[test]
    #[should_panic(expected = "amount must be positive")]
    fn test_make_payment_negative_amount_panics() {
        let (env, client, _admin, _token_address) = setup_with_token();
        let user = Address::generate(&env);
        let meter_id = symbol_short!("METER4");
        allowlist_and_register(&client, &meter_id, &user);
        client.make_payment(&meter_id, &user, &-1_i128, &PaymentPlan::Daily);
    }

    #[test]
    fn test_update_usage_balance_drains_correctly() {
        let (env, client, _admin, token_address) = setup_with_token();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
        setup_oracle(&env, &client);

        let user = Address::generate(&env);
        let meter_id = symbol_short!("METER5");

        allowlist_and_register(&client, &meter_id, &user);
        token_admin_client.mint(&user, &10_000_000_i128);
        client.make_payment(&meter_id, &user, &10_000_000_i128, &PaymentPlan::UsageBased);

        client.update_usage(&meter_id, &50_u64, &4_000_000_i128);
        assert_eq!(client.get_meter_balance(&meter_id), 6_000_000);
        let meter = client.get_meter(&meter_id);
        assert_eq!(meter.units_used, 50);
        assert!(meter.active);

        client.update_usage(&meter_id, &60_u64, &6_000_000_i128);
        assert_eq!(client.get_meter_balance(&meter_id), 0);
        let meter = client.get_meter(&meter_id);
        assert_eq!(meter.units_used, 110);
        assert!(!meter.active);
    }

    #[test]
    fn test_update_usage_huge_cost_clamps_to_zero() {
        let (env, client, _admin, token_address) = setup_with_token();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
        setup_oracle(&env, &client);

        let user = Address::generate(&env);
        let meter_id = symbol_short!("METER9");

        allowlist_and_register(&client, &meter_id, &user);
        token_admin_client.mint(&user, &100_i128);
        client.make_payment(&meter_id, &user, &100_i128, &PaymentPlan::UsageBased);

        client.update_usage(&meter_id, &1_u64, &i128::MAX);
        assert_eq!(client.get_meter_balance(&meter_id), 0);
        let meter = client.get_meter(&meter_id);
        assert_eq!(meter.units_used, 1);
        assert!(!meter.active);
    }
    #[test]
    fn test_check_access_false_when_balance_zero() {
        let (env, client, _admin, token_address) = setup_with_token();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
        setup_oracle(&env, &client);

        let user = Address::generate(&env);
        let meter_id = symbol_short!("METER7");

        allowlist_and_register(&client, &meter_id, &user);
        assert!(!client.check_access(&meter_id));

        token_admin_client.mint(&user, &2_000_000_i128);
        client.make_payment(&meter_id, &user, &2_000_000_i128, &PaymentPlan::Weekly);
        assert!(client.check_access(&meter_id));

        client.update_usage(&meter_id, &10_u64, &2_000_000_i128);
        assert!(!client.check_access(&meter_id));

        assert_eq!(client.get_meter_balance(&meter_id), 0);
        assert!(!client.get_meter(&meter_id).active);
    }

    /// Daily plans should auto-expire after 24 hours even with remaining balance.
    #[test]
    fn test_check_access_false_when_plan_expired() {
        let (env, client, _admin, token_address) = setup_with_token();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);

        let user = Address::generate(&env);
        let meter_id = symbol_short!("METER9");

        allowlist_and_register(&client, &meter_id, &user);
        token_admin_client.mint(&user, &2_000_000_i128);
        client.make_payment(&meter_id, &user, &2_000_000_i128, &PaymentPlan::Daily);
        assert!(client.check_access(&meter_id));

        let meter = client.get_meter(&meter_id);
        env.ledger().with_mut(|li| { li.timestamp = meter.expires_at; });
        assert!(!client.check_access(&meter_id));
    }

    #[test]
    fn test_check_access_false_when_weekly_plan_expired() {
        let (env, client, _admin, token_address) = setup_with_token();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);

        let user = Address::generate(&env);
        let meter_id = symbol_short!("WK_EXP");

        allowlist_and_register(&client, &meter_id, &user);
        token_admin_client.mint(&user, &5_000_000_i128);
        client.make_payment(&meter_id, &user, &5_000_000_i128, &PaymentPlan::Weekly);
        assert!(client.check_access(&meter_id));

        let meter = client.get_meter(&meter_id);
        assert_eq!(meter.expires_at - meter.last_payment, SECONDS_PER_WEEK);

        env.ledger().with_mut(|li| li.timestamp = meter.expires_at);
        assert!(!client.check_access(&meter_id));
    }

    #[test]
    fn test_usage_based_plan_never_expires_by_time() {
        let (env, client, _admin, token_address) = setup_with_token();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);

        let user = Address::generate(&env);
        let meter_id = symbol_short!("UB_EXP");

        allowlist_and_register(&client, &meter_id, &user);
        token_admin_client.mint(&user, &1_000_i128);
        client.make_payment(&meter_id, &user, &1_000_i128, &PaymentPlan::UsageBased);

        let meter = client.get_meter(&meter_id);
        assert_eq!(meter.expires_at, u64::MAX);

        env.ledger().with_mut(|li| li.timestamp = u64::MAX - 1);
        assert!(client.check_access(&meter_id));
    }

    #[test]
    fn test_renewal_resets_expiry_and_restores_access() {
        let (env, client, _admin, token_address) = setup_with_token();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);

        let user = Address::generate(&env);
        let meter_id = symbol_short!("RENEW");

        allowlist_and_register(&client, &meter_id, &user);
        token_admin_client.mint(&user, &4_000_000_i128);
        client.make_payment(&meter_id, &user, &2_000_000_i128, &PaymentPlan::Daily);

        let meter = client.get_meter(&meter_id);
        env.ledger().with_mut(|li| li.timestamp = meter.expires_at);
        assert!(!client.check_access(&meter_id));

        client.make_payment(&meter_id, &user, &2_000_000_i128, &PaymentPlan::Daily);
        assert!(client.check_access(&meter_id));

        let renewed = client.get_meter(&meter_id);
        assert!(renewed.expires_at > meter.expires_at);
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
        let (env, client, admin, token_address) = setup_with_token();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
        let token_client = token::Client::new(&env, &token_address);

        let user = Address::generate(&env);
        let meter_id = symbol_short!("METER9");
        allowlist_and_register(&client, &meter_id, &user);

        token_admin_client.mint(&user, &5_000_000_i128);
        client.make_payment(&meter_id, &user, &5_000_000_i128, &PaymentPlan::Daily);

        assert_eq!(client.get_provider_revenue(&admin), 5_000_000_i128);
        assert_eq!(token_client.balance(&client.address), 5_000_000_i128);

        client.withdraw_revenue(&admin, &2_000_000_i128);
        assert_eq!(client.get_provider_revenue(&admin), 3_000_000_i128);
        assert_eq!(token_client.balance(&client.address), 3_000_000_i128);
        assert_eq!(token_client.balance(&admin), 2_000_000_i128);
    }

    #[test]
    #[should_panic(expected = "insufficient provider revenue")]
    fn test_withdraw_revenue_panics_when_amount_exceeds_tracked_balance() {
        let (env, client, admin, _token_address) = setup_with_token();
        let user = Address::generate(&env);
        let meter_id = symbol_short!("METR10");
        allowlist_and_register(&client, &meter_id, &user);
        client.withdraw_revenue(&admin, &1_i128);
    }

    #[test]
    fn test_update_usage_exact_balance_deactivates_meter() {
        let (env, client, _admin, token_address) = setup_with_token();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
        setup_oracle(&env, &client);

        let user = Address::generate(&env);
        let meter_id = symbol_short!("EXACT");

        allowlist_and_register(&client, &meter_id, &user);
        token_admin_client.mint(&user, &5_000_000_i128);
        client.make_payment(&meter_id, &user, &5_000_000_i128, &PaymentPlan::UsageBased);

        client.update_usage(&meter_id, &1_u64, &5_000_000_i128);
        assert_eq!(client.get_meter_balance(&meter_id), 0, "balance should be 0");
        assert!(!client.get_meter(&meter_id).active, "meter should be deactivated when balance hits 0");
    }

    // ── Event emission tests ──────────────────────────────────────────────────

    /// set_active(true) must panic when the meter has zero balance (#86).
    #[test]
    #[should_panic(expected = "cannot activate meter with zero balance")]
    fn test_set_active_true_panics_when_balance_zero() {
        let (env, client, _admin, _token_address) = setup_with_token();
        let user = Address::generate(&env);
        let meter_id = symbol_short!("ZERO_BAL");
        allowlist_and_register(&client, &meter_id, &user);
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
                && topics.get(0).map(|v| sym_eq(&env, &v, symbol_short!("mtr_reg"))).unwrap_or(false)
                && topics.get(1).map(|v| sym_eq(&env, &v, EVT_NS)).unwrap_or(false)
        });
        assert!(found, "mtr_reg event not emitted");
    }

    #[test]
    fn test_event_payment_received_and_meter_activated() {
        let (env, client, _admin, token_address) = setup_with_token();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
        let user = Address::generate(&env);
        let meter_id = symbol_short!("EV_PMT");

        allowlist_and_register(&client, &meter_id, &user);
        token_admin_client.mint(&user, &1_000_000_i128);
        client.make_payment(&meter_id, &user, &1_000_000_i128, &PaymentPlan::Daily);

        let events = env.events().all();
        let has_pmt = events.iter().any(|(_, topics, _)| {
            topics.get(0).map(|v| sym_eq(&env, &v, symbol_short!("pmt_rcvd"))).unwrap_or(false)
        });
        let has_actv = events.iter().any(|(_, topics, _)| {
            topics.get(0).map(|v| sym_eq(&env, &v, symbol_short!("mtr_actv"))).unwrap_or(false)
        });
        assert!(has_pmt, "pmt_rcvd event not emitted");
        assert!(has_actv, "mtr_actv event not emitted");
    }

    #[test]
    fn test_event_usage_updated_and_meter_deactivated() {
        let (env, client, _admin, token_address) = setup_with_token();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
        setup_oracle(&env, &client);
        let user = Address::generate(&env);
        let meter_id = symbol_short!("EV_USG");

        allowlist_and_register(&client, &meter_id, &user);
        token_admin_client.mint(&user, &500_i128);
        client.make_payment(&meter_id, &user, &500_i128, &PaymentPlan::UsageBased);

        client.update_usage(&meter_id, &10_u64, &500_i128);

        let events = env.events().all();
        let has_usg = events.iter().any(|(_, topics, _)| {
            topics.get(0).map(|v| sym_eq(&env, &v, symbol_short!("usg_upd"))).unwrap_or(false)
        });
        let has_deact = events.iter().any(|(_, topics, _)| {
            topics.get(0).map(|v| sym_eq(&env, &v, symbol_short!("mtr_deact"))).unwrap_or(false)
        });
        assert!(has_usg, "usg_upd event not emitted");
        assert!(has_deact, "mtr_deact event not emitted on balance drain");
    }

    #[test]
    fn test_event_meter_deactivated_via_set_active() {
        let (env, client, _admin, token_address) = setup_with_token();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
        let user = Address::generate(&env);
        let meter_id = symbol_short!("EV_SET");

        allowlist_and_register(&client, &meter_id, &user);
        token_admin_client.mint(&user, &1_000_i128);
        client.make_payment(&meter_id, &user, &1_000_i128, &PaymentPlan::Daily);

        client.set_active(&meter_id, &false);

        let events = env.events().all();
        let has_deact = events.iter().any(|(_, topics, _)| {
            topics.get(0).map(|v| sym_eq(&env, &v, symbol_short!("mtr_deact"))).unwrap_or(false)
        });
        assert!(has_deact, "mtr_deact event not emitted by set_active(false)");
    }

    /// register 3 meters for the same owner — get_meters_by_owner returns all 3.
    #[test]
    fn test_get_meters_by_owner_returns_all() {
        let (env, client, _admin) = setup();
        let user = Address::generate(&env);
        let ids = [symbol_short!("OWN_A"), symbol_short!("OWN_B"), symbol_short!("OWN_C")];

        client.allowlist_add(&user);
        for id in &ids {
            client.register_meter(id, &user);
        }

        let meters = client.get_meters_by_owner(&user);
        assert_eq!(meters.len(), 3);
        for id in &ids {
            assert!(meters.contains(id));
        }
    }

    #[test]
    fn test_event_meter_activated_via_set_active() {
        let (env, client, _admin, token_address) = setup_with_token();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
        let user = Address::generate(&env);
        let meter_id = symbol_short!("EV_ON");

        allowlist_and_register(&client, &meter_id, &user);
        token_admin_client.mint(&user, &1_000_i128);
        client.make_payment(&meter_id, &user, &1_000_i128, &PaymentPlan::Daily);
        client.set_active(&meter_id, &false);

        client.set_active(&meter_id, &true);

        let events = env.events().all();
        let has_actv = events.iter().any(|(_, topics, _)| {
            topics.get(0).map(|v| sym_eq(&env, &v, symbol_short!("mtr_actv"))).unwrap_or(false)
                && topics.get(1).map(|v| sym_eq(&env, &v, EVT_NS)).unwrap_or(false)
        });
        assert!(has_actv, "mtr_actv event not emitted by set_active(true)");
    }

    // ── batch_update_usage tests ──────────────────────────────────────────────

    fn register_and_fund(
        env: &Env,
        client: &SolarGridContractClient,
        token_address: &Address,
        meter_id: &Symbol,
        amount: i128,
    ) {
        let user = Address::generate(env);
        let token_admin_client = token::StellarAssetClient::new(env, token_address);
        allowlist_and_register(client, meter_id, &user);
        token_admin_client.mint(&user, &amount);
        client.make_payment(meter_id, &user, &amount, &PaymentPlan::UsageBased);
    }

    #[test]
    fn test_batch_update_usage_single() {
        let (env, client, _admin, token_address) = setup_with_token();
        setup_oracle(&env, &client);
        let m1 = symbol_short!("B1_M1");
        register_and_fund(&env, &client, &token_address, &m1, 10_000_i128);

        client.batch_update_usage(&vec![&env, (m1.clone(), 10_u64, 3_000_i128)]);

        assert_eq!(client.get_meter_balance(&m1), 7_000);
        assert_eq!(client.get_meter(&m1).units_used, 10);
        assert!(client.get_meter(&m1).active);
    }

    #[test]
    fn test_batch_update_usage_five_meters() {
        let (env, client, _admin, token_address) = setup_with_token();
        setup_oracle(&env, &client);
        let ids = [
            symbol_short!("B5_M1"),
            symbol_short!("B5_M2"),
            symbol_short!("B5_M3"),
            symbol_short!("B5_M4"),
            symbol_short!("B5_M5"),
        ];
        for id in ids.iter() {
            register_and_fund(&env, &client, &token_address, id, 10_000_i128);
        }

        let mut updates: soroban_sdk::Vec<(Symbol, u64, i128)> = soroban_sdk::Vec::new(&env);
        for id in ids.iter() {
            updates.push_back((id.clone(), 5_u64, 1_000_i128));
        }
        client.batch_update_usage(&updates);

        for id in ids.iter() {
            assert_eq!(client.get_meter_balance(id), 9_000);
            assert_eq!(client.get_meter(id).units_used, 5);
        }
    }

    #[test]
    fn test_batch_update_usage_twenty_meters() {
        let (env, client, _admin, token_address) = setup_with_token();
        setup_oracle(&env, &client);
        let ids = [
            symbol_short!("B20M1"),  symbol_short!("B20M2"),  symbol_short!("B20M3"),
            symbol_short!("B20M4"),  symbol_short!("B20M5"),  symbol_short!("B20M6"),
            symbol_short!("B20M7"),  symbol_short!("B20M8"),  symbol_short!("B20M9"),
            symbol_short!("B20MA"),  symbol_short!("B20MB"),  symbol_short!("B20MC"),
            symbol_short!("B20MD"),  symbol_short!("B20ME"),  symbol_short!("B20MF"),
            symbol_short!("B20MG"),  symbol_short!("B20MH"),  symbol_short!("B20MI"),
            symbol_short!("B20MJ"),  symbol_short!("B20MK"),
        ];
        for id in ids.iter() {
            register_and_fund(&env, &client, &token_address, id, 5_000_i128);
        }

        let mut updates: soroban_sdk::Vec<(Symbol, u64, i128)> = soroban_sdk::Vec::new(&env);
        for id in ids.iter() {
            updates.push_back((id.clone(), 2_u64, 500_i128));
        }
        client.batch_update_usage(&updates);

        for id in ids.iter() {
            assert_eq!(client.get_meter_balance(id), 4_500);
            assert_eq!(client.get_meter(id).units_used, 2);
        }
    }

    #[test]
    fn test_batch_update_usage_drains_and_deactivates() {
        let (env, client, _admin, token_address) = setup_with_token();
        setup_oracle(&env, &client);
        let m1 = symbol_short!("BD_M1");
        let m2 = symbol_short!("BD_M2");
        register_and_fund(&env, &client, &token_address, &m1, 1_000_i128);
        register_and_fund(&env, &client, &token_address, &m2, 5_000_i128);

        client.batch_update_usage(&vec![
            &env,
            (m1.clone(), 1_u64, 1_000_i128),
            (m2.clone(), 1_u64, 500_i128),
        ]);

        assert_eq!(client.get_meter_balance(&m1), 0);
        assert!(!client.get_meter(&m1).active);
        assert_eq!(client.get_meter_balance(&m2), 4_500);
        assert!(client.get_meter(&m2).active);
    }

    #[test]
    fn test_batch_update_usage_skips_invalid_meter() {
        let (env, client, _admin, token_address) = setup_with_token();
        setup_oracle(&env, &client);
        let valid = symbol_short!("BS_V1");
        let invalid = symbol_short!("BS_BAD");
        register_and_fund(&env, &client, &token_address, &valid, 5_000_i128);

        client.batch_update_usage(&vec![
            &env,
            (invalid.clone(), 1_u64, 100_i128),
            (valid.clone(), 2_u64, 200_i128),
        ]);

        assert_eq!(client.get_meter_balance(&valid), 4_800);
        assert_eq!(client.get_meter(&valid).units_used, 2);

        let events = env.events().all();
        let skipped = events.iter().any(|(_, topics, _)| {
            topics.get(0).map(|v| sym_eq(&env, &v, symbol_short!("btch_skip"))).unwrap_or(false)
        });
        assert!(skipped, "batch_skip event not emitted for invalid meter");
    }

    // ── Oracle whitelist tests ────────────────────────────────────────────────

    /// set_oracle stores the address; get_oracle returns it.
    #[test]
    fn test_set_and_get_oracle() {
        let (env, client, _admin, _token_address) = setup_with_token();
        assert_eq!(client.get_oracle(), None);
        let oracle = Address::generate(&env);
        client.set_oracle(&oracle);
        assert_eq!(client.get_oracle(), Some(oracle));
    }

    /// update_usage panics with OracleNotSet when no oracle is registered.
    #[test]
    fn test_update_usage_panics_when_oracle_not_set() {
        let (env, client, _admin, token_address) = setup_with_token();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
        let user = Address::generate(&env);
        let meter_id = symbol_short!("ORC_NS");
        allowlist_and_register(&client, &meter_id, &user);
        token_admin_client.mint(&user, &1_000_i128);
        client.make_payment(&meter_id, &user, &1_000_i128, &PaymentPlan::UsageBased);

        let result = client.try_update_usage(&meter_id, &10_u64, &100_i128);
        assert_eq!(result, Err(Ok(ContractError::OracleNotSet)));
    }

    /// Only the registered oracle can call update_usage; admin alone is not enough.
    #[test]
    fn test_update_usage_succeeds_with_registered_oracle() {
        let (env, client, _admin, token_address) = setup_with_token();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
        setup_oracle(&env, &client);
        let user = Address::generate(&env);
        let meter_id = symbol_short!("ORC_OK");
        allowlist_and_register(&client, &meter_id, &user);
        token_admin_client.mint(&user, &1_000_i128);
        client.make_payment(&meter_id, &user, &1_000_i128, &PaymentPlan::UsageBased);

        client.update_usage(&meter_id, &5_u64, &200_i128);
        assert_eq!(client.get_meter_balance(&meter_id), 800);
        assert_eq!(client.get_meter(&meter_id).units_used, 5);
    }

    /// batch_update_usage panics with OracleNotSet when no oracle is registered.
    #[test]
    fn test_batch_update_usage_panics_when_oracle_not_set() {
        let (env, client, _admin, token_address) = setup_with_token();
        let meter_id = symbol_short!("BON_NS");
        register_and_fund(&env, &client, &token_address, &meter_id, 1_000_i128);

        let result = client.try_batch_update_usage(&vec![&env, (meter_id.clone(), 1_u64, 100_i128)]);
        assert_eq!(result, Err(Ok(ContractError::OracleNotSet)));
    }

    // ── NotInitialized guard tests ────────────────────────────────────────────

    /// Calling an admin function on an uninitialized contract returns NotInitialized.
    #[test]
    fn test_admin_fn_on_uninitialized_contract_returns_not_initialized() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, SolarGridContract);
        let client = SolarGridContractClient::new(&env, &contract_id);
        let user = Address::generate(&env);
        // Contract is not initialized — set_active should return NotInitialized
        let result = client.try_set_active(&symbol_short!("UNINIT"), &true);
        assert_eq!(result, Err(Ok(ContractError::NotInitialized)));
    }

    // ── Migration tests ───────────────────────────────────────────────────────

    /// Simulate a v0→v1 struct upgrade: write a LegacyMeter directly into storage,
    /// call migrate_meter, then verify the entry reads back as a valid v1 Meter.
    #[test]
    fn test_migrate_meter_upgrades_legacy_entry() {
        let (env, client, _admin) = setup();
        let meter_id = symbol_short!("MIG_V0");
        let owner = Address::generate(&env);

        // Write a LegacyMeter (v0) directly into persistent storage, bypassing register_meter.
        let legacy = LegacyMeter {
            owner: owner.clone(),
            active: true,
            balance: 5_000_i128,
            units_used: 42,
            plan: PaymentPlan::UsageBased,
            last_payment: 1_000,
            expires_at: u64::MAX,
        };
        env.as_contract(&client.address, || {
            env.storage()
                .persistent()
                .set(&DataKey::Meter(meter_id.clone()), &legacy);
        });

        // Run the migration.
        client.migrate_meter(&meter_id);

        // The entry should now deserialize as a v1 Meter.
        let meter = client.get_meter(&meter_id);
        assert_eq!(meter.version, 1);
        assert_eq!(meter.owner, owner);
        assert!(meter.active);
        assert_eq!(meter.units_used, 42);
        assert_eq!(meter.plan, PaymentPlan::UsageBased);
        assert_eq!(meter.last_payment, 1_000);
        assert_eq!(meter.expires_at, u64::MAX);
    }
}
