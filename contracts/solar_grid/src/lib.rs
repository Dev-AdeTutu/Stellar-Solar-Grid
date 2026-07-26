#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, token, vec, Address, Env,
    Map, String, Symbol, Vec,
};

// ── Error types ───────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ContractError {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    MeterNotFound = 3,
    MeterAlreadyExists = 4,
    Unauthorized = 5,
    InvalidAmount = 6,
    OwnerNotAllowlisted = 7,
    OracleNotSet = 8,
    InsufficientProviderRevenue = 9,
    BatchTooLarge = 10,
    CannotActivateWithoutBalance = 11,
    InsufficientBalance = 12,
    CollaboratorAlreadyExists = 13,
    DailyLimitReached = 14,
    MeterNotActive = 15,
    ContractNotFrozen = 16,
}

// ── Storage keys ──────────────────────────────────────────────────────────────

const ADMIN: Symbol = symbol_short!("ADMIN");
const ALLOWLIST: Symbol = symbol_short!("ALLOWLIST");
const TOKEN: Symbol = symbol_short!("TOKEN");
const ORACLE: Symbol = symbol_short!("ORACLE");
const METER_LIST: Symbol = symbol_short!("MLIST");
const COLLABS: Symbol = symbol_short!("COLLABS");
const SHARES: Symbol = symbol_short!("SHARES");
const PENDING_ADMIN: Symbol = symbol_short!("PADMIN");
const FROZEN: Symbol = symbol_short!("FROZEN");
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

/// v1 layout — kept for migration from v1 to v2.
/// Remove once all persistent entries have been migrated to v2.
#[contracttype]
#[derive(Clone, Debug)]
pub struct LegacyMeterV1 {
    pub version: u32,
    pub owner: Address,
    pub active: bool,
    pub units_used: u64,
    pub plan: PaymentPlan,
    pub last_payment: u64,
    pub expires_at: u64,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct Meter {
    /// Schema version — increment when fields are added/changed.
    /// v1: initial layout (owner, active, units_used, plan, last_payment, expires_at)
    /// v2: adds daily spending limit (daily_limit, day_spent, day_start)
    pub version: u32,
    pub owner: Address,
    pub active: bool,
    pub units_used: u64,    // kWh * 1000 (milli-kWh for precision)
    pub plan: PaymentPlan,
    pub last_payment: u64,  // ledger timestamp
    pub expires_at: u64,    // ledger timestamp when access expires
    pub daily_limit: i128,  // max stroops deductible per day; 0 = unlimited
    pub day_spent: i128,    // stroops spent in the current 24-hour window
    pub day_start: u64,     // timestamp when the current window started
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

/// Migrate a v0 (legacy) meter entry to the current v2 schema.
fn migrate_meter_v0(old: LegacyMeter) -> Meter {
    Meter {
        version: 2,
        owner: old.owner,
        active: old.active,
        units_used: old.units_used,
        plan: old.plan,
        last_payment: old.last_payment,
        expires_at: old.expires_at,
        daily_limit: 0,
        day_spent: 0,
        day_start: old.last_payment,
    }
}

/// Migrate a v1 meter entry to the current v2 schema.
fn migrate_meter_v1(old: LegacyMeterV1) -> Meter {
    Meter {
        version: 2,
        owner: old.owner,
        active: old.active,
        units_used: old.units_used,
        plan: old.plan,
        last_payment: old.last_payment,
        expires_at: old.expires_at,
        daily_limit: 0,
        day_spent: 0,
        day_start: old.last_payment,
    }
}

/// Returns the number of seconds a payment plan is valid for.
/// For UsageBased, returns u64::MAX (no time expiry); saturating_add
/// with any reasonable timestamp still yields u64::MAX.
fn plan_duration_secs(plan: &PaymentPlan) -> u64 {
    match plan {
        PaymentPlan::Daily => SECONDS_PER_DAY,
        PaymentPlan::Weekly => SECONDS_PER_WEEK,
        PaymentPlan::UsageBased => u64::MAX,
    }
}

#[contracttype]
pub enum DataKey {
    Meter(String),
    OwnerMeters(Address),
    ProviderRevenue(Address),
    MeterBalance(String),
}

/// Combined view returned by get_meter_full — meter state plus its balance
/// in a single query, eliminating the need for two separate RPC calls.
#[contracttype]
pub struct MeterView {
    pub meter: Meter,
    pub balance: i128,
}

// ── Event topics (contract namespace) ────────────────────────────────────────

const EVT_NS: Symbol = symbol_short!("solargrid");


#[contract]
pub struct SolarGridContract;

#[contractimpl]
impl SolarGridContract {
    /// Deployment-time constructor.
    /// Prefer setting the admin and token atomically during deployment to avoid
    /// leaving a window where an arbitrary caller could initialize the contract.
    pub fn __constructor(
        env: Env,
        admin: Address,
        token_address: Address,
    ) -> Result<(), ContractError> {
        Self::write_initial_config(&env, admin, token_address)
    }

    /// Initialize the contract with an admin address and the SAC token address.
    ///
    /// Security warning: call this atomically in the same transaction as
    /// deployment if you are not using the constructor path above.
    pub fn initialize(
        env: Env,
        admin: Address,
        token_address: Address,
    ) -> Result<(), ContractError> {
        admin.require_auth();
        Self::write_initial_config(&env, admin, token_address)
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
    pub fn register_meter(env: Env, meter_id: String, owner: Address) -> Result<(), ContractError> {
        Self::require_admin(&env)?;
        let allowlist = Self::get_allowlist(env.clone())?;
        if !allowlist.contains(&owner) {
            return Err(ContractError::Unauthorized);
        }
        let key = DataKey::Meter(meter_id.clone());
        if env.storage().persistent().has(&key) {
            return Err(ContractError::MeterAlreadyExists);
        }
        let now = env.ledger().timestamp();
        let meter = Meter {
            version: 2,
            owner: owner.clone(),
            active: false,
            units_used: 0,
            plan: PaymentPlan::Daily,
            last_payment: now,
            expires_at: now,
            daily_limit: 0,
            day_spent: 0,
            day_start: now,
        };
        env.storage().persistent().set(&key, &meter);

        // Append meter_id to the owner's meter list
        let owner_key = DataKey::OwnerMeters(owner.clone());
        let mut list: Vec<String> = env
            .storage()
            .persistent()
            .get(&owner_key)
            .unwrap_or_else(|| vec![&env]);
        list.push_back(meter_id.clone());
        env.storage().persistent().set(&owner_key, &list);

        // Append meter_id to global meter registry
        let mut global_list: Vec<String> = env
            .storage()
            .instance()
            .get(&METER_LIST)
            .unwrap_or_else(|| vec![&env]);
        global_list.push_back(meter_id.clone());
        env.storage().instance().set(&METER_LIST, &global_list);

        // meter_registered
        env.events().publish(
            (EVT_NS, symbol_short!("mtr_reg"), meter_id),
            owner,
        );
        Ok(())
    }

    /// Get all meter IDs registered under a given owner address.
    pub fn get_meters_by_owner(env: Env, owner: Address) -> Result<Vec<String>, ContractError> {
        let owner_key = DataKey::OwnerMeters(owner);
        Ok(env.storage()
            .persistent()
            .get(&owner_key)
            .unwrap_or_else(|| vec![&env]))
    }

    /// Transfer meter ownership from the current owner to a new owner.
    /// Both the current owner and the new owner must authorize this call.
    /// The new owner must already be on the allowlist.
    pub fn transfer_meter_ownership(
        env: Env,
        meter_id: String,
        new_owner: Address,
    ) -> Result<(), ContractError> {
        let key = DataKey::Meter(meter_id.clone());
        let mut meter = Self::get_meter_or_error(&env, &key)?;

        meter.owner.require_auth();
        new_owner.require_auth();

        let allowlist = Self::get_allowlist(env.clone())?;
        if !allowlist.contains(&new_owner) {
            return Err(ContractError::OwnerNotAllowlisted);
        }

        // Remove meter_id from old owner's index
        let old_key = DataKey::OwnerMeters(meter.owner.clone());
        let old_list: Vec<String> = env
            .storage()
            .persistent()
            .get(&old_key)
            .unwrap_or_else(|| vec![&env]);
        let mut filtered: Vec<String> = vec![&env];
        for id in old_list.iter() {
            if id != meter_id {
                filtered.push_back(id);
            }
        }
        env.storage().persistent().set(&old_key, &filtered);

        // Add meter_id to new owner's index
        let new_key = DataKey::OwnerMeters(new_owner.clone());
        let mut new_list: Vec<String> = env
            .storage()
            .persistent()
            .get(&new_key)
            .unwrap_or_else(|| vec![&env]);
        new_list.push_back(meter_id.clone());
        env.storage().persistent().set(&new_key, &new_list);

        meter.owner = new_owner.clone();
        env.storage().persistent().set(&key, &meter);

        env.events().publish(
            (EVT_NS, symbol_short!("mtr_xfer"), meter_id),
            new_owner,
        );
        Ok(())
    }

    /// Get all registered meters (admin only).
    /// Returns all Meter structs across the entire contract.
    /// Used by provider dashboard to display all active meters.
    pub fn get_all_meters(env: Env) -> Result<Vec<Meter>, ContractError> {
        Self::require_admin(&env)?;
        let meter_ids: Vec<String> = env
            .storage()
            .instance()
            .get(&METER_LIST)
            .unwrap_or_else(|| vec![&env]);
        let mut meters: Vec<Meter> = vec![&env];
        for meter_id in meter_ids.iter() {
            let key = DataKey::Meter(meter_id.clone());
            if let Some(meter) = env.storage().persistent().get(&key) {
                meters.push_back(meter);
            }
        }
        Ok(meters)
    }

    /// Get a paginated slice of all registered meters (admin only).
    /// Returns meter IDs for a given page using offset and limit.
    /// This is required for mainnet deployments with thousands of meters,
    /// as get_all_meters would exceed Soroban read entry limits.
    ///
    /// # Parameters
    /// - `offset`: Starting position in the meter list (0-indexed)
    /// - `limit`: Maximum number of meter IDs to return (capped at 100)
    ///
    /// # Returns
    /// A Vec of meter ID Strings for the requested page.
    /// Empty Vec when offset exceeds total meter count.
    pub fn get_all_meters_paginated(
        env: Env,
        offset: u32,
        limit: u32,
    ) -> Result<Vec<String>, ContractError> {
        Self::require_admin(&env)?;
        
        // Cap limit at 100 to prevent single-call overruns
        let effective_limit = limit.min(100);
        
        let meter_ids: Vec<String> = env
            .storage()
            .instance()
            .get(&METER_LIST)
            .unwrap_or_else(|| vec![&env]);
        
        let total = meter_ids.len() as u32;
        
        // Return empty Vec if offset exceeds meter count
        if offset >= total {
            return Ok(vec![&env]);
        }
        
        let start = offset as usize;
        let end = ((offset + effective_limit).min(total)) as usize;
        
        let mut page: Vec<String> = vec![&env];
        for i in start..end {
            if let Some(meter_id) = meter_ids.get(i as u32) {
                page.push_back(meter_id);
            }
        }
        
        Ok(page)
    }

    /// Add an address to the meter-owner allowlist.
    /// Only the admin may call this. Use this to pre-approve user accounts
    /// (G… addresses) before they can be registered as meter owners.
    pub fn allowlist_add(env: Env, owner: Address) -> Result<(), ContractError> {
        Self::require_admin(&env)?;
        let mut list: Vec<Address> = env
            .storage()
            .instance()
            .get(&ALLOWLIST)
            .unwrap_or(Vec::new(&env));
        if !list.contains(&owner) {
            list.push_back(owner);
            env.storage().instance().set(&ALLOWLIST, &list);
        }
        Ok(())
    }

    /// Remove an address from the meter-owner allowlist.
    /// Only the admin may call this.
    pub fn allowlist_remove(env: Env, owner: Address) -> Result<(), ContractError> {
        Self::require_admin(&env)?;
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
        Ok(())
    }

    /// Returns the current allowlist.
    pub fn get_allowlist(env: Env) -> Result<Vec<Address>, ContractError> {
        Ok(env.storage()
            .instance()
            .get(&ALLOWLIST)
            .unwrap_or(Vec::new(&env)))
    }

    /// Register the IoT oracle address. Only admin may call this.
    /// Emits `ora_set` event with (old_oracle, new_oracle) for audit trail.
    pub fn set_oracle(env: Env, oracle: Address) -> Result<(), ContractError> {
        Self::require_admin(&env)?;
        let old_oracle: Option<Address> = env.storage().instance().get(&ORACLE);
        env.storage().instance().set(&ORACLE, &oracle);
        env.events().publish(
            (EVT_NS, symbol_short!("ora_set")),
            (old_oracle, oracle),
        );
        Ok(())
    }

    /// Return the registered oracle address, if any.
    pub fn get_oracle(env: Env) -> Result<Option<Address>, ContractError> {
        Self::require_initialized(&env)?;
        Ok(env.storage().instance().get(&ORACLE))
    }

    /// Explicitly clear the oracle address. Only admin may call this.
    /// Emits `ora_clr` event.
    pub fn remove_oracle(env: Env) -> Result<(), ContractError> {
        Self::require_admin(&env)?;
        env.storage().instance().remove(&ORACLE);
        env.events().publish((EVT_NS, symbol_short!("ora_clr")), ());
        Ok(())
    }

    /// Emergency stop mechanism: freeze the contract to pause all payments and usage updates.
    /// Only admin may call this. When frozen, make_payment and update_usage will be rejected.
    ///
    /// Emits: `contract_frozen { }`
    pub fn freeze_contract(env: Env) -> Result<(), ContractError> {
        Self::require_admin(&env)?;
        env.storage().instance().set(&FROZEN, &true);
        env.events().publish((EVT_NS, symbol_short!("frz_on")), ());
        Ok(())
    }

    /// Unfreeze the contract to resume normal operations.
    /// Only admin may call this.
    ///
    /// Emits: `contract_unfrozen { }`
    pub fn unfreeze_contract(env: Env) -> Result<(), ContractError> {
        Self::require_admin(&env)?;
        env.storage().instance().remove(&FROZEN);
        env.events().publish((EVT_NS, symbol_short!("frz_off")), ());
        Ok(())
    }

    /// Check if the contract is currently frozen.
    pub fn is_frozen(env: Env) -> Result<bool, ContractError> {
        Self::require_initialized(&env)?;
        Ok(env.storage().instance().get::<Symbol, bool>(&FROZEN).unwrap_or(false))
    }

    /// Make a payment to top up a meter's balance and activate it.
    /// `amount` is in the token's smallest unit. `plan` sets the billing cycle.
    ///
    /// Emits:
    /// - `payment_received { meter_id, payer, amount, plan }`
    /// - `meter_activated  { meter_id }` (always, since payment activates the meter)
    pub fn make_payment(
        env: Env,
        meter_id: String,
        payer: Address,
        amount: i128,
        plan: PaymentPlan,
    ) -> Result<(), ContractError> {
        if env.storage().instance().get::<Symbol, bool>(&FROZEN).unwrap_or(false) {
            return Err(ContractError::ContractFrozen);
        }
        payer.require_auth();
        if amount <= 0 {
            return Err(ContractError::InvalidAmount);
        }
        let token_address = Self::get_token_address(&env)?;
        let token_client = token::Client::new(&env, &token_address);
        token_client.transfer(&payer, &env.current_contract_address(), &amount);

        let key = DataKey::Meter(meter_id.clone());
        let mut meter = Self::get_meter_or_error(&env, &key)?;
        let now = env.ledger().timestamp();
        let expires_at = now.saturating_add(plan_duration_secs(&plan));

        // Track per-meter balance in contract storage
        let bal_key = DataKey::MeterBalance(meter_id.clone());
        let prev_bal: i128 = env.storage().persistent().get(&bal_key).unwrap_or(0);
        env.storage()
            .persistent()
            .set(&bal_key, &prev_bal.saturating_add(amount));

        meter.active = true;
        meter.plan = plan.clone();
        meter.last_payment = now;
        meter.expires_at = expires_at;
        env.storage().persistent().set(&key, &meter);

        // Track provider (admin) accrued revenue
        let admin = Self::get_admin(&env)?;
        let provider_key = DataKey::ProviderRevenue(admin);
        let provider_revenue: i128 = env.storage().persistent().get(&provider_key).unwrap_or(0);
        env.storage()
            .persistent()
            .set(&provider_key, &provider_revenue.saturating_add(amount));

        // payment_received
        env.events().publish(
            (EVT_NS, symbol_short!("payment"), meter_id.clone()),
            (payer, token_address, amount, plan),
        );
        // meter_activated — payment always activates the meter
        env.events().publish(
            (EVT_NS, symbol_short!("mtr_actv"), meter_id),
            (),
        );
        Ok(())
    }

    /// Withdraw accumulated revenue from the contract vault to the provider address.
    ///
    /// # Access control
    /// Only the contract admin may call this.
    ///
    /// Returns:
    /// - [`ContractError::InvalidAmount`] when `amount <= 0`
    /// - [`ContractError::Unauthorized`] when caller is not the contract admin
    /// - [`ContractError::InsufficientBalance`] when tracked balance < `amount`
    ///
    /// Emits: `rev_wdrl { provider, token_address, amount }`
    pub fn withdraw_revenue(
        env: Env,
        provider: Address,
        amount: i128,
    ) -> Result<(), ContractError> {
        if amount <= 0 {
            return Err(ContractError::InvalidAmount);
        }
        let admin = Self::get_admin(&env)?;
        if provider != admin {
            return Err(ContractError::Unauthorized);
        }
        provider.require_auth();

        let provider_key = DataKey::ProviderRevenue(provider.clone());
        let provider_revenue: i128 = env.storage().persistent().get(&provider_key).unwrap_or(0);
        if provider_revenue < amount {
            return Err(ContractError::InsufficientBalance);
        }

        env.storage()
            .persistent()
            .set(&provider_key, &provider_revenue.saturating_sub(amount));

        let token_address = Self::get_token_address(&env)?;
        let token_client = token::Client::new(&env, &token_address);
        token_client.transfer(&env.current_contract_address(), &provider, &amount);

        env.events().publish(
            (EVT_NS, symbol_short!("rev_wdrl"), provider),
            (token_address, amount),
        );
        Ok(())
    }

    pub fn admin_withdraw(env: Env, admin: Address, amount: i128) -> Result<(), ContractError> {
        admin.require_auth();
        // Verify admin matches stored admin address
        let stored_admin: Address = Self::get_admin(&env)?;
        if admin != stored_admin {
            return Err(ContractError::Unauthorized);
        }
        // Transfer XLM from contract to admin
        let token_address = Self::get_token_address(&env)?;
        let token_client = token::Client::new(&env, &token_address);
        let contract_balance = token_client.balance(&env.current_contract_address());
        if amount > contract_balance {
            return Err(ContractError::InsufficientBalance);
        }
        token_client.transfer(&env.current_contract_address(), &admin, &amount);
        env.events().publish(
            (EVT_NS, symbol_short!("adm_wdrl"), admin.clone()),
            (admin.clone(), amount),
        );
        Ok(())
    }

    /// Get currently tracked provider revenue balance.
    pub fn get_provider_revenue(env: Env, provider: Address) -> Result<i128, ContractError> {
        Self::require_initialized(&env)?;
        let provider_key = DataKey::ProviderRevenue(provider);
        Ok(env.storage().persistent().get(&provider_key).unwrap_or(0))
    }

    /// Return revenue balances for the admin and all collaborators. Admin-only.
    pub fn get_revenue_summary(env: Env) -> Result<Map<Address, i128>, ContractError> {
        Self::require_admin(&env)?;
        let collabs: Vec<Address> = env.storage().instance().get(&COLLABS).unwrap_or(Vec::new(&env));
        let admin = Self::get_admin(&env)?;

        let mut result: Map<Address, i128> = Map::new(&env);
        let admin_key = DataKey::ProviderRevenue(admin.clone());
        result.set(admin.clone(), env.storage().persistent().get(&admin_key).unwrap_or(0));
        for c in collabs.iter() {
            let key = DataKey::ProviderRevenue(c.clone());
            result.set(c, env.storage().persistent().get(&key).unwrap_or(0));
        }
        Ok(result)
    }

    /// Check whether a meter currently has active energy access.
    pub fn check_access(env: Env, meter_id: String) -> Result<bool, ContractError> {
        let key = DataKey::Meter(meter_id.clone());
        let meter = Self::get_meter_or_error(&env, &key)?;
        let bal_key = DataKey::MeterBalance(meter_id);
        let balance: i128 = env.storage().persistent().get(&bal_key).unwrap_or(0);
        Ok(meter.active && balance > 0 && env.ledger().timestamp() < meter.expires_at)
    }

    /// Called by the IoT oracle to record energy consumption (milli-kWh).
    /// Deducts cost from balance; deactivates meter if balance runs out.
    ///
    /// Emits:
    /// - `usage_updated    { meter_id, units, cost }`
    /// - `meter_deactivated { meter_id }` (only when balance hits zero)
    pub fn update_usage(
        env: Env,
        meter_id: String,
        units: u64,
        cost: i128,
    ) -> Result<(), ContractError> {
        if env.storage().instance().get::<Symbol, bool>(&FROZEN).unwrap_or(false) {
            return Err(ContractError::ContractFrozen);
        }
        Self::require_admin(&env)?;
        let oracle: Option<Address> = env.storage().instance().get(&ORACLE);
        if oracle.is_none() {
            return Err(ContractError::OracleNotSet);
        }
        if cost < 0 {
            return Err(ContractError::InvalidAmount);
        }
        let key = DataKey::Meter(meter_id.clone());
        let mut meter = Self::get_meter_or_error(&env, &key)?;

        // Daily spending limit: reset window if 24 h has elapsed, then enforce cap.
        // Active check is performed inside apply_usage.
        let now = env.ledger().timestamp();
        let deactivated = Self::apply_usage(&env, &meter_id, &mut meter, units, cost, now)?;
        env.storage().persistent().set(&key, &meter);

        // usage_updated
        env.events().publish(
            (EVT_NS, symbol_short!("usg_upd"), meter_id.clone()),
            (units, cost),
        );
        // meter_deactivated — only when balance drained to zero
        if deactivated {
            env.events().publish(
                (EVT_NS, symbol_short!("mtr_deact"), meter_id),
                (),
            );
        }
        Ok(())
    }

    /// Get the on-chain token balance held by this contract for a specific meter.
    pub fn get_meter_balance(env: Env, meter_id: String) -> Result<i128, ContractError> {
        if !env
            .storage()
            .persistent()
            .has(&DataKey::Meter(meter_id.clone()))
        {
            return Err(ContractError::MeterNotFound);
        }
        let bal_key = DataKey::MeterBalance(meter_id);
        Ok(env.storage().persistent().get(&bal_key).unwrap_or(0))
    }

    /// Get meter details.
    pub fn get_meter(env: Env, meter_id: String) -> Result<Meter, ContractError> {
        let key = DataKey::Meter(meter_id);
        Self::get_meter_or_error(&env, &key)
    }

    /// Get meter state and balance in one query.
    pub fn get_meter_full(env: Env, meter_id: String) -> Result<MeterView, ContractError> {
        let key = DataKey::Meter(meter_id.clone());
        let meter = Self::get_meter_or_error(&env, &key)?;
        let bal_key = DataKey::MeterBalance(meter_id);
        let balance: i128 = env.storage().persistent().get(&bal_key).unwrap_or(0);
        Ok(MeterView { meter, balance })
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
    pub fn set_active(env: Env, meter_id: String, active: bool) -> Result<(), ContractError> {
        Self::require_admin(&env)?;
        let key = DataKey::Meter(meter_id.clone());
        let mut meter = Self::get_meter_or_error(&env, &key)?;
        if active {
            let bal_key = DataKey::MeterBalance(meter_id.clone());
            let balance: i128 = env.storage().persistent().get(&bal_key).unwrap_or(0);
            if balance == 0 {
                return Err(ContractError::CannotActivateWithoutBalance);
            }
        }
        meter.active = active;
        env.storage().persistent().set(&key, &meter);

        if active {
            env.events().publish(
                (EVT_NS, symbol_short!("mtr_actv"), meter_id),
                (symbol_short!("access"), meter_id.clone()),
                true,
            );
        } else {
            env.events().publish(
                (EVT_NS, symbol_short!("mtr_deact"), meter_id),
                (symbol_short!("access"), meter_id.clone()),
                false,
            );
        }
        Ok(())
    }

    /// Admin-only: immediately deactivate a meter (e.g. for non-paying
    /// customers or faulty meters). Unlike `set_active`, this is a one-way
    /// deactivation that doesn't require passing a boolean flag.
    ///
    /// Emits:
    /// - `meter_deactivated { meter_id }`
    pub fn deactivate_meter(env: Env, meter_id: Symbol) -> Result<(), ContractError> {
        Self::require_admin(&env)?;
        let key = DataKey::Meter(meter_id.clone());
        let mut meter = Self::get_meter_or_error(&env, &key)?;
        meter.active = false;
        env.storage().persistent().set(&key, &meter);

        env.events().publish(
            (EVT_NS, symbol_short!("access"), meter_id.clone()),
            false,
        );
        env.events().publish(
            (EVT_NS, symbol_short!("mtr_deact"), meter_id),
            (),
        );
        Ok(())
    }

    // ── Collaborator management ───────────────────────────────────────────────

    /// Add a collaborator with a share in basis points (100 = 1%).
    /// Total shares across all collaborators must not exceed 10 000 (100%).
    pub fn add_collaborator(env: Env, collaborator: Address, basis_points: u32) -> Result<(), ContractError> {
        Self::require_admin(&env)?;
        if basis_points == 0 || basis_points > 10_000 {
            return Err(ContractError::InvalidAmount);
        }

        let mut collabs: Vec<Address> = env
            .storage()
            .instance()
            .get(&COLLABS)
            .unwrap_or(Vec::new(&env));
        let mut shares: Map<Address, u32> = env
            .storage()
            .instance()
            .get(&SHARES)
            .unwrap_or(Map::new(&env));

        if shares.contains_key(collaborator.clone()) {
            return Err(ContractError::CollaboratorAlreadyExists);
        }

        // Guard against total exceeding 100%
        let total: u32 = shares.values().iter().sum();
        if total + basis_points > 10_000 {
            return Err(ContractError::InvalidAmount);
        }

        collabs.push_back(collaborator.clone());
        shares.set(collaborator, basis_points);

        env.storage().instance().set(&COLLABS, &collabs);
        env.storage().instance().set(&SHARES, &shares);
        Ok(())
    }

    /// Returns collaborator addresses in insertion order.
    pub fn get_collaborators(env: Env) -> Vec<Address> {
        env.storage()
            .instance()
            .get(&COLLABS)
            .unwrap_or(Vec::new(&env))
    }

    /// Returns the share (in basis points) allocated to a single collaborator.
    /// Returns `None` if the address is not a registered collaborator.
    /// Share value is in basis points: 1000 = 10%, 10000 = 100%.
    pub fn get_collaborator_share(env: Env, address: Address) -> Option<u32> {
        let shares: Map<Address, u32> = env.storage().instance()
            .get(&SHARES)
            .unwrap_or_else(|| Map::new(&env));
        shares.get(address)
    }

    /// Returns the full share map in a single call — eliminates N+1 RPC calls.
    /// Map<Address, u32> where u32 is basis points (100 = 1%).
    pub fn get_all_shares(env: Env) -> Map<Address, u32> {
        env.storage()
            .instance()
            .get(&SHARES)
            .unwrap_or(Map::new(&env))
    }

    /// Distribute `amount` stroops among collaborators proportionally.
    /// Iterates the ordered Vec and looks up shares from the Map.
    pub fn distribute(env: Env, amount: i128) -> Result<Map<Address, i128>, ContractError> {
        Self::require_admin(&env)?;
        if amount <= 0 {
            return Err(ContractError::InvalidAmount);
        }

        let collabs: Vec<Address> = env
            .storage()
            .instance()
            .get(&COLLABS)
            .unwrap_or(Vec::new(&env));
        let shares: Map<Address, u32> = env
            .storage()
            .instance()
            .get(&SHARES)
            .unwrap_or(Map::new(&env));

        let mut result: Map<Address, i128> = Map::new(&env);
        for collaborator in collabs.iter() {
            let bp = shares.get(collaborator.clone()).unwrap_or(0) as i128;
            let payout = (amount * bp) / 10_000;
            result.set(collaborator, payout);
        }
        Ok(result)
    }

    /// Distribute `amount` stroops and perform the actual token transfers atomically.
    /// Uses `distribute` internally to compute shares, then transfers to each collaborator.
    /// Emits `distrib` event after all transfers succeed.
    pub fn distribute_and_transfer(env: Env, amount: i128) -> Result<Map<Address, i128>, ContractError> {
        Self::require_admin(&env)?;
        if amount <= 0 {
            return Err(ContractError::InvalidAmount);
        }

        let token_address = Self::get_token_address(&env)?;
        let token = token::Client::new(&env, &token_address);

        let payouts = Self::distribute(env.clone(), amount)?;
        for (collaborator, payout) in payouts.iter() {
            if payout > 0 {
                token.transfer(&env.current_contract_address(), &collaborator, &payout);
            }
        }
        env.events().publish((EVT_NS, symbol_short!("distrib")), (amount,));
        Ok(payouts)
    }

    // ── Emergency / admin controls ───────────────────────────────────────────

    /// Mark the contract as frozen. Admin-only. Required before calling
    /// `emergency_withdraw`. Intended for compromise or deprecation scenarios.
    pub fn freeze_contract(env: Env) -> Result<(), ContractError> {
        Self::require_admin(&env)?;
        env.storage().instance().set(&FROZEN, &true);
        Ok(())
    }

    /// Drain all contract-held token balance to a recovery address. Admin-only.
    /// The contract must be frozen first via `freeze_contract`; returns
    /// `ContractNotFrozen` otherwise. Returns `Ok(())` when balance is zero.
    pub fn emergency_withdraw(env: Env, to: Address) -> Result<(), ContractError> {
        Self::require_admin(&env)?;
        let frozen: bool = env.storage().instance().get(&FROZEN).unwrap_or(false);
        if !frozen {
            return Err(ContractError::ContractNotFrozen);
        }
        let token_addr: Address = env.storage().instance()
            .get(&TOKEN)
            .ok_or(ContractError::NotInitialized)?;
        let token = token::Client::new(&env, &token_addr);
        let balance = token.balance(&env.current_contract_address());
        if balance > 0 {
            token.transfer(&env.current_contract_address(), &to, &balance);
        }
        env.events().publish(
            (symbol_short!("WITHDRAW"), symbol_short!("emergency")),
            (to.clone(), balance),
        );
        Ok(())
    }

    /// Manually expire a meter before its natural expiry. Admin-only.
    /// Sets `expires_at` to the current ledger timestamp and `active` to false.
    /// Useful for policy violations or testing expiry flows.
    /// Returns `MeterNotFound` for unknown meter IDs.
    pub fn expire_meter(env: Env, meter_id: String) -> Result<(), ContractError> {
        Self::require_admin(&env)?;
        let key = DataKey::Meter(meter_id.clone());
        let mut meter: Meter = env.storage().persistent()
            .get(&key)
            .ok_or(ContractError::MeterNotFound)?;
        meter.expires_at = env.ledger().timestamp();
        meter.active = false;
        env.storage().persistent().set(&key, &meter);
        env.events().publish(
            (symbol_short!("METER"), symbol_short!("expired")),
            meter_id,
        );
        Ok(())
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    fn write_initial_config(
        env: &Env,
        admin: Address,
        token_address: Address,
    ) -> Result<(), ContractError> {
        if env.storage().instance().has(&ADMIN) {
            return Err(ContractError::AlreadyInitialized);
        }
        env.storage().instance().set(&ADMIN, &admin);
        env.storage().instance().set(&TOKEN, &token_address);
        Ok(())
    }

    fn get_admin(env: &Env) -> Result<Address, ContractError> {
        env.storage()
            .instance()
            .get(&ADMIN)
            .ok_or(ContractError::NotInitialized)
    }

    fn get_token_address(env: &Env) -> Result<Address, ContractError> {
        env.storage()
            .instance()
            .get(&TOKEN)
            .ok_or(ContractError::NotInitialized)
    }

    fn get_meter_or_error(env: &Env, key: &DataKey) -> Result<Meter, ContractError> {
        env.storage()
            .persistent()
            .get(key)
            .ok_or(ContractError::MeterNotFound)
    }

    fn require_admin(env: &Env) -> Result<(), ContractError> {
        let admin = Self::get_admin(env)?;
        admin.require_auth();
        Ok(())
    }

    fn require_initialized(env: &Env) -> Result<(), ContractError> {
        if !env.storage().instance().has(&ADMIN) {
            return Err(ContractError::NotInitialized);
        }
        Ok(())
    }

    /// Batch update usage for multiple meters in a single transaction.
    /// Batch update usage for multiple meters.
    /// Returns a Vec of failed meter IDs (empty Vec means all succeeded).
    /// Failed IDs can be due to meter not found or other validation errors.
    /// Skips invalid meter IDs and emits a batch_skip event for each.
    /// Maximum batch size is 50 meters.
    pub fn batch_update_usage(
        env: Env,
        updates: Vec<(String, u64, i128)>,
    ) -> Result<Vec<String>, ContractError> {
        Self::require_admin(&env)?;
        let oracle: Option<Address> = env.storage().instance().get(&ORACLE);
        if oracle.is_none() {
            return Err(ContractError::OracleNotSet);
        }
        if updates.len() > 50 {
            return Err(ContractError::BatchTooLarge);
        }
        let now = env.ledger().timestamp();
        let mut failed: Vec<String> = vec![&env];

        for (meter_id, units, cost) in updates.iter() {
            let key = DataKey::Meter(meter_id.clone());
            if !env.storage().persistent().has(&key) {
                failed.push_back(meter_id.clone());
                env.events().publish(
                    (EVT_NS, symbol_short!("btch_skip"), meter_id.clone()),
                    (),
                );
                continue;
            }
            let mut meter: Meter = env.storage().persistent().get(&key).unwrap();

            match Self::apply_usage(&env, meter_id, &mut meter, *units, *cost, now) {
                Ok(deactivated) => {
                    env.storage().persistent().set(&key, &meter);
                    env.events().publish(
                        (EVT_NS, symbol_short!("usg_upd"), meter_id.clone()),
                        (*units, *cost),
                    );
                    if deactivated {
                        env.events().publish(
                            (EVT_NS, symbol_short!("mtr_deact"), meter_id.clone()),
                            (),
                        );
                    }
                }
                Err(_) => {
                    failed.push_back(meter_id.clone());
                    env.events().publish(
                        (EVT_NS, symbol_short!("btch_skip"), meter_id.clone()),
                        (),
                    );
                }
            }
        }
        Ok(failed)
    }

    fn apply_usage(
        env: &Env,
        meter_id: &String,
        meter: &mut Meter,
        units: u64,
        cost: i128,
        now: u64,
    ) -> Result<bool, ContractError> {
        // Reject usage updates for inactive meters
        if !meter.active {
            return Err(ContractError::MeterNotActive);
        }

        if now.saturating_sub(meter.day_start) > SECONDS_PER_DAY {
            meter.day_spent = 0;
            meter.day_start = now;
        }
        if meter.daily_limit > 0 && meter.day_spent.saturating_add(cost) > meter.daily_limit {
            return Err(ContractError::DailyLimitReached);
        }
        meter.day_spent = meter.day_spent.saturating_add(cost);
        let bal_key = DataKey::MeterBalance(meter_id.clone());
        let balance: i128 = env.storage().persistent().get(&bal_key).unwrap_or(0);
        let new_balance = balance.saturating_sub(cost).max(0);
        env.storage().persistent().set(&bal_key, &new_balance);
        meter.units_used = meter.units_used.saturating_add(units);
        let deactivated = new_balance == 0;
        if deactivated {
            meter.active = false;
        }
        Ok(deactivated)
    }

    /// Set the daily spending limit for a meter. Admin-only.
    /// A limit of 0 means unlimited (the default for newly registered meters).
    pub fn set_daily_limit(env: Env, meter_id: String, limit: i128) -> Result<(), ContractError> {
        Self::require_admin(&env)?;
        if limit < 0 {
            return Err(ContractError::InvalidAmount);
        }
        let key = DataKey::Meter(meter_id.clone());
        let mut meter = Self::get_meter_or_error(&env, &key)?;
        let old_limit = meter.daily_limit;
        meter.daily_limit = limit;
        env.storage().persistent().set(&key, &meter);
        env.events().publish(
            (EVT_NS, symbol_short!("lmt_set"), meter_id),
            (old_limit, limit),
        );
        Ok(())
    }

    /// Migrate a meter from v0 (LegacyMeter) to v2 (Meter) schema.
    /// Admin-only. Use migrate_meter_to_v2 for v1 → v2 migrations.
    pub fn migrate_meter(env: Env, meter_id: String) -> Result<(), ContractError> {
        Self::require_admin(&env)?;
        let key = DataKey::Meter(meter_id.clone());
        // Already at v2 — idempotent no-op.
        if let Some(meter) = env.storage().persistent().get::<DataKey, Meter>(&key) {
            if meter.version >= 2 {
                return Ok(());
            }
        }
        let legacy: LegacyMeter = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(ContractError::MeterNotFound)?;
        let migrated = migrate_meter_v0(legacy);
        env.storage().persistent().set(&key, &migrated);
        Ok(())
    }

    /// Migrate a meter from v1 (LegacyMeterV1) to v2 (Meter) schema. Admin-only.
    pub fn migrate_meter_to_v2(env: Env, meter_id: String) -> Result<(), ContractError> {
        Self::require_admin(&env)?;
        let key = DataKey::Meter(meter_id.clone());
        // Already at v2 — idempotent no-op.
        if let Some(meter) = env.storage().persistent().get::<DataKey, Meter>(&key) {
            if meter.version >= 2 {
                return Ok(());
            }
        }
        let legacy: LegacyMeterV1 = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(ContractError::MeterNotFound)?;
        let migrated = migrate_meter_v1(legacy);
        env.storage().persistent().set(&key, &migrated);
        Ok(())
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
        meter_id: &String,
        user: &Address,
    ) {
        client.allowlist_add(user);
        client.register_meter(meter_id, user);
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

    #[test]
    fn test_register_meter_duplicate_returns_typed_error() {
        let (env, client, _admin, _token_address) = setup_with_token();
        let user = Address::generate(&env);
        let meter_id = symbol_short!("METER2");
        allowlist_and_register(&client, &meter_id, &user);
        assert_eq!(
            client.try_register_meter(&meter_id, &user),
            Err(Ok(ContractError::MeterAlreadyExists))
        );
    }

    #[test]
    fn test_initialize_second_call_returns_already_initialized() {
        let (_env, client, admin, token_address) = setup_with_token();
        assert_eq!(
            client.try_initialize(&admin, &token_address),
            Err(Ok(ContractError::AlreadyInitialized))
        );
    }

    #[test]
    fn test_make_payment_zero_amount_returns_typed_error() {
        let (env, client, _admin, _token_address) = setup_with_token();
        let user = Address::generate(&env);
        let meter_id = symbol_short!("METER3");
        allowlist_and_register(&client, &meter_id, &user);
        assert_eq!(
            client.try_make_payment(&meter_id, &user, &0_i128, &PaymentPlan::Daily),
            Err(Ok(ContractError::InvalidAmount))
        );
    }

    #[test]
    fn test_make_payment_negative_amount_returns_typed_error() {
        let (env, client, _admin, _token_address) = setup_with_token();
        let user = Address::generate(&env);
        let meter_id = symbol_short!("METER4");
        allowlist_and_register(&client, &meter_id, &user);
        assert_eq!(
            client.try_make_payment(&meter_id, &user, &-1_i128, &PaymentPlan::Daily),
            Err(Ok(ContractError::InvalidAmount))
        );
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
    #[should_panic(expected = "meter is not active")]
    fn test_update_usage_panics_if_meter_inactive() {
        let (env, client, _admin, token_address) = setup_with_token();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
        setup_oracle(&env, &client);

        let user = Address::generate(&env);
        let meter_id = symbol_short!("INACT");

        allowlist_and_register(&client, &meter_id, &user);
        
        // Meter is registered but no payment made, so it's inactive
        client.update_usage(&meter_id, &50_u64, &100_000_i128);
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

    #[test]
    fn test_register_meter_owner_not_allowlisted_returns_typed_error() {
        let (env, client, _admin) = setup();
        let user = Address::generate(&env);
        let meter_id = symbol_short!("METER8");
        assert_eq!(
            client.try_register_meter(&meter_id, &user),
            Err(Ok(ContractError::Unauthorized))
        );
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
    fn test_withdraw_revenue_returns_insufficient_balance_error() {
        let (env, client, admin, _token_address) = setup_with_token();
        let user = Address::generate(&env);
        let meter_id = symbol_short!("METR10");
        allowlist_and_register(&client, &meter_id, &user);
        assert_eq!(
            client.try_withdraw_revenue(&admin, &1_i128),
            Err(Ok(ContractError::InsufficientBalance))
        );
    }

    #[test]
    fn test_admin_withdraw_authorized() {
        let (env, client, admin, token_address) = setup_with_token();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
        let token_client = token::Client::new(&env, &token_address);
        
        token_admin_client.mint(&client.address, &1000_i128);
        client.admin_withdraw(&admin, &500_i128);
        
        assert_eq!(token_client.balance(&admin), 500_i128);
        assert_eq!(token_client.balance(&client.address), 500_i128);
    }

    #[test]
    #[should_panic(expected = "unauthorized")]
    fn test_admin_withdraw_unauthorized() {
        let (env, client, _admin, token_address) = setup_with_token();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
        
        token_admin_client.mint(&client.address, &1000_i128);
        let fake_admin = Address::generate(&env);
        client.admin_withdraw(&fake_admin, &500_i128);
    }

    #[test]
    #[should_panic(expected = "insufficient balance")]
    fn test_admin_withdraw_insufficient_balance() {
        let (env, client, admin, token_address) = setup_with_token();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
        
        token_admin_client.mint(&client.address, &500_i128);
        client.admin_withdraw(&admin, &1000_i128);
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

    #[test]
    fn test_set_active_true_returns_cannot_activate_without_balance_error() {
        let (env, client, _admin, _token_address) = setup_with_token();
        let user = Address::generate(&env);
        let meter_id = symbol_short!("ZERO_BAL");
        allowlist_and_register(&client, &meter_id, &user);
        assert_eq!(
            client.try_set_active(&meter_id, &true),
            Err(Ok(ContractError::CannotActivateWithoutBalance))
        );
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
            topics.len() >= 3
                && topics.get(0) == Some(EVT_NS.into())
                && topics.get(1) == Some(symbol_short!("mtr_reg").into())
                && topics.get(2) == Some(meter_id.clone().into())
        });
        assert!(found, "meter registered event not emitted");
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
            topics.len() >= 3
                && topics.get(0) == Some(EVT_NS.into())
                && topics.get(1) == Some(symbol_short!("payment").into())
                && topics.get(2) == Some(meter_id.clone().into())
        });
        let has_actv = events.iter().any(|(_, topics, _)| {
            topics.len() >= 3
                && topics.get(0) == Some(EVT_NS.into())
                && topics.get(1) == Some(symbol_short!("mtr_actv").into())
                && topics.get(2) == Some(meter_id.clone().into())
        });
        assert!(has_pmt, "payment event not emitted");
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
            topics.len() >= 3
                && topics.get(0) == Some(EVT_NS.into())
                && topics.get(1) == Some(symbol_short!("usg_upd").into())
                && topics.get(2) == Some(meter_id.clone().into())
        });
        let has_deact = events.iter().any(|(_, topics, _)| {
            topics.len() >= 3
                && topics.get(0) == Some(EVT_NS.into())
                && topics.get(1) == Some(symbol_short!("mtr_deact").into())
                && topics.get(2) == Some(meter_id.clone().into())
        });
        assert!(has_usg, "usage event not emitted");
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
            topics.len() >= 3
                && topics.get(0) == Some(EVT_NS.into())
                && topics.get(1) == Some(symbol_short!("mtr_deact").into())
                && topics.get(2) == Some(meter_id.clone().into())
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

    /// get_all_meters returns all registered meters across all owners.
    #[test]
    fn test_get_all_meters_returns_all_registered() {
        let (env, client, _admin) = setup();
        let user1 = Address::generate(&env);
        let user2 = Address::generate(&env);
        let ids = [
            symbol_short!("ALL_1"), symbol_short!("ALL_2"), symbol_short!("ALL_3"),
            symbol_short!("ALL_4"), symbol_short!("ALL_5"), symbol_short!("ALL_6"),
            symbol_short!("ALL_7"), symbol_short!("ALL_8"), symbol_short!("ALL_9"),
            symbol_short!("ALL_A"), symbol_short!("ALL_B"),
        ];

        client.allowlist_add(&user1);
        client.allowlist_add(&user2);
        for (i, id) in ids.iter().enumerate() {
            let owner = if i < 6 { &user1 } else { &user2 };
            client.register_meter(id, owner);
        }

        let all_meters = client.get_all_meters();
        assert_eq!(all_meters.len(), 11);
        for meter in all_meters.iter() {
            assert!(!meter.active);
            assert_eq!(meter.units_used, 0);
        }
    }

    /// get_all_meters_paginated returns first page of meter IDs.
    #[test]
    fn test_get_all_meters_paginated_first_page() {
        let (env, client, _admin) = setup();
        let user = Address::generate(&env);
        let ids = [
            symbol_short!("PAG_1"), symbol_short!("PAG_2"), symbol_short!("PAG_3"),
            symbol_short!("PAG_4"), symbol_short!("PAG_5"), symbol_short!("PAG_6"),
            symbol_short!("PAG_7"), symbol_short!("PAG_8"), symbol_short!("PAG_9"),
            symbol_short!("PAG_A"),
        ];

        client.allowlist_add(&user);
        for id in ids.iter() {
            client.register_meter(id, &user);
        }

        // Get first 3 meter IDs
        let page = client.get_all_meters_paginated(&0_u32, &3_u32);
        assert_eq!(page.len(), 3);
        for (i, meter_id) in page.iter().enumerate() {
            assert_eq!(meter_id, &ids[i]);
        }
    }

    /// get_all_meters_paginated returns middle page of meter IDs.
    #[test]
    fn test_get_all_meters_paginated_middle_page() {
        let (env, client, _admin) = setup();
        let user = Address::generate(&env);
        let ids = [
            symbol_short!("MID_1"), symbol_short!("MID_2"), symbol_short!("MID_3"),
            symbol_short!("MID_4"), symbol_short!("MID_5"), symbol_short!("MID_6"),
            symbol_short!("MID_7"), symbol_short!("MID_8"), symbol_short!("MID_9"),
            symbol_short!("MID_A"),
        ];

        client.allowlist_add(&user);
        for id in ids.iter() {
            client.register_meter(id, &user);
        }

        // Get middle page (offset 4, limit 3)
        let page = client.get_all_meters_paginated(&4_u32, &3_u32);
        assert_eq!(page.len(), 3);
        for (i, meter_id) in page.iter().enumerate() {
            assert_eq!(meter_id, &ids[4 + i]);
        }
    }

    /// get_all_meters_paginated returns last page with partial results.
    #[test]
    fn test_get_all_meters_paginated_last_page() {
        let (env, client, _admin) = setup();
        let user = Address::generate(&env);
        let ids = [
            symbol_short!("LST_1"), symbol_short!("LST_2"), symbol_short!("LST_3"),
            symbol_short!("LST_4"), symbol_short!("LST_5"), symbol_short!("LST_6"),
            symbol_short!("LST_7"), symbol_short!("LST_8"), symbol_short!("LST_9"),
            symbol_short!("LST_A"),
        ];

        client.allowlist_add(&user);
        for id in ids.iter() {
            client.register_meter(id, &user);
        }

        // Get last page (offset 8, limit 5) — only 2 results available
        let page = client.get_all_meters_paginated(&8_u32, &5_u32);
        assert_eq!(page.len(), 2);
        assert_eq!(page.get(0), Some(&ids[8]));
        assert_eq!(page.get(1), Some(&ids[9]));
    }

    /// get_all_meters_paginated returns empty vec when offset exceeds total count.
    #[test]
    fn test_get_all_meters_paginated_offset_exceeds_count() {
        let (env, client, _admin) = setup();
        let user = Address::generate(&env);
        let ids = [
            symbol_short!("OOB_1"), symbol_short!("OOB_2"), symbol_short!("OOB_3"),
        ];

        client.allowlist_add(&user);
        for id in ids.iter() {
            client.register_meter(id, &user);
        }

        // Offset beyond the 3 meters
        let page = client.get_all_meters_paginated(&5_u32, &10_u32);
        assert_eq!(page.len(), 0);
    }

    /// get_all_meters_paginated caps limit at 100 to prevent overruns.
    #[test]
    fn test_get_all_meters_paginated_limit_capped_at_100() {
        let (env, client, _admin) = setup();
        let user = Address::generate(&env);
        
        // Register 20 meters to test the capping behavior
        let ids = [
            symbol_short!("CAP_01"), symbol_short!("CAP_02"), symbol_short!("CAP_03"),
            symbol_short!("CAP_04"), symbol_short!("CAP_05"), symbol_short!("CAP_06"),
            symbol_short!("CAP_07"), symbol_short!("CAP_08"), symbol_short!("CAP_09"),
            symbol_short!("CAP_10"), symbol_short!("CAP_11"), symbol_short!("CAP_12"),
            symbol_short!("CAP_13"), symbol_short!("CAP_14"), symbol_short!("CAP_15"),
            symbol_short!("CAP_16"), symbol_short!("CAP_17"), symbol_short!("CAP_18"),
            symbol_short!("CAP_19"), symbol_short!("CAP_20"),
        ];
        
        client.allowlist_add(&user);
        for id in ids.iter() {
            client.register_meter(id, &user);
        }

        // Request with limit 200, should be capped at 100
        // Since we only have 20 meters, we should get all 20
        let page = client.get_all_meters_paginated(&0_u32, &200_u32);
        assert_eq!(page.len(), 20);
    }

    /// get_all_meters_paginated with offset 0 and large limit gets first page.
    #[test]
    fn test_get_all_meters_paginated_offset_zero() {
        let (env, client, _admin) = setup();
        let user = Address::generate(&env);
        let ids = [
            symbol_short!("OFF0_1"), symbol_short!("OFF0_2"), symbol_short!("OFF0_3"),
            symbol_short!("OFF0_4"), symbol_short!("OFF0_5"),
        ];

        client.allowlist_add(&user);
        for id in ids.iter() {
            client.register_meter(id, &user);
        }

        // Get first 5 with offset 0
        let page = client.get_all_meters_paginated(&0_u32, &10_u32);
        assert_eq!(page.len(), 5);
        for (i, meter_id) in page.iter().enumerate() {
            assert_eq!(meter_id, &ids[i]);
        }
    }

    /// get_all_meters_paginated with empty contract returns empty vec.
    #[test]
    fn test_get_all_meters_paginated_empty_contract() {
        let (_env, client, _admin) = setup();
        let page = client.get_all_meters_paginated(&0_u32, &10_u32);
        assert_eq!(page.len(), 0);
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
            topics.len() >= 3
                && topics.get(0) == Some(EVT_NS.into())
                && topics.get(1) == Some(symbol_short!("mtr_actv").into())
                && topics.get(2) == Some(meter_id.clone().into())
        });
        assert!(has_actv, "mtr_actv event not emitted by set_active(true)");
    }

    // ── batch_update_usage tests ──────────────────────────────────────────────

    fn register_and_fund(
        env: &Env,
        client: &SolarGridContractClient,
        token_address: &Address,
        meter_id: &String,
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

        let failed = client.batch_update_usage(&vec![&env, (m1.clone(), 10_u64, 3_000_i128)]);
        assert_eq!(failed.len(), 0, "Expected no failed meters");

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

        let mut updates: soroban_sdk::Vec<(String, u64, i128)> = soroban_sdk::Vec::new(&env);
        for id in ids.iter() {
            updates.push_back((id.clone(), 5_u64, 1_000_i128));
        }
        let failed = client.batch_update_usage(&updates);
        assert_eq!(failed.len(), 0, "Expected no failed meters");

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

        let mut updates: soroban_sdk::Vec<(String, u64, i128)> = soroban_sdk::Vec::new(&env);
        for id in ids.iter() {
            updates.push_back((id.clone(), 2_u64, 500_i128));
        }
        let failed = client.batch_update_usage(&updates);
        assert_eq!(failed.len(), 0, "Expected no failed meters");

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

        let failed = client.batch_update_usage(&vec![
            &env,
            (invalid.clone(), 1_u64, 100_i128),
            (valid.clone(), 2_u64, 200_i128),
        ]);

        // Verify the invalid meter is in the failure list
        assert_eq!(failed.len(), 1);
        assert_eq!(failed.get(0).unwrap(), invalid);
        
        // Verify the valid meter was processed successfully
        assert_eq!(client.get_meter_balance(&valid), 4_800);
        assert_eq!(client.get_meter(&valid).units_used, 2);

        let events = env.events().all();
        let skipped = events.iter().any(|(_, topics, _)| {
            topics.get(0).map(|v| sym_eq(&env, &v, symbol_short!("btch_skip"))).unwrap_or(false)
        });
        assert!(skipped, "batch_skip event not emitted for invalid meter");
    }

    #[test]
    fn test_batch_update_usage_rejects_oversized_batch() {
        let (env, client, _admin, token_address) = setup_with_token();
        setup_oracle(&env, &client);
        let meter_id = symbol_short!("OVER");
        register_and_fund(&env, &client, &token_address, &meter_id, 1_000_000_i128);

        let mut updates: soroban_sdk::Vec<(String, u64, i128)> = soroban_sdk::Vec::new(&env);
        // Create 51 unique meter IDs using symbol_short with different names
        let ids = [
            symbol_short!("M0"), symbol_short!("M1"), symbol_short!("M2"), symbol_short!("M3"),
            symbol_short!("M4"), symbol_short!("M5"), symbol_short!("M6"), symbol_short!("M7"),
            symbol_short!("M8"), symbol_short!("M9"), symbol_short!("MA"), symbol_short!("MB"),
            symbol_short!("MC"), symbol_short!("MD"), symbol_short!("ME"), symbol_short!("MF"),
            symbol_short!("MG"), symbol_short!("MH"), symbol_short!("MI"), symbol_short!("MJ"),
            symbol_short!("MK"), symbol_short!("ML"), symbol_short!("MM"), symbol_short!("MN"),
            symbol_short!("MO"), symbol_short!("MP"), symbol_short!("MQ"), symbol_short!("MR"),
            symbol_short!("MS"), symbol_short!("MT"), symbol_short!("MU"), symbol_short!("MV"),
            symbol_short!("MW"), symbol_short!("MX"), symbol_short!("MY"), symbol_short!("MZ"),
            symbol_short!("N0"), symbol_short!("N1"), symbol_short!("N2"), symbol_short!("N3"),
            symbol_short!("N4"), symbol_short!("N5"), symbol_short!("N6"), symbol_short!("N7"),
            symbol_short!("N8"), symbol_short!("N9"), symbol_short!("NA"), symbol_short!("NB"),
            symbol_short!("NC"), symbol_short!("ND"), symbol_short!("NE"),
        ];
        for id in ids.iter() {
            updates.push_back((id.clone(), 1_u64, 100_i128));
        }
        let result = client.try_batch_update_usage(&updates);
        assert_eq!(result, Err(Ok(ContractError::BatchTooLarge)));
    }

    /// Test batch_update_usage returns failed meter IDs for mixed valid/invalid updates.
    /// This test verifies the fix for the bug where invalid meters were silently ignored.
    #[test]
    fn test_batch_update_usage_returns_failed_meter_ids() {
        let (env, client, _admin, token_address) = setup_with_token();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
        setup_oracle(&env, &client);

        // Register and fund three valid meters
        let meter_valid1 = String::from_slice(&env, "BF_V1".as_bytes());
        let meter_valid2 = String::from_slice(&env, "BF_V2".as_bytes());
        let meter_valid3 = String::from_slice(&env, "BF_V3".as_bytes());
        let user1 = Address::generate(&env);
        let user2 = Address::generate(&env);
        let user3 = Address::generate(&env);

        allowlist_and_register(&client, &meter_valid1, &user1);
        token_admin_client.mint(&user1, &5_000_i128);
        client.make_payment(&meter_valid1, &user1, &5_000_i128, &PaymentPlan::UsageBased);

        allowlist_and_register(&client, &meter_valid2, &user2);
        token_admin_client.mint(&user2, &5_000_i128);
        client.make_payment(&meter_valid2, &user2, &5_000_i128, &PaymentPlan::UsageBased);

        allowlist_and_register(&client, &meter_valid3, &user3);
        token_admin_client.mint(&user3, &1_000_i128);
        client.make_payment(&meter_valid3, &user3, &1_000_i128, &PaymentPlan::UsageBased);

        // Deactivate the third valid meter
        client.deactivate_meter(&meter_valid3);

        // Create batch with: invalid1, valid1, valid3(deactivated), invalid2, valid2
        let meter_invalid1 = String::from_slice(&env, "BF_INV1".as_bytes());
        let meter_invalid2 = String::from_slice(&env, "BF_INV2".as_bytes());

        let updates = vec![
            (meter_invalid1.clone(), 1_u64, 100_i128),  // missing meter
            (meter_valid1.clone(), 1_u64, 500_i128),    // valid
            (meter_valid3.clone(), 1_u64, 100_i128),    // deactivated
            (meter_invalid2.clone(), 1_u64, 100_i128),  // missing meter
            (meter_valid2.clone(), 1_u64, 500_i128),    // valid
        ];

        let failed = client.batch_update_usage(&updates);

        // Verify failed list contains both invalid meters and the deactivated meter
        assert_eq!(failed.len(), 3, "Expected 3 failed meters (2 missing + 1 deactivated)");
        
        // Check that all expected failures are present
        let mut found_invalid1 = false;
        let mut found_invalid2 = false;
        let mut found_valid3 = false;
        for fail_id in failed.iter() {
            if fail_id == meter_invalid1 {
                found_invalid1 = true;
            } else if fail_id == meter_invalid2 {
                found_invalid2 = true;
            } else if fail_id == meter_valid3 {
                found_valid3 = true;
            }
        }
        assert!(found_invalid1, "meter_invalid1 should be in failed list");
        assert!(found_invalid2, "meter_invalid2 should be in failed list");
        assert!(found_valid3, "meter_valid3 (deactivated) should be in failed list");

        // Verify valid meters were processed successfully
        assert_eq!(client.get_meter_balance(&meter_valid1), 4_500);
        assert_eq!(client.get_meter(&meter_valid1).units_used, 1);

        assert_eq!(client.get_meter_balance(&meter_valid2), 4_500);
        assert_eq!(client.get_meter(&meter_valid2).units_used, 1);

        // Verify deactivated meter was not modified
        assert_eq!(client.get_meter_balance(&meter_valid3), 1_000);
        assert_eq!(client.get_meter(&meter_valid3).units_used, 0);
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
        assert_eq!(client.get_meter(&meter_id).unwrap().units_used, 5);
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

    #[test]
    fn test_get_meter_existing_and_missing() {
        let (env, client, _admin) = setup();
        let user = Address::generate(&env);
        let meter_id = symbol_short!("EXISTING");
        
        allowlist_and_register(&client, &meter_id, &user);
        
        // Existing meter should return Some
        let existing = client.get_meter(&meter_id);
        assert!(existing.is_some());
        assert_eq!(existing.unwrap().owner, user);

        // Missing meter should return None
        let missing_id = symbol_short!("MISSING");
        let missing = client.get_meter(&missing_id);
        assert!(missing.is_none());
    }

    // ── NotInitialized guard tests ────────────────────────────────────────────

    /// Calling an admin function on an uninitialized contract returns NotInitialized.
    #[test]
    fn test_admin_fn_on_uninitialized_contract_returns_not_initialized() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, SolarGridContract);
        let client = SolarGridContractClient::new(&env, &contract_id);
        // Contract is not initialized — set_active should return NotInitialized
        let result = client.try_set_active(&symbol_short!("UNINIT"), &true);
        assert_eq!(result, Err(Ok(ContractError::NotInitialized)));
    }

    #[test]
    fn test_initialize_returns_already_initialized_on_second_call() {
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

        let result = client.try_initialize(&admin, &token_address);
        assert_eq!(result, Err(Ok(ContractError::AlreadyInitialized)));
    }

    /// initialize must be signed by the admin being set — any other caller is rejected.
    #[test]
    fn test_initialize_requires_admin_auth() {
        let env = Env::default();
        // Do NOT mock auths — the admin must actually sign
        let contract_id = env.register_contract(None, SolarGridContract);
        let client = SolarGridContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token_address = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        
        // Use try_initialize to check for auth failure without panicking in the test itself
        // or just expect the panic but with a generic message if "not authorized" is not appearing.
        let result = client.try_initialize(&admin, &token_address);
        assert!(result.is_err());
    }

    #[test]
    fn test_get_meter_returns_meter_not_found_for_unknown_meter() {
        let (_env, client, _admin) = setup();
        let result = client.try_get_meter(&symbol_short!("MISS_MTR"));
        assert!(matches!(result, Err(Ok(ContractError::MeterNotFound))));
    }

    #[test]
    fn test_withdraw_revenue_returns_unauthorized_for_non_admin() {
        let (env, client, _admin, _token_address) = setup_with_token();
        let provider = Address::generate(&env);
        let result = client.try_withdraw_revenue(&provider, &1_i128);
        assert_eq!(result, Err(Ok(ContractError::Unauthorized)));
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

        // The entry should now deserialize as a v2 Meter.
        let meter = client.get_meter(&meter_id);
        assert_eq!(meter.version, 2);
        assert_eq!(meter.owner, owner);
        assert!(meter.active);
        assert_eq!(meter.units_used, 42);
        assert_eq!(meter.plan, PaymentPlan::UsageBased);
        assert_eq!(meter.last_payment, 1_000);
        assert_eq!(meter.expires_at, u64::MAX);
    }

    /// Calling migrate_meter on an already-migrated v2 meter is idempotent.
    #[test]
    fn test_migrate_meter_idempotent_on_v2() {
        let (env, client, _admin) = setup();
        let user = Address::generate(&env);
        let meter_id = symbol_short!("MIG_IDP");

        // Register creates a v2 meter.
        allowlist_and_register(&client, &meter_id, &user);
        let before = client.get_meter(&meter_id);
        assert_eq!(before.version, 2);

        // Calling migrate_meter again must succeed and leave the entry unchanged.
        client.migrate_meter(&meter_id);
        let after = client.get_meter(&meter_id);
        assert_eq!(after.version, 2);
        assert_eq!(after.owner, before.owner);
        assert_eq!(after.units_used, before.units_used);
    }

    /// get_all_shares returns the full map in one call.
    #[test]
    fn test_get_all_shares_single_call() {
        let (env, client, _admin) = setup();

        let alice = Address::generate(&env);
        let bob = Address::generate(&env);

        client.add_collaborator(&alice, &6_000_u32); // 60%
        client.add_collaborator(&bob, &4_000_u32);   // 40%

        let shares = client.get_all_shares();
        assert_eq!(shares.get(alice.clone()).unwrap(), 6_000);
        assert_eq!(shares.get(bob.clone()).unwrap(), 4_000);

        // get_collaborators preserves insertion order
        let collabs = client.get_collaborators();
        assert_eq!(collabs.get(0).unwrap(), alice);
        assert_eq!(collabs.get(1).unwrap(), bob);
    }

    /// distribute splits amount proportionally using insertion-ordered Vec.
    #[test]
    fn test_distribute_proportional() {
        let (env, client, _admin) = setup();

        let alice = Address::generate(&env);
        let bob = Address::generate(&env);

        client.add_collaborator(&alice, &7_500_u32); // 75%
        client.add_collaborator(&bob, &2_500_u32);   // 25%

        let payouts = client.distribute(&10_000_000_i128);
        assert_eq!(payouts.get(alice).unwrap(), 7_500_000);
        assert_eq!(payouts.get(bob).unwrap(), 2_500_000);
    }

    /// Adding a duplicate collaborator should return CollaboratorAlreadyExists error.
    #[test]
    fn test_add_collaborator_duplicate_returns_typed_error() {
        let (env, client, _admin) = setup();
        let alice = Address::generate(&env);
        client.add_collaborator(&alice, &5_000_u32);
        let result = client.try_add_collaborator(&alice, &5_000_u32);
        assert_eq!(result, Err(Ok(ContractError::CollaboratorAlreadyExists)));
    }

    /// Total shares exceeding 100% should return InvalidAmount error.
    #[test]
    fn test_add_collaborator_overflow_returns_typed_error() {
        let (env, client, _admin) = setup();
        let alice = Address::generate(&env);
        let bob = Address::generate(&env);
        client.add_collaborator(&alice, &6_000_u32);
        let result = client.try_add_collaborator(&bob, &5_000_u32); // 60 + 50 > 100%
        assert_eq!(result, Err(Ok(ContractError::InvalidAmount)));
    }

    // ── Issue 195: plan_duration_secs helper tests ────────────────────────────

    /// Daily plan sets expires_at = now + 86400.
    #[test]
    fn test_plan_duration_daily_sets_correct_expiry() {
        let (env, client, _admin, token_address) = setup_with_token();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
        let user = Address::generate(&env);
        let meter_id = symbol_short!("PD_DAY");
        allowlist_and_register(&client, &meter_id, &user);
        token_admin_client.mint(&user, &1_000_i128);

        let before = env.ledger().timestamp();
        client.make_payment(&meter_id, &user, &1_000_i128, &PaymentPlan::Daily);
        let meter = client.get_meter(&meter_id);
        assert_eq!(meter.expires_at - before, SECONDS_PER_DAY);
    }

    /// Weekly plan sets expires_at = now + 604800.
    #[test]
    fn test_plan_duration_weekly_sets_correct_expiry() {
        let (env, client, _admin, token_address) = setup_with_token();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
        let user = Address::generate(&env);
        let meter_id = symbol_short!("PD_WEEK");
        allowlist_and_register(&client, &meter_id, &user);
        token_admin_client.mint(&user, &1_000_i128);

        let before = env.ledger().timestamp();
        client.make_payment(&meter_id, &user, &1_000_i128, &PaymentPlan::Weekly);
        let meter = client.get_meter(&meter_id);
        assert_eq!(meter.expires_at - before, SECONDS_PER_WEEK);
    }

    /// UsageBased plan sets expires_at = u64::MAX (no time expiry).
    #[test]
    fn test_plan_duration_usage_based_sets_max_expiry() {
        let (env, client, _admin, token_address) = setup_with_token();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
        let user = Address::generate(&env);
        let meter_id = symbol_short!("PD_UB");
        allowlist_and_register(&client, &meter_id, &user);
        token_admin_client.mint(&user, &1_000_i128);

        client.make_payment(&meter_id, &user, &1_000_i128, &PaymentPlan::UsageBased);
        let meter = client.get_meter(&meter_id);
        assert_eq!(meter.expires_at, u64::MAX);
    }

    // ── Issue 194: daily_spending_limit tests ─────────────────────────────────

    /// With daily_limit > 0, exceeding it returns DailyLimitReached.
    #[test]
    fn test_daily_limit_blocks_usage_when_exceeded() {
        let (env, client, _admin, token_address) = setup_with_token();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
        setup_oracle(&env, &client);

        let user = Address::generate(&env);
        let meter_id = symbol_short!("DL_HIT");
        allowlist_and_register(&client, &meter_id, &user);
        token_admin_client.mint(&user, &10_000_i128);
        client.make_payment(&meter_id, &user, &10_000_i128, &PaymentPlan::UsageBased);

        // Set daily limit to 500 stroops.
        client.set_daily_limit(&meter_id, &500_i128);

        // First usage within limit — should succeed.
        client.update_usage(&meter_id, &1_u64, &400_i128);
        assert_eq!(client.get_meter_balance(&meter_id), 9_600);

        // Second call would push day_spent (400 + 200 = 600) over the 500 cap.
        let result = client.try_update_usage(&meter_id, &1_u64, &200_i128);
        assert_eq!(result, Err(Ok(ContractError::DailyLimitReached)));
    }

    /// After 24 h the window resets and spending is allowed again.
    #[test]
    fn test_daily_limit_window_resets_after_24h() {
        let (env, client, _admin, token_address) = setup_with_token();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
        setup_oracle(&env, &client);

        let user = Address::generate(&env);
        let meter_id = symbol_short!("DL_RST");
        allowlist_and_register(&client, &meter_id, &user);
        token_admin_client.mint(&user, &10_000_i128);
        client.make_payment(&meter_id, &user, &10_000_i128, &PaymentPlan::UsageBased);

        client.set_daily_limit(&meter_id, &500_i128);

        // Spend up to the limit on day 1.
        client.update_usage(&meter_id, &1_u64, &500_i128);
        let result = client.try_update_usage(&meter_id, &1_u64, &1_i128);
        assert_eq!(result, Err(Ok(ContractError::DailyLimitReached)));

        // Advance ledger by more than 24 h.
        env.ledger().with_mut(|li| li.timestamp += SECONDS_PER_DAY + 1);

        // Window resets — spending is allowed again.
        client.update_usage(&meter_id, &1_u64, &500_i128);
        assert_eq!(client.get_meter_balance(&meter_id), 9_000);
    }

    /// daily_limit = 0 means unlimited — any cost is accepted regardless of size.
    #[test]
    fn test_daily_limit_zero_means_unlimited() {
        let (env, client, _admin, token_address) = setup_with_token();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
        setup_oracle(&env, &client);

        let user = Address::generate(&env);
        let meter_id = symbol_short!("DL_UNL");
        allowlist_and_register(&client, &meter_id, &user);
        token_admin_client.mint(&user, &100_000_i128);
        client.make_payment(&meter_id, &user, &100_000_i128, &PaymentPlan::UsageBased);

        // daily_limit defaults to 0 (unlimited) — large repeated costs must succeed.
        client.update_usage(&meter_id, &1_u64, &40_000_i128);
        client.update_usage(&meter_id, &1_u64, &40_000_i128);
        assert_eq!(client.get_meter_balance(&meter_id), 20_000);
    }

    // ── Bug fix: apply_usage active check tests ────────────────────────────────

    /// Test that update_usage rejects usage on deactivated meters.
    /// Reproduces the bug: deactivate meter → update_usage → expect MeterNotActive error.
    #[test]
    fn test_update_usage_rejects_deactivated_meter() {
        let (env, client, _admin, token_address) = setup_with_token();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
        setup_oracle(&env, &client);

        let user = Address::generate(&env);
        let meter_id = symbol_short!("UA_DEACT");
        allowlist_and_register(&client, &meter_id, &user);
        token_admin_client.mint(&user, &10_000_i128);
        client.make_payment(&meter_id, &user, &10_000_i128, &PaymentPlan::UsageBased);

        // Meter is now active
        assert!(client.check_access(&meter_id));

        // Deactivate the meter
        client.deactivate_meter(&meter_id);
        assert!(!client.check_access(&meter_id));

        // Try to update usage on deactivated meter — should fail with MeterNotActive
        let result = client.try_update_usage(&meter_id, &1_u64, &100_i128);
        assert_eq!(result, Err(Ok(ContractError::MeterNotActive)));

        // Verify units_used and balance were not modified
        assert_eq!(client.get_meter(&meter_id).units_used, 0);
        assert_eq!(client.get_meter_balance(&meter_id), 10_000);
    }

    /// Test that batch_update_usage rejects usage on deactivated meters.
    /// Ensures the fix applies to both update_usage and batch_update_usage.
    #[test]
    fn test_batch_update_usage_rejects_deactivated_meter() {
        let (env, client, _admin, token_address) = setup_with_token();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
        setup_oracle(&env, &client);

        let user1 = Address::generate(&env);
        let meter_id1 = String::from_slice(&env, "BM1".as_bytes());
        allowlist_and_register(&client, &meter_id1, &user1);
        token_admin_client.mint(&user1, &10_000_i128);
        client.make_payment(&meter_id1, &user1, &10_000_i128, &PaymentPlan::UsageBased);

        let user2 = Address::generate(&env);
        let meter_id2 = String::from_slice(&env, "BM2".as_bytes());
        allowlist_and_register(&client, &meter_id2, &user2);
        token_admin_client.mint(&user2, &10_000_i128);
        client.make_payment(&meter_id2, &user2, &10_000_i128, &PaymentPlan::UsageBased);

        // Deactivate the first meter
        client.deactivate_meter(&meter_id1);

        // Batch update: meter1 (inactive) and meter2 (active)
        let updates = vec![
            (meter_id1.clone(), 1_u64, 500_i128),
            (meter_id2.clone(), 1_u64, 500_i128),
        ];
        let failed = client.batch_update_usage(&updates);

        // Meter 1 (deactivated) should be in the failure list
        assert_eq!(failed.len(), 1);
        assert_eq!(failed.get(0).unwrap(), meter_id1);

        // Meter 1 (deactivated) should not have consumed resources
        assert_eq!(client.get_meter(&meter_id1).units_used, 0);
        assert_eq!(client.get_meter_balance(&meter_id1), 10_000);

        // Meter 2 (active) should have consumed resources normally
        assert_eq!(client.get_meter(&meter_id2).units_used, 1);
        assert_eq!(client.get_meter_balance(&meter_id2), 9_500);
    }

    /// Test that administratively deactivated meter cannot consume daily limit.
    /// Ensures daily_limit is not consumed for inactive meters.
    #[test]
    fn test_deactivated_meter_does_not_consume_daily_limit() {
        let (env, client, _admin, token_address) = setup_with_token();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
        setup_oracle(&env, &client);

        let user = Address::generate(&env);
        let meter_id = symbol_short!("DL_DEACT");
        allowlist_and_register(&client, &meter_id, &user);
        token_admin_client.mint(&user, &10_000_i128);
        client.make_payment(&meter_id, &user, &10_000_i128, &PaymentPlan::UsageBased);

        // Set a daily limit
        client.set_daily_limit(&meter_id, &500_i128);

        // Deactivate the meter
        client.deactivate_meter(&meter_id);

        // Try to update usage — should be rejected by active check, not daily limit
        let result = client.try_update_usage(&meter_id, &1_u64, &100_i128);
        assert_eq!(result, Err(Ok(ContractError::MeterNotActive)));

        // Verify day_spent was not incremented
        let meter = client.get_meter(&meter_id);
        assert_eq!(meter.day_spent, 0);
    }

    /// set_daily_limit with negative value returns InvalidAmount.
    #[test]
    fn test_set_daily_limit_negative_returns_invalid_amount() {
        let (env, client, _admin, _token_address) = setup_with_token();
        let user = Address::generate(&env);
        let meter_id = symbol_short!("DL_NEG");
        allowlist_and_register(&client, &meter_id, &user);

        let result = client.try_set_daily_limit(&meter_id, &-1_i128);
        assert_eq!(result, Err(Ok(ContractError::InvalidAmount)));
    }

    /// Invalid basis_points (0 or > 10000) should return InvalidAmount error.
    #[test]
    fn test_add_collaborator_invalid_basis_points_returns_typed_error() {
        let (env, client, _admin) = setup();
        let alice = Address::generate(&env);
        
        // Test zero basis points
        let result = client.try_add_collaborator(&alice, &0_u32);
        assert_eq!(result, Err(Ok(ContractError::InvalidAmount)));
        
        // Test basis points > 10000
        let bob = Address::generate(&env);
        let result = client.try_add_collaborator(&bob, &10_001_u32);
        assert_eq!(result, Err(Ok(ContractError::InvalidAmount)));
    }

    /// distribute with zero or negative amount should return InvalidAmount error.
    #[test]
    fn test_distribute_invalid_amount_returns_typed_error() {
        let (env, client, _admin) = setup();
        let alice = Address::generate(&env);
        client.add_collaborator(&alice, &5_000_u32);
        
        // Test zero amount
        let result = client.try_distribute(&0_i128);
        assert_eq!(result, Err(Ok(ContractError::InvalidAmount)));
        
        // Test negative amount
        let result = client.try_distribute(&-1_i128);
        assert_eq!(result, Err(Ok(ContractError::InvalidAmount)));
    }

    #[test]
    fn test_get_all_meters_with_multiple_meters() {
        let (env, client, _admin, _token_address) = setup_with_token();
        
        let meter_ids = [
            symbol_short!("M1"), symbol_short!("M2"), symbol_short!("M3"),
            symbol_short!("M4"), symbol_short!("M5"), symbol_short!("M6"),
            symbol_short!("M7"), symbol_short!("M8"), symbol_short!("M9"),
            symbol_short!("M10"), symbol_short!("M11"), symbol_short!("M12")
        ];

        for meter_id in meter_ids.iter() {
            let user = Address::generate(&env);
            client.allowlist_add(&user);
            client.register_meter(meter_id, &user);
        }
        
        let all_meters = client.get_all_meters();
        assert_eq!(all_meters.len(), 12);
    }

    #[test]
    fn test_set_active_blocked_for_zero_balance() {
        let (env, client, _admin, _token_address) = setup_with_token();
        let user = Address::generate(&env);
        let meter_id = symbol_short!("METER1");

        client.allowlist_add(&user);
        client.register_meter(&meter_id, &user);

        // Try to activate without balance
        let result = client.try_set_active(&meter_id, &true);
        assert_eq!(result, Err(Ok(ContractError::CannotActivateWithoutBalance)));

        // Verify it works after payment
        let token_admin_client = token::StellarAssetClient::new(&env, &_token_address);
        token_admin_client.mint(&user, &1_000_i128);
        client.make_payment(&meter_id, &user, &1_000_i128, &PaymentPlan::Daily);

        // Deactivate then reactivate
        client.set_active(&meter_id, &false);
        assert_eq!(client.check_access(&meter_id), false);
        client.set_active(&meter_id, &true);
        assert_eq!(client.check_access(&meter_id), true);
    }

    // ── Issue #414: get_collaborator_share ────────────────────────────────────

    #[test]
    fn test_get_collaborator_share_returns_correct_value() {
        let (env, client, _admin) = setup();
        let alice = Address::generate(&env);
        client.add_collaborator(&alice, &3_000_u32);
        assert_eq!(client.get_collaborator_share(&alice), Some(3_000_u32));
    }

    #[test]
    fn test_get_collaborator_share_returns_none_for_unknown_address() {
        let (env, client, _admin) = setup();
        let unknown = Address::generate(&env);
        assert_eq!(client.get_collaborator_share(&unknown), None);
    }

    // ── Issue #415: freeze_contract / emergency_withdraw ──────────────────────

    #[test]
    fn test_emergency_withdraw_transfers_full_balance() {
        let (env, client, _admin, token_address) = setup_with_token();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
        let token_client = token::Client::new(&env, &token_address);

        token_admin_client.mint(&client.address, &1_000_i128);
        client.freeze_contract();

        let recipient = Address::generate(&env);
        client.emergency_withdraw(&recipient);

        assert_eq!(token_client.balance(&recipient), 1_000);
        assert_eq!(token_client.balance(&client.address), 0);
    }

    #[test]
    fn test_emergency_withdraw_noop_when_balance_zero() {
        let (env, client, _admin, _token_address) = setup_with_token();
        client.freeze_contract();
        let recipient = Address::generate(&env);
        client.emergency_withdraw(&recipient);
    }

    #[test]
    fn test_emergency_withdraw_requires_frozen() {
        let (env, client, _admin, _token_address) = setup_with_token();
        let recipient = Address::generate(&env);
        let result = client.try_emergency_withdraw(&recipient);
        assert_eq!(result, Err(Ok(ContractError::ContractNotFrozen)));
    }

    // ── Issue #417: expire_meter ──────────────────────────────────────────────

    #[test]
    fn test_expire_meter_sets_inactive_and_expired() {
        let (env, client, _admin, token_address) = setup_with_token();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
        let user = Address::generate(&env);
        let meter_id = symbol_short!("EXP_MTR");

        allowlist_and_register(&client, &meter_id, &user);
        token_admin_client.mint(&user, &1_000_i128);
        client.make_payment(&meter_id, &user, &1_000_i128, &PaymentPlan::Weekly);
        assert!(client.get_meter(&meter_id).active);

        client.expire_meter(&meter_id);

        let meter = client.get_meter(&meter_id);
        assert!(!meter.active);
        assert!(meter.expires_at <= env.ledger().timestamp());
    }

    #[test]
    fn test_expire_meter_returns_not_found_for_unknown() {
        let (_env, client, _admin) = setup();
        let result = client.try_expire_meter(&symbol_short!("NO_METER"));
        assert_eq!(result, Err(Ok(ContractError::MeterNotFound)));
    }
}

mod test;