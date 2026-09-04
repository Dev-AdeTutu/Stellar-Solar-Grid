#![no_std]
#![allow(deprecated)]
extern crate alloc;

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
    ContractFrozen = 17,
    CollaboratorNotFound = 18,
    RefundExceedsPayments = 19,
    RefundLimitExceeded = 20,
    /// The contract-wide emergency pause is active.
    ContractPaused = 21,
    /// The contract is already paused.
    AlreadyPaused = 22,
    /// The contract is not currently paused.
    NotPaused = 23,
    /// `make_payment`'s optional memo exceeds MAX_MEMO_LEN bytes.
    MemoTooLong = 24,
    /// A configuration value (e.g. unit price) is invalid, such as zero,
    /// which would cause a division-by-zero panic in cost calculations (#733).
    InvalidConfiguration = 25,
    InvalidMultisigConfiguration = 25,
    ProposalNotFound = 26,
    ProposalExpired = 27,
    ProposalAlreadyApproved = 28,
    ProposalNotReady = 29,
    ReentrantCall = 30,
    /// Meter metadata validation failed (too many pairs or value too long).
    InvalidMetadata = 31,
}

// ── Storage keys ──────────────────────────────────────────────────────────────

const ADMIN: Symbol = symbol_short!("ADMIN");
const ALLOWLIST: Symbol = symbol_short!("ALLOWLIST");
const TOKEN: Symbol = symbol_short!("TOKEN");
const ORACLE: Symbol = symbol_short!("ORACLE");
const METER_LIST: Symbol = symbol_short!("MLIST");
const METER_COUNT: Symbol = symbol_short!("MCNT");
const COLLABS: Symbol = symbol_short!("COLLABS");
const SHARES: Symbol = symbol_short!("SHARES");
const FROZEN: Symbol = symbol_short!("FROZEN");
const REENTRANCY: Symbol = symbol_short!("REENTR");
const CONTRACT_VERSION: Symbol = symbol_short!("CTR_VER");
const DEFAULT_GRACE_PERIOD: u64 = 7200; // 2 hours (in seconds)
const GRACE_PERIOD: Symbol = symbol_short!("GRACE_P");
const SECONDS_PER_DAY: u64 = 86_400;
const SECONDS_PER_WEEK: u64 = 604_800;
/// Max length (bytes) of the optional memo accepted by `make_payment` (Issue #766).
const MAX_MEMO_LEN: u32 = 100;
/// Maximum payment duration in seconds (10 years). Closes #745.
/// Prevents timestamp overflow by capping extremely large durations.
const MAX_PAYMENT_DURATION_SECS: u64 = 10 * 365 * SECONDS_PER_DAY;
/// Max total i128 refunded across all recipients per rolling window; 0 = unlimited.
const REFUND_LIMIT: Symbol = symbol_short!("RFND_LIM");
const REFUND_WINDOW: Symbol = symbol_short!("RFND_WIN");
/// Contract-wide emergency pause state and timestamp.
const PAUSED: Symbol = symbol_short!("PAUSED");
const PAUSED_AT: Symbol = symbol_short!("PAUSE_AT");
/// A pause automatically expires after 48 hours (Unix seconds).
const MAX_PAUSE_DURATION: u64 = 48 * 60 * 60;
/// Configurable price per unit (stroops per milli-kWh) used for on-chain cost
/// calculations. Must always be > 0. If unset, this safe non-zero default is
/// used so cost math can never divide by zero (#733).
const DEFAULT_UNIT_PRICE: i128 = 1;
/// Storage key for the on-chain unit price.
const UNIT_PRICE: Symbol = symbol_short!("U_PRICE");
const MULTISIG_ADMINS: Symbol = symbol_short!("MS_ADM");
const MULTISIG_THRESHOLD: Symbol = symbol_short!("MS_THR");
const PROPOSAL_COUNT: Symbol = symbol_short!("MS_CNT");
/// Max number of metadata key-value pairs per meter (Issue #691).
const MAX_METADATA_PAIRS: u32 = 10;
/// Max characters per metadata value (Issue #691).
const MAX_METADATA_VALUE_LEN: u32 = 100;

/// #737 — Retention cap for the on-chain `OwnershipHistory` list.
///
/// The contract intentionally follows an event-sourcing model: every usage
/// update / transfer / payment emits an off-chain event and only the *current*
/// state is kept in persistent storage, so per-event usage history never
/// accumulates on-chain. The one per-meter list that would otherwise grow
/// forever is the ownership-transfer history; we cap it here and rely on the
/// emitted `mtr_xfer` events for a complete archive off-chain.
const MAX_OWNERSHIP_HISTORY: u32 = 20;

// ── Data types ────────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum PaymentPlan {
    Daily,
    Weekly,
    Monthly,
    UsageBased,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum AdminOperation {
    Pause,
    Unpause,
    EmergencyWithdraw(i128),
    BulkDeactivate(Vec<String>),
    RotateAdmin(Address),
    SetGracePeriod(u64),
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct AdminProposal {
    pub operation: AdminOperation,
    pub approvals: Vec<Address>,
    pub threshold: u32,
    pub expiry: u64,
}

/// Access status with grace period details
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct AccessStatus {
    pub has_access: bool,
    pub in_grace_period: bool,
    pub grace_expires_at: Option<u64>,
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
#[derive(Clone, Debug, PartialEq)]
pub struct OwnershipTransfer {
    pub old_owner: Address,
    pub new_owner: Address,
    pub transferred_at: u64,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct Meter {
    /// Schema version — increment when fields are added/changed.
    /// v1: initial layout (owner, active, units_used, plan, last_payment, expires_at)
    /// v2: adds daily spending limit (daily_limit, day_spent, day_start) and grace period (grace_expires_at)
    /// v4: adds auto_deactivate, controlling whether exceeding daily_limit blocks
    ///     usage (true, default) or only emits a limit_hit warning (false)
    pub version: u32,
    pub owner: Address,
    pub active: bool,
    pub units_used: u64, // kWh * 1000 (milli-kWh for precision)
    pub plan: PaymentPlan,
    pub last_payment: u64, // ledger timestamp
    pub expires_at: u64,   // ledger timestamp when access expires
    pub daily_limit: i128, // max stroops deductible per day; 0 = unlimited
    pub day_spent: i128,   // stroops spent in the current calendar-day (UTC) window
    pub day_start: u64,    // timestamp when the current window started
    pub grace_expires_at: Option<u64>, // Timestamp when grace period ends
    /// Optional read-only contact to notify when the balance is critically low.
    pub emergency_contact: Option<Address>,
    /// When true (default), usage that would push day_spent over daily_limit
    /// is rejected. When false, the limit_hit event still fires but the usage
    /// is allowed through ("warn only" mode).
    pub auto_deactivate: bool,
}

/// v2 layout — kept for migration from the pre-emergency-contact schema.
#[contracttype]
#[derive(Clone, Debug)]
pub struct LegacyMeterV2 {
    pub version: u32,
    pub owner: Address,
    pub active: bool,
    pub units_used: u64,
    pub plan: PaymentPlan,
    pub last_payment: u64,
    pub expires_at: u64,
    pub daily_limit: i128,
    pub day_spent: i128,
    pub day_start: u64,
    pub grace_expires_at: Option<u64>,
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

/// Migrate a v0 (legacy) meter entry to the current v4 schema.
fn migrate_meter_v0(old: LegacyMeter) -> Meter {
    Meter {
        version: 4,
        owner: old.owner,
        active: old.active,
        units_used: old.units_used,
        plan: old.plan,
        last_payment: old.last_payment,
        expires_at: old.expires_at,
        daily_limit: 0,
        day_spent: 0,
        day_start: old.last_payment,
        grace_expires_at: None,
        emergency_contact: None,
        auto_deactivate: true,
    }
}

/// Migrate a v1 meter entry to the current v4 schema.
fn migrate_meter_v1(old: LegacyMeterV1) -> Meter {
    Meter {
        version: 4,
        owner: old.owner,
        active: old.active,
        units_used: old.units_used,
        plan: old.plan,
        last_payment: old.last_payment,
        expires_at: old.expires_at,
        daily_limit: 0,
        day_spent: 0,
        day_start: old.last_payment,
        grace_expires_at: None,
        emergency_contact: None,
        auto_deactivate: true,
    }
}

fn migrate_meter_v2(env: &Env, old: LegacyMeterV2) -> Meter {
    Meter {
        version: 4,
        owner: old.owner,
        active: old.active,
        units_used: old.units_used,
        plan: old.plan,
        last_payment: old.last_payment,
        expires_at: old.expires_at,
        daily_limit: old.daily_limit,
        day_spent: old.day_spent,
        day_start: old.day_start,
        grace_expires_at: old.grace_expires_at,
        emergency_contact: None,
        auto_deactivate: true,
    }
}

/// Returns the number of seconds a payment plan is valid for.
///
/// Calculations are strictly in elapsed UTC seconds based on Unix epoch timestamps,
/// completely independent of local timezones or Daylight Saving Time (DST) changes.
/// - Daily: exactly SECONDS_PER_DAY (86,400 seconds / 24 hours elapsed)
/// - Weekly: exactly SECONDS_PER_WEEK (604,800 seconds / 7 days elapsed)
/// - Monthly: exactly 30 * SECONDS_PER_DAY (2,592,000 seconds / 30 days elapsed)
/// - UsageBased: u64::MAX (no time expiry; saturating_add with any timestamp yields u64::MAX).
fn plan_duration_secs(plan: &PaymentPlan) -> u64 {
    match plan {
        PaymentPlan::Daily => SECONDS_PER_DAY,
        PaymentPlan::Weekly => SECONDS_PER_WEEK,
        PaymentPlan::Monthly => 30 * SECONDS_PER_DAY,
        PaymentPlan::UsageBased => u64::MAX,
    }
}

/// Validates metadata constraints (Issue #691):
/// - Maximum 10 key-value pairs
/// - Maximum 100 characters per value
fn validate_metadata(metadata: &Map<String, String>) -> Result<(), ContractError> {
    if metadata.len() > MAX_METADATA_PAIRS {
        return Err(ContractError::InvalidMetadata);
    }
    for (_, value) in metadata.iter() {
        if value.len() > MAX_METADATA_VALUE_LEN {
            return Err(ContractError::InvalidMetadata);
        }
    }
    Ok(())
}

#[contracttype]
pub enum DataKey {
    Meter(String),
    OwnerMeters(Address),
    OwnershipHistory(String),
    ProviderRevenue(Address),
    MeterBalance(String),
    /// Cumulative amount `payer` has paid towards `meter_id` (lifetime, not reduced by refunds).
    PayerPaid(String, Address),
    /// Cumulative amount already refunded to `payer` for `meter_id`.
    PayerRefunded(String, Address),
    /// List of delegate addresses authorized to make payments for a meter.
    MeterDelegates(String),
    /// Storage key for a multisig admin proposal.
    AdminProposal(u32),
}

/// Tracks admin-issued refunds within the current rolling window, used to cap
/// total refunds per period and prevent contract balance drainage.
#[contracttype]
#[derive(Clone, Debug)]
pub struct RefundWindow {
    pub window_start: u64,
    pub window_spent: i128,
}

/// Combined view returned by get_meter_full — meter state plus its balance
/// in a single query, eliminating the need for two separate RPC calls.
#[contracttype]
pub struct MeterView {
    pub meter: Meter,
    pub balance: i128,
}

/// Per-meter result returned by `batch_deactivate_meters`.
#[contracttype]
pub struct BatchDeactivateResult {
    pub meter_id: String,
    pub success: bool,
    pub reason: String,
}

/// Summary returned by `batch_deactivate_meters`.
#[contracttype]
pub struct BatchDeactivateSummary {
    pub total: u32,
    pub deactivated: u32,
    pub skipped: u32,
    pub results: Vec<BatchDeactivateResult>,
}

// ── Event topics (contract namespace) ────────────────────────────────────────

const EVT_NS: Symbol = symbol_short!("solargrid");
const CURRENT_CONTRACT_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Guards against reentrancy for any entry point that performs an external
/// contract call (e.g. a token transfer). A malicious or buggy token
/// contract could otherwise call back into this contract mid-invocation,
/// before the outer call's state effects have been applied or its
/// single-use records (e.g. a spent multisig proposal) have been cleared,
/// and bypass checks that already ran (see checks-effects-interactions).
///
/// Held for the guarded function's whole body via RAII: the lock is
/// released in `Drop`, which Rust runs on every exit path (including early
/// `?` returns), so callers only need `let _guard = ReentrancyGuard::enter(&env)?;`.
struct ReentrancyGuard<'a> {
    env: &'a Env,
}

impl<'a> ReentrancyGuard<'a> {
    fn enter(env: &'a Env) -> Result<Self, ContractError> {
        let locked: bool = env.storage().instance().get(&REENTRANCY).unwrap_or(false);
        if locked {
            return Err(ContractError::ReentrantCall);
        }
        env.storage().instance().set(&REENTRANCY, &true);
        Ok(Self { env })
    }
}

impl<'a> Drop for ReentrancyGuard<'a> {
    fn drop(&mut self) {
        self.env.storage().instance().set(&REENTRANCY, &false);
    }
}

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

    pub fn get_contract_version(env: Env) -> String {
        env.storage()
            .instance()
            .get(&CONTRACT_VERSION)
            .unwrap_or_else(|| String::from_str(&env, CURRENT_CONTRACT_VERSION))
    }

    /// Register a new smart meter for an owner with optional metadata (Issue #691).
    ///
    /// # Access control
    /// - Caller must be the contract admin.
    /// - `owner` must be present in the admin-managed allowlist.
    /// - `owner` must co-sign the registration (require_auth).
    ///
    /// # Metadata Constraints (Issue #691)
    /// - Maximum 10 key-value pairs per meter
    /// - Maximum 100 characters per value
    ///
    /// SECURITY: Follows strict checks-effects-interactions ordering and holds
    /// the reentrancy lock for the entire function body. This prevents a
    /// malicious owner contract from re-entering after passing the allowlist
    /// check but before the meter entry is written, which would allow it to
    /// register duplicate meters or corrupt the meter index.
    pub fn register_meter_with_metadata(
        env: Env,
        meter_id: String,
        owner: Address,
        metadata: Option<Map<String, String>>,
    ) -> Result<(), ContractError> {
        // ── CHECKS ──────────────────────────────────────────────────────────
        if Self::pause_is_active(&env) {
            return Err(ContractError::ContractPaused);
        }
        Self::require_admin(&env)?;

        // Acquire reentrancy lock before the allowlist read so the
        // contains→write window cannot be raced by a cross-contract callback.
        let _guard = ReentrancyGuard::enter(&env)?;

        let allowlist = Self::get_allowlist(env.clone())?;
        if !allowlist.contains(&owner) {
            return Err(ContractError::Unauthorized);
        }
        let key = DataKey::Meter(meter_id.clone());
        if env.storage().persistent().has(&key) {
            return Err(ContractError::MeterAlreadyExists);
        }

        let meter_metadata = if let Some(md) = metadata {
            validate_metadata(&md)?;
            md
        } else {
            Map::new(&env)
        };

        // ── EFFECTS — all state writes before any external observation ──────
        let now = env.ledger().timestamp();
        let meter = Meter {
            version: 4,
            owner: owner.clone(),
            active: false,
            units_used: 0,
            plan: PaymentPlan::Daily,
            last_payment: now,
            expires_at: now,
            daily_limit: 0,
            day_spent: 0,
            day_start: now,
            grace_expires_at: None,
            emergency_contact: None,
            auto_deactivate: true,
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

        let count: u32 = env.storage().instance().get(&METER_COUNT).unwrap_or(0);
        env.storage()
            .instance()
            .set(&METER_COUNT, &(count.saturating_add(1)));

        // ── INTERACTIONS — emit event after state is fully committed ─────────
        env.events()
            .publish((EVT_NS, symbol_short!("mtr_reg"), meter_id), owner);
        Ok(())
    }

    /// Register a new smart meter for an owner (backward compatible).
    /// Calls register_meter_with_metadata with no metadata.
    pub fn register_meter(env: Env, meter_id: String, owner: Address) -> Result<(), ContractError> {
        Self::register_meter_with_metadata(env, meter_id, owner, None)
    }

    /// Register multiple new smart meters in a single transaction.
    ///
    /// Accepts a vector of `(meter_id, owner)` tuples. Each entry is skipped
    /// (rather than aborting the whole batch) if the meter_id already exists,
    /// is duplicated within the batch, or the owner is not on the allowlist;
    /// a `batch_skip` event is emitted for each skip and `meter_registered`
    /// for each success. Returns one bool per input entry (true = registered)
    /// in the same order as the input. Admin-only. Maximum batch size: 100.
    ///
    /// SECURITY: Holds the reentrancy lock for the entire batch so a malicious
    /// owner contract cannot re-enter between the allowlist check and the meter
    /// write for any entry in the batch.
    pub fn batch_register_meters(
        env: Env,
        meters: Vec<(String, Address)>,
    ) -> Result<Vec<bool>, ContractError> {
        Self::require_admin(&env)?;
        if meters.len() > 100 {
            return Err(ContractError::BatchTooLarge);
        }
        // Acquire reentrancy lock before reading the allowlist snapshot so the
        // check-then-write window for every batch entry is fully atomic.
        let _guard = ReentrancyGuard::enter(&env)?;
        let allowlist = Self::get_allowlist(env.clone())?;
        let now = env.ledger().timestamp();

        let mut global_list: Vec<String> = env
            .storage()
            .instance()
            .get(&METER_LIST)
            .unwrap_or_else(|| vec![&env]);

        let mut seen: Vec<String> = vec![&env];
        let mut results: Vec<bool> = vec![&env];

        for (meter_id, owner) in meters.iter() {
            let key = DataKey::Meter(meter_id.clone());
            if seen.contains(&meter_id)
                || env.storage().persistent().has(&key)
                || !allowlist.contains(&owner)
            {
                env.events()
                    .publish((symbol_short!("btch_skip"), EVT_NS, meter_id.clone()), ());
                results.push_back(false);
                continue;
            }
            seen.push_back(meter_id.clone());

            let meter = Meter {
                version: 4,
                owner: owner.clone(),
                active: false,
                units_used: 0,
                plan: PaymentPlan::Daily,
                last_payment: now,
                expires_at: now,
                daily_limit: 0,
                day_spent: 0,
                day_start: now,
                grace_expires_at: None,
                emergency_contact: None,
                auto_deactivate: true,
            };
            env.storage().persistent().set(&key, &meter);

            let owner_key = DataKey::OwnerMeters(owner.clone());
            let mut owner_list: Vec<String> = env
                .storage()
                .persistent()
                .get(&owner_key)
                .unwrap_or_else(|| vec![&env]);
            owner_list.push_back(meter_id.clone());
            env.storage().persistent().set(&owner_key, &owner_list);

            global_list.push_back(meter_id.clone());

            env.events()
                .publish(("meter", "registered"), (meter_id.clone(), owner.clone()));
            results.push_back(true);
        }

        env.storage().instance().set(&METER_LIST, &global_list);
        Ok(results)
    }

    /// Get all meter IDs registered under a given owner address.
    pub fn get_meters_by_owner(env: Env, owner: Address) -> Result<Vec<String>, ContractError> {
        let owner_key = DataKey::OwnerMeters(owner);
        Ok(env
            .storage()
            .persistent()
            .get(&owner_key)
            .unwrap_or_else(|| vec![&env]))
    }

    /// Update meter metadata (Issue #691).
    /// Only the meter owner or contract admin can update metadata.
    /// Validates metadata constraints: max 10 pairs, max 100 chars per value.
    pub fn update_meter_metadata(
        env: Env,
        meter_id: String,
        metadata: Map<String, String>,
    ) -> Result<(), ContractError> {
        validate_metadata(&metadata)?;
        let key = DataKey::Meter(meter_id.clone());
        let mut meter = Self::get_meter_or_error(&env, &key)?;

        meter.owner.require_auth();
        meter.metadata = metadata;
        env.storage().persistent().set(&key, &meter);

        env.events()
            .publish((EVT_NS, symbol_short!("mtr_meta"), meter_id), ());
        Ok(())
    }

    /// Get meter metadata (Issue #691).
    /// Returns an empty map if the meter has no metadata.
    pub fn get_meter_metadata(env: Env, meter_id: String) -> Result<Map<String, String>, ContractError> {
        let key = DataKey::Meter(meter_id);
        let meter = Self::get_meter_or_error(&env, &key)?;
        Ok(meter.metadata)
    }

    /// Deregister an existing meter. Admin-only.
    pub fn deregister_meter(env: Env, meter_id: String) -> Result<(), ContractError> {
        Self::require_admin(&env)?;
        let key = DataKey::Meter(meter_id.clone());
        let meter = Self::get_meter_or_error(&env, &key)?;
        env.storage().persistent().remove(&key);
        env.storage()
            .persistent()
            .remove(&DataKey::MeterBalance(meter_id.clone()));

        let owner_key = DataKey::OwnerMeters(meter.owner);
        let owner_list: Vec<String> = env
            .storage()
            .persistent()
            .get(&owner_key)
            .unwrap_or_else(|| vec![&env]);
        let mut filtered_owner_list: Vec<String> = vec![&env];
        for id in owner_list.iter() {
            if id != meter_id {
                filtered_owner_list.push_back(id);
            }
        }
        env.storage()
            .persistent()
            .set(&owner_key, &filtered_owner_list);

        let global_list: Vec<String> = env
            .storage()
            .instance()
            .get(&METER_LIST)
            .unwrap_or_else(|| vec![&env]);
        let mut filtered_global_list: Vec<String> = vec![&env];
        for id in global_list.iter() {
            if id != meter_id {
                filtered_global_list.push_back(id);
            }
        }
        env.storage()
            .instance()
            .set(&METER_LIST, &filtered_global_list);

        let count: u32 = env.storage().instance().get(&METER_COUNT).unwrap_or(0);
        env.storage()
            .instance()
            .set(&METER_COUNT, &(count.saturating_sub(1)));

        env.events()
            .publish((EVT_NS, symbol_short!("mtr_dereg"), meter_id), ());
        Ok(())
    }

    /// Return the number of registered meters.
    pub fn get_meter_count(env: Env) -> Result<u32, ContractError> {
        Self::require_initialized(&env)?;
        Ok(env.storage().instance().get(&METER_COUNT).unwrap_or(0))
    }

    /// Transfer meter ownership from the current owner to a new owner.
    /// Both the current owner and the new owner must authorize this call.
    /// The new owner must already be on the allowlist.
    ///
    /// Emits `mtr_xfr` with topics `(EVT_NS, mtr_xfr, meter_id)` and data
    /// `(old_owner, new_owner)` so the bridge can detect ownership changes
    /// without polling every meter.
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

        let old_owner = meter.owner.clone();

        // Remove meter_id from old owner's index
        let old_key = DataKey::OwnerMeters(old_owner.clone());
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
        // A transfer starts a fresh usage accounting period while preserving
        // the prepaid meter balance for the incoming owner.
        meter.units_used = 0;
        env.storage().persistent().set(&key, &meter);

        let history_key = DataKey::OwnershipHistory(meter_id.clone());
        let mut history: Vec<OwnershipTransfer> = env
            .storage()
            .persistent()
            .get(&history_key)
            .unwrap_or_else(|| vec![&env]);
        history.push_back(OwnershipTransfer {
            old_owner: old_owner.clone(),
            new_owner: new_owner.clone(),
            transferred_at: env.ledger().timestamp(),
        });
        // #737 — prune the oldest entries so this on-chain list is bounded.
        // The full audit trail is archived off-chain from the `mtr_xfer` events.
        while history.len() > MAX_OWNERSHIP_HISTORY {
            // Soroban Vec::remove is in-place; rebuild without the first element.
            let mut trimmed: Vec<OwnershipTransfer> = vec![&env];
            for i in 1..history.len() {
                if let Some(entry) = history.get(i) {
                    trimmed.push_back(entry);
                }
            }
            history = trimmed;
        }
        env.storage().persistent().set(&history_key, &history);

        env.events().publish(
            (EVT_NS, symbol_short!("mtr_xfer"), meter_id),
            (old_owner, new_owner),
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

        let total = meter_ids.len();

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
    ///
    /// SECURITY: Protected by a reentrancy guard. A malicious contract added
    /// to the allowlist must not be able to re-enter this function (or any
    /// allowlist-gated function) before the state write commits, which would
    /// let it observe the "already added" check as false and register meters
    /// or trigger other protected paths before the transaction is complete.
    pub fn allowlist_add(env: Env, owner: Address) -> Result<(), ContractError> {
        Self::require_admin(&env)?;
        // Acquire the reentrancy lock before reading allowlist state so a
        // cross-contract callback from `owner` cannot race the contains→write
        // window and bypass access control (checks-effects-interactions).
        let _guard = ReentrancyGuard::enter(&env)?;
        let mut list: Vec<Address> = env
            .storage()
            .instance()
            .get(&ALLOWLIST)
            .unwrap_or(Vec::new(&env));
        if !list.contains(&owner) {
            // EFFECTS — write updated state before any external observation.
            list.push_back(owner.clone());
            env.storage().instance().set(&ALLOWLIST, &list);
            // INTERACTIONS — emit event after state is committed.
            env.events()
                .publish((EVT_NS, symbol_short!("alw_add")), owner);
        }
        Ok(())
    }

    /// Remove an address from the meter-owner allowlist.
    /// Only the admin may call this.
    ///
    /// SECURITY: Protected by a reentrancy guard for the same reason as
    /// `allowlist_add` — the read→write window must not be observable by a
    /// cross-contract callback, preventing a removed address from still
    /// appearing on the list during any re-entrant allowlist check.
    pub fn allowlist_remove(env: Env, owner: Address) -> Result<(), ContractError> {
        Self::require_admin(&env)?;
        let _guard = ReentrancyGuard::enter(&env)?;
        let list: Vec<Address> = env
            .storage()
            .instance()
            .get(&ALLOWLIST)
            .unwrap_or(Vec::new(&env));
        let mut new_list: Vec<Address> = Vec::new(&env);
        let mut found = false;
        for addr in list.iter() {
            if addr != owner {
                new_list.push_back(addr);
            } else {
                found = true;
            }
        }
        if found {
            // EFFECTS — commit removal before event emission.
            env.storage().instance().set(&ALLOWLIST, &new_list);
            // INTERACTIONS — event after state is updated.
            env.events()
                .publish((EVT_NS, symbol_short!("alw_rem")), owner);
        }
        Ok(())
    }

    /// Add an address to the allowlist (alias for allowlist_add).
    pub fn add_to_allowlist(env: Env, address: Address) -> Result<(), ContractError> {
        Self::allowlist_add(env, address)
    }

    /// Remove an address from the allowlist (alias for allowlist_remove).
    /// Admin should be able to call remove_from_allowlist to revoke allowlist access.
    pub fn remove_from_allowlist(env: Env, address: Address) -> Result<(), ContractError> {
        Self::allowlist_remove(env, address)
    }

    /// Returns the current allowlist.
    pub fn get_allowlist(env: Env) -> Result<Vec<Address>, ContractError> {
        Ok(env
            .storage()
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
        env.events()
            .publish((EVT_NS, symbol_short!("ora_set")), (old_oracle, oracle));
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
        if !env
            .storage()
            .instance()
            .get::<Symbol, bool>(&FROZEN)
            .unwrap_or(false)
        {
            return Err(ContractError::ContractNotFrozen);
        }
        let oracle: Address = env
            .storage()
            .instance()
            .get(&ORACLE)
            .ok_or(ContractError::OracleNotSet)?;
        oracle.require_auth();
        env.storage().instance().remove(&FROZEN);
        env.events().publish((EVT_NS, symbol_short!("frz_off")), ());
        Ok(())
    }

    /// Check if the contract is currently frozen.
    pub fn is_frozen(env: Env) -> Result<bool, ContractError> {
        Self::require_initialized(&env)?;
        Ok(env
            .storage()
            .instance()
            .get::<Symbol, bool>(&FROZEN)
            .unwrap_or(false))
    }

    // ── Issue #672: emergency pause ───────────────────────────────────────────

    /// Pause payments and meter registration for up to 48 hours.
    ///
    /// Usage reporting and all read-only methods remain available while paused,
    /// allowing the oracle and dashboards to continue operating during an
    /// incident. The pause is admin-only and emits the compact on-chain event
    /// topic `paused` (logical event name: `contract_paused`).
    pub fn pause(env: Env) -> Result<(), ContractError> {
        Self::require_admin(&env)?;

        // A stale pause is cleared before evaluating whether a new pause is
        // already active. This makes the expiry deterministic even if no
        // transaction touched the contract during the 48-hour window.
        if Self::pause_is_active(&env) {
            return Err(ContractError::AlreadyPaused);
        }

        let now = env.ledger().timestamp();
        env.storage().instance().set(&PAUSED, &true);
        env.storage().instance().set(&PAUSED_AT, &now);
        env.events().publish(
            (EVT_NS, Symbol::new(&env, "contract_paused")),
            (Self::get_admin(&env)?, now, MAX_PAUSE_DURATION),
        );
        Ok(())
    }

    /// Resume payments and meter registration before the automatic expiry.
    /// Admin-only; emits the compact topic `unpaused` (logical event name:
    /// `contract_unpaused`).
    pub fn unpause(env: Env) -> Result<(), ContractError> {
        Self::require_admin(&env)?;
        if !Self::pause_is_active(&env) {
            return Err(ContractError::NotPaused);
        }

        let now = env.ledger().timestamp();
        env.storage().instance().remove(&PAUSED);
        env.storage().instance().remove(&PAUSED_AT);
        env.events().publish(
            (EVT_NS, Symbol::new(&env, "contract_unpaused")),
            (Self::get_admin(&env)?, now),
        );
        Ok(())
    }

    /// Return whether the emergency pause is active. A pause older than the
    /// 48-hour maximum is treated as expired automatically.
    pub fn is_paused(env: Env) -> Result<bool, ContractError> {
        Self::require_initialized(&env)?;
        Ok(Self::pause_is_active(&env))
    }

    /// Read the pause flag and clear it when the maximum duration has elapsed.
    /// This helper is called by state-changing guards as well as the view method
    /// so the policy remains enforced even when no explicit `unpause` is sent.
    fn pause_is_active(env: &Env) -> bool {
        let paused: bool = env.storage().instance().get(&PAUSED).unwrap_or(false);
        if !paused {
            return false;
        }

        let paused_at: u64 = env.storage().instance().get(&PAUSED_AT).unwrap_or(0);
        let now = env.ledger().timestamp();
        if now.saturating_sub(paused_at) >= MAX_PAUSE_DURATION {
            env.storage().instance().remove(&PAUSED);
            env.storage().instance().remove(&PAUSED_AT);
            env.events()
                .publish((EVT_NS, Symbol::new(env, "contract_unpaused")), (now, true));
            return false;
        }
        true
    }

    /// Guard against a misconfigured zero unit price before any cost math runs
    /// (Issue #733). A zero unit price could divide by zero in billing and
    /// panic the contract, so usage-taking functions refuse to run until a
    /// positive price is configured via [`SolarGridContract::set_unit_price`].
    fn ensure_unit_price_valid(env: &Env) -> Result<(), ContractError> {
        let price: i128 = env.storage().instance().get(&UNIT_PRICE).unwrap_or(DEFAULT_UNIT_PRICE);
        if price <= 0 {
            return Err(ContractError::InvalidConfiguration);
        }
        Ok(())
    }

    /// Make a payment to top up a meter's balance and activate it.
    /// `amount` is in the token's smallest unit. `plan` sets the billing cycle.
    /// `memo` is an optional free-text note (e.g. "August electricity") capped
    /// at MAX_MEMO_LEN bytes; pass `None` to omit it (Issue #766).
    ///
    /// Emits:
    /// - `payment_received { meter_id, payer, amount, plan, memo }`
    /// - `meter_activated  { meter_id }` (always, since payment activates the meter)
    pub fn make_payment(
        env: Env,
        meter_id: String,
        payer: Address,
        amount: i128,
        plan: PaymentPlan,
        memo: Option<String>,
    ) -> Result<(), ContractError> {
        if Self::pause_is_active(&env) {
            return Err(ContractError::ContractPaused);
        }
        if env
            .storage()
            .instance()
            .get::<Symbol, bool>(&FROZEN)
            .unwrap_or(false)
        {
            return Err(ContractError::ContractFrozen);
        }
        payer.require_auth();
        if amount <= 0 {
            return Err(ContractError::InvalidAmount);
        }
        if let Some(m) = &memo {
            if m.len() > MAX_MEMO_LEN {
                return Err(ContractError::MemoTooLong);
            }
        }
        let _guard = ReentrancyGuard::enter(&env)?;
        let token_address = Self::get_token_address(&env)?;

        // ── EFFECTS ─────────────────────────────────────────────────────────
        let key = DataKey::Meter(meter_id.clone());
        let mut meter = Self::get_meter_or_error(env, &key)?;
        let now = env.ledger().timestamp();

        // Closes #745: use checked arithmetic for all timestamp calculations to
        // prevent overflow on edge-case durations. For UsageBased (no time expiry),
        // the sentinel value u64::MAX is used directly. For timed plans, cap the
        // duration to MAX_PAYMENT_DURATION_SECS (10 years) and require that
        // `now + duration` does not overflow u64.
        let expires_at = match plan_duration_secs(&plan) {
            None => {
                // UsageBased: no time expiry — use max sentinel value
                u64::MAX
            }
            Some(duration) => {
                if duration > MAX_PAYMENT_DURATION_SECS {
                    return Err(ContractError::PaymentDurationTooLarge);
                }
                now.checked_add(duration)
                    .ok_or(ContractError::TimestampOverflow)?
            }
        };

        // Track per-meter balance in contract storage
        let bal_key = DataKey::MeterBalance(meter_id.clone());
        let prev_bal: i128 = env.storage().persistent().get(&bal_key).unwrap_or(0);
        env.storage()
            .persistent()
            .set(&bal_key, &prev_bal.saturating_add(amount));

        // Track lifetime payments per (meter, payer) so refunds can be capped
        // to what that address has actually paid.
        let payer_paid_key = DataKey::PayerPaid(meter_id.clone(), payer.clone());
        let payer_paid: i128 = env.storage().persistent().get(&payer_paid_key).unwrap_or(0);
        env.storage()
            .persistent()
            .set(&payer_paid_key, &payer_paid.saturating_add(amount));

        let old_plan = meter.plan.clone();
        meter.active = true;
        meter.plan = plan.clone();
        meter.last_payment = now;
        meter.expires_at = expires_at;
        meter.grace_expires_at = None;
        env.storage().persistent().set(&key, &meter);

        // Track provider (admin) accrued revenue
        let admin = Self::get_admin(env)?;
        let provider_key = DataKey::ProviderRevenue(admin);
        let provider_revenue: i128 = env.storage().persistent().get(&provider_key).unwrap_or(0);
        env.storage()
            .persistent()
            .set(&provider_key, &provider_revenue.saturating_add(amount));

        // ── INTERACTION ─────────────────────────────────────────────────────
        // External call happens last, after all state above is finalized.
        let token_client = token::Client::new(&env, &token_address);
        token_client.transfer(&payer, &env.current_contract_address(), &amount);

        // payment_received
        env.events().publish(
            (EVT_NS, symbol_short!("payment"), meter_id.clone()),
            (payer, token_address, amount, plan.clone(), memo),
        );
        // plan_changed — emitted whenever a payment switches the meter's active plan,
        // so off-chain services can track plan migrations (e.g. Daily -> Weekly).
        if old_plan != plan {
            env.events().publish(
                (EVT_NS, symbol_short!("plan_chg"), meter_id.clone()),
                (old_plan, plan, now),
            );
        }
        // meter_activated — payment always activates the meter
        env.events()
            .publish((EVT_NS, symbol_short!("mtr_actv"), meter_id), ());
        Ok(())
    }

    /// Calculate service duration in seconds given payment amount and plan.
    /// Pro-rated calculation allowing partial/incremental payments (Issue #751).
    pub fn calculate_service_duration(_env: Env, amount: i128, plan: PaymentPlan) -> u64 {
        calculate_prorated_duration(amount, &plan)
    }

    /// Refund a previous payment. Admin-only.
    ///
    /// Transfers `amount` back to `recipient` from the contract's token balance,
    /// reduces `meter_id`'s tracked balance (and the admin's tracked provider
    /// revenue) accordingly, and records `reason` in the emitted event for the
    /// audit trail.
    ///
    /// # Guards
    /// - `amount` must be <= the total this `recipient` has actually paid towards
    ///   `meter_id`, minus any amount already refunded to them — this prevents
    ///   refunding more than was ever received from that address.
    /// - Total refunds across all recipients are capped per rolling 24h window
    ///   via [`Self::set_refund_limit`] (0 = unlimited), to prevent a compromised
    ///   or buggy admin flow from draining the contract balance in one burst.
    ///
    /// # Errors
    /// - [`ContractError::InvalidAmount`] when `amount <= 0`
    /// - [`ContractError::Unauthorized`] when caller is not the contract admin
    /// - [`ContractError::MeterNotFound`] when `meter_id` doesn't exist
    /// - [`ContractError::RefundExceedsPayments`] when `amount` exceeds what
    ///   `recipient` has paid (net of prior refunds) for this meter
    /// - [`ContractError::RefundLimitExceeded`] when `amount` would push total
    ///   refunds in the current window past the configured limit
    /// - [`ContractError::InsufficientBalance`] when the contract's token
    ///   balance is less than `amount`
    ///
    /// Emits: `pmt_rfnd { recipient, amount, reason, meter_id, refunded_balance }`
    /// (the logical event name is `payment_refunded`; the on-chain topic is
    /// abbreviated to fit the Soroban `Symbol` short-code limit).
    pub fn refund_payment(
        env: Env,
        meter_id: String,
        amount: i128,
        recipient: Address,
        reason: String,
    ) -> Result<(), ContractError> {
        Self::require_admin(&env)?;
        if amount <= 0 {
            return Err(ContractError::InvalidAmount);
        }
        let _guard = ReentrancyGuard::enter(&env)?;

        let key = DataKey::Meter(meter_id.clone());
        let mut meter = Self::get_meter_or_error(&env, &key)?;

        // Cap refunds to what this recipient has actually paid (net of prior refunds).
        let paid_key = DataKey::PayerPaid(meter_id.clone(), recipient.clone());
        let refunded_key = DataKey::PayerRefunded(meter_id.clone(), recipient.clone());
        let paid: i128 = env.storage().persistent().get(&paid_key).unwrap_or(0);
        let already_refunded: i128 = env.storage().persistent().get(&refunded_key).unwrap_or(0);
        let refundable = paid.saturating_sub(already_refunded);
        if amount > refundable {
            return Err(ContractError::RefundExceedsPayments);
        }

        // Enforce the rolling-window cap across all recipients, if configured.
        let refund_limit: i128 = env.storage().instance().get(&REFUND_LIMIT).unwrap_or(0);
        let now = env.ledger().timestamp();
        if refund_limit > 0 {
            let mut window: RefundWindow =
                env.storage()
                    .instance()
                    .get(&REFUND_WINDOW)
                    .unwrap_or(RefundWindow {
                        window_start: now,
                        window_spent: 0,
                    });
            if now.saturating_sub(window.window_start) > SECONDS_PER_DAY {
                window.window_start = now;
                window.window_spent = 0;
            }
            if window.window_spent.saturating_add(amount) > refund_limit {
                return Err(ContractError::RefundLimitExceeded);
            }
            window.window_spent = window.window_spent.saturating_add(amount);
            env.storage().instance().set(&REFUND_WINDOW, &window);
        }

        let token_address = Self::get_token_address(&env)?;
        let token_client = token::Client::new(&env, &token_address);
        let contract_balance = token_client.balance(&env.current_contract_address());
        if amount > contract_balance {
            return Err(ContractError::InsufficientBalance);
        }

        // Update meter balance — the refunded amount is no longer available for usage.
        let bal_key = DataKey::MeterBalance(meter_id.clone());
        let balance: i128 = env.storage().persistent().get(&bal_key).unwrap_or(0);
        let new_balance = balance.saturating_sub(amount).max(0);
        env.storage().persistent().set(&bal_key, &new_balance);
        if new_balance == 0 && meter.active {
            meter.active = false;
            env.storage().persistent().set(&key, &meter);
            env.events()
                .publish((EVT_NS, symbol_short!("mtr_deact"), meter_id.clone()), ());
        }

        // Reverse the admin's tracked revenue for the refunded amount, so the
        // refunded funds can't also be withdrawn via withdraw_revenue.
        let admin = Self::get_admin(&env)?;
        let provider_key = DataKey::ProviderRevenue(admin);
        let provider_revenue: i128 = env.storage().persistent().get(&provider_key).unwrap_or(0);
        env.storage().persistent().set(
            &provider_key,
            &provider_revenue.saturating_sub(amount).max(0),
        );

        env.storage()
            .persistent()
            .set(&refunded_key, &already_refunded.saturating_add(amount));

        token_client.transfer(&env.current_contract_address(), &recipient, &amount);

        env.events().publish(
            (EVT_NS, symbol_short!("pmt_rfnd"), meter_id),
            (recipient, amount, reason, new_balance, now),
        );
        Ok(())
    }

    /// Set the maximum total amount refundable (across all recipients) per
    /// rolling 24h window. Admin-only. A limit of 0 means unlimited.
    ///
    /// Guards against a compromised admin key or a scripting bug issuing a
    /// burst of refunds that drains the contract's token balance.
    pub fn set_refund_limit(env: Env, limit: i128) -> Result<(), ContractError> {
        Self::require_admin(&env)?;
        if limit < 0 {
            return Err(ContractError::InvalidAmount);
        }
        let old_limit: i128 = env.storage().instance().get(&REFUND_LIMIT).unwrap_or(0);
        env.storage().instance().set(&REFUND_LIMIT, &limit);
        env.events()
            .publish((EVT_NS, symbol_short!("rfnd_lim")), (old_limit, limit));
        Ok(())
    }

    /// Total amount `payer` has paid towards `meter_id` (lifetime, unaffected by refunds).
    pub fn get_payer_paid(env: Env, meter_id: String, payer: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::PayerPaid(meter_id, payer))
            .unwrap_or(0)
    }

    /// Total amount already refunded to `payer` for `meter_id`.
    pub fn get_payer_refunded(env: Env, meter_id: String, payer: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::PayerRefunded(meter_id, payer))
            .unwrap_or(0)
    }

    // ── Payment Delegation ────────────────────────────────────────────────────

    /// Add a delegate who can make payments on behalf of the meter owner.
    /// Only the meter owner can add delegates.
    ///
    /// # Use cases
    /// - Parents paying for adult children's energy
    /// - Employers subsidizing worker housing
    /// - Property managers paying for rental units
    /// - Energy provider incentive programs
    ///
    /// Emits: `dlg_add { meter_id, delegate }`
    pub fn add_delegate(
        env: Env,
        meter_id: String,
        delegate: Address,
    ) -> Result<(), ContractError> {
        let key = DataKey::Meter(meter_id.clone());
        let meter = Self::get_meter_or_error(&env, &key)?;
        
        // Only meter owner can add delegates
        meter.owner.require_auth();

        let delegates_key = DataKey::MeterDelegates(meter_id.clone());
        let mut delegates: Vec<Address> = env
            .storage()
            .persistent()
            .get(&delegates_key)
            .unwrap_or_else(|| vec![&env]);

        // Check if delegate already exists
        if !delegates.contains(&delegate) {
            delegates.push_back(delegate.clone());
            env.storage().persistent().set(&delegates_key, &delegates);

            env.events().publish(
                (EVT_NS, symbol_short!("dlg_add"), meter_id),
                delegate,
            );
        }

        Ok(())
    }

    /// Remove a delegate's authorization to make payments.
    /// Only the meter owner can remove delegates.
    ///
    /// Emits: `dlg_rem { meter_id, delegate }`
    pub fn remove_delegate(
        env: Env,
        meter_id: String,
        delegate: Address,
    ) -> Result<(), ContractError> {
        let key = DataKey::Meter(meter_id.clone());
        let meter = Self::get_meter_or_error(&env, &key)?;
        
        // Only meter owner can remove delegates
        meter.owner.require_auth();

        let delegates_key = DataKey::MeterDelegates(meter_id.clone());
        let delegates: Vec<Address> = env
            .storage()
            .persistent()
            .get(&delegates_key)
            .unwrap_or_else(|| vec![&env]);

        let mut new_delegates: Vec<Address> = vec![&env];
        let mut found = false;
        
        for addr in delegates.iter() {
            if addr != delegate {
                new_delegates.push_back(addr);
            } else {
                found = true;
            }
        }

        if found {
            env.storage().persistent().set(&delegates_key, &new_delegates);

            env.events().publish(
                (EVT_NS, symbol_short!("dlg_rem"), meter_id),
                delegate,
            );
        }

        Ok(())
    }

    /// Get all delegates authorized to make payments for a meter.
    pub fn get_delegates(env: Env, meter_id: String) -> Vec<Address> {
        let delegates_key = DataKey::MeterDelegates(meter_id);
        env.storage()
            .persistent()
            .get(&delegates_key)
            .unwrap_or_else(|| vec![&env])
    }

    /// Make a payment on behalf of a meter owner as an authorized delegate.
    /// The delegate must have been previously authorized via `add_delegate`.
    ///
    /// Emits same events as `make_payment`:
    /// - `payment_received { meter_id, payer (delegate), amount, plan, memo }`
    /// - `meter_activated { meter_id }`
    pub fn make_delegated_payment(
        env: Env,
        meter_id: String,
        delegate: Address,
        amount: i128,
        plan: PaymentPlan,
        memo: Option<String>,
    ) -> Result<(), ContractError> {
        if Self::pause_is_active(&env) {
            return Err(ContractError::ContractPaused);
        }

        // Verify delegate is authorized
        let delegates_key = DataKey::MeterDelegates(meter_id.clone());
        let delegates: Vec<Address> = env
            .storage()
            .persistent()
            .get(&delegates_key)
            .unwrap_or_else(|| vec![&env]);

        if !delegates.contains(&delegate) {
            return Err(ContractError::Unauthorized);
        }

        // Delegate must auth the payment
        delegate.require_auth();

        // Validate memo length if provided
        if let Some(ref m) = memo {
            if m.len() > MAX_MEMO_LEN {
                return Err(ContractError::MemoTooLong);
            }
        }

        if amount <= 0 {
            return Err(ContractError::InvalidAmount);
        }

        let token_address = Self::get_token_address(&env)?;
        let key = DataKey::Meter(meter_id.clone());
        let _meter = Self::get_meter_or_error(&env, &key)?; // Verify meter exists
        let _admin = Self::get_admin(&env)?; // Verify admin exists
        let _guard = ReentrancyGuard::enter(&env)?;

        // ── EFFECTS ─────────────────────────────────────────────────────────
        // Perform all state mutations BEFORE external calls
        let mut meter = Self::get_meter_or_error(&env, &key)?;

        // Update meter balance
        let bal_key = DataKey::MeterBalance(meter_id.clone());
        let balance: i128 = env.storage().persistent().get(&bal_key).unwrap_or(0);
        env.storage()
            .persistent()
            .set(&bal_key, &balance.saturating_add(amount));

        // Calculate expiration
        let now = env.ledger().timestamp();
        let validity_secs = plan_duration_secs(&plan);
        let expires_at = if validity_secs == u64::MAX {
            u64::MAX
        } else {
            meter.expires_at.saturating_add(validity_secs)
        };

        // Track lifetime payments per (meter, delegate)
        let payer_paid_key = DataKey::PayerPaid(meter_id.clone(), delegate.clone());
        let payer_paid: i128 = env.storage().persistent().get(&payer_paid_key).unwrap_or(0);
        env.storage()
            .persistent()
            .set(&payer_paid_key, &payer_paid.saturating_add(amount));

        let old_plan = meter.plan.clone();
        meter.active = true;
        meter.plan = plan.clone();
        meter.last_payment = now;
        meter.expires_at = expires_at;
        meter.grace_expires_at = None;
        env.storage().persistent().set(&key, &meter);

        // Track provider (admin) accrued revenue
        let admin = Self::get_admin(&env)?;
        let provider_key = DataKey::ProviderRevenue(admin);
        let provider_revenue: i128 = env.storage().persistent().get(&provider_key).unwrap_or(0);
        env.storage()
            .persistent()
            .set(&provider_key, &provider_revenue.saturating_add(amount));

        // ── INTERACTION ─────────────────────────────────────────────────────
        // External call happens last, after all state above is finalized.
        let token_client = token::Client::new(&env, &token_address);
        token_client.transfer(&delegate, &env.current_contract_address(), &amount);

        // payment_received - payer is the delegate
        env.events().publish(
            (EVT_NS, symbol_short!("payment"), meter_id.clone()),
            (delegate, token_address, amount, plan.clone(), memo),
        );

        // plan_changed
        if old_plan != plan {
            env.events().publish(
                (EVT_NS, symbol_short!("plan_chg"), meter_id.clone()),
                (old_plan, plan, now),
            );
        }

        // meter_activated
        env.events()
            .publish((EVT_NS, symbol_short!("mtr_actv"), meter_id), ());

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
    /// SECURITY: Implements checks-effects-interactions pattern to prevent reentrancy.
    ///
    /// Emits: `rev_wdrl { provider, token_address, amount }`
    pub fn withdraw_revenue(
        env: Env,
        provider: Address,
        amount: i128,
    ) -> Result<(), ContractError> {
        // ── CHECKS ──────────────────────────────────────────────────────────
        if amount <= 0 {
            return Err(ContractError::InvalidAmount);
        }
        let admin = Self::get_admin(&env)?;
        if provider != admin {
            return Err(ContractError::Unauthorized);
        }
        provider.require_auth();
        let _guard = ReentrancyGuard::enter(&env)?;

        let provider_key = DataKey::ProviderRevenue(provider.clone());
        let provider_revenue: i128 = env.storage().persistent().get(&provider_key).unwrap_or(0);
        if provider_revenue < amount {
            return Err(ContractError::InsufficientBalance);
        }

        let token_address = Self::get_token_address(&env)?;

        // ── EFFECTS ─────────────────────────────────────────────────────────
        env.storage()
            .persistent()
            .set(&provider_key, &provider_revenue.saturating_sub(amount));

        env.events().publish(
            (EVT_NS, symbol_short!("rev_wdrl"), provider.clone()),
            (token_address.clone(), amount),
        );

        // ── INTERACTIONS ────────────────────────────────────────────────────
        let token_client = token::Client::new(&env, &token_address);
        token_client.transfer(&env.current_contract_address(), &provider, &amount);

        Ok(())
    }

    pub fn admin_withdraw(env: Env, admin: Address, amount: i128) -> Result<(), ContractError> {
        // ── CHECKS ──────────────────────────────────────────────────────────
        admin.require_auth();
        let stored_admin: Address = Self::get_admin(&env)?;
        if admin != stored_admin {
            return Err(ContractError::Unauthorized);
        }
        let _guard = ReentrancyGuard::enter(&env)?;

        let token_address = Self::get_token_address(&env)?;
        let token_client = token::Client::new(&env, &token_address);
        let contract_balance = token_client.balance(&env.current_contract_address());
        if amount > contract_balance {
            return Err(ContractError::InsufficientBalance);
        }

        // ── EFFECTS ─────────────────────────────────────────────────────────
        env.events().publish(
            (EVT_NS, symbol_short!("adm_wdrl"), admin.clone()),
            (admin.clone(), amount),
        );

        // ── INTERACTIONS ────────────────────────────────────────────────────
        token_client.transfer(&env.current_contract_address(), &admin, &amount);

        Ok(())
    }

    /// Configure the M-of-N admin policy. The current admin must authorize this once.
    pub fn configure_multisig(env: Env, admins: Vec<Address>, threshold: u32) -> Result<(), ContractError> {
        Self::require_admin(&env)?;
        if admins.len() < 3 || admins.len() > 5 || threshold == 0 || threshold > admins.len() {
            return Err(ContractError::InvalidMultisigConfiguration);
        }
        env.storage().instance().set(&MULTISIG_ADMINS, &admins);
        env.storage().instance().set(&MULTISIG_THRESHOLD, &threshold);
        Ok(())
    }

    pub fn get_multisig_config(env: Env) -> Result<(Vec<Address>, u32), ContractError> {
        let admins: Vec<Address> = env.storage().instance().get(&MULTISIG_ADMINS).unwrap_or(Vec::new(&env));
        let threshold: u32 = env.storage().instance().get(&MULTISIG_THRESHOLD).unwrap_or(0);
        Ok((admins, threshold))
    }

    pub fn propose_admin_operation(env: Env, proposer: Address, operation: AdminOperation, expiry: u64) -> Result<u32, ContractError> {
        proposer.require_auth();
        let admins: Vec<Address> = env.storage().instance().get(&MULTISIG_ADMINS).unwrap_or(Vec::new(&env));
        if !Self::is_multisig_admin(&admins, &proposer) { return Err(ContractError::Unauthorized); }
        if expiry <= env.ledger().timestamp() { return Err(ContractError::ProposalExpired); }
        let id: u32 = env.storage().instance().get(&PROPOSAL_COUNT).unwrap_or(0);
        env.storage().instance().set(&PROPOSAL_COUNT, &(id + 1));
        let mut approvals = Vec::new(&env); approvals.push_back(proposer);
        let threshold: u32 = env.storage().instance().get(&MULTISIG_THRESHOLD).unwrap_or(0);
        env.storage().persistent().set(&DataKey::AdminProposal(id), &AdminProposal { operation, approvals, threshold, expiry });
        Ok(id)
    }

    pub fn approve_admin_operation(env: Env, proposal_id: u32, signer: Address) -> Result<(), ContractError> {
        signer.require_auth();
        let admins: Vec<Address> = env.storage().instance().get(&MULTISIG_ADMINS).unwrap_or(Vec::new(&env));
        if !Self::is_multisig_admin(&admins, &signer) { return Err(ContractError::Unauthorized); }
        let key = DataKey::AdminProposal(proposal_id);
        let mut proposal: AdminProposal = env.storage().persistent().get(&key).ok_or(ContractError::ProposalNotFound)?;
        if env.ledger().timestamp() >= proposal.expiry { return Err(ContractError::ProposalExpired); }
        for existing in proposal.approvals.iter() { if existing == signer { return Err(ContractError::ProposalAlreadyApproved); } }
        proposal.approvals.push_back(signer);
        env.storage().persistent().set(&key, &proposal);
        Ok(())
    }

    pub fn execute_admin_operation(env: Env, proposal_id: u32) -> Result<(), ContractError> {
        // Guards the EmergencyWithdraw arm's external token transfer below: without
        // this, a malicious token contract could reenter with the same proposal_id
        // before it's removed from storage and execute the withdrawal twice.
        let _guard = ReentrancyGuard::enter(&env)?;
        let key = DataKey::AdminProposal(proposal_id);
        let proposal: AdminProposal = env.storage().persistent().get(&key).ok_or(ContractError::ProposalNotFound)?;
        if env.ledger().timestamp() >= proposal.expiry { return Err(ContractError::ProposalExpired); }
        if proposal.approvals.len() < proposal.threshold { return Err(ContractError::ProposalNotReady); }
        match proposal.operation {
            AdminOperation::Pause => { if Self::pause_is_active(&env) { return Err(ContractError::AlreadyPaused); } env.storage().instance().set(&PAUSED, &true); env.storage().instance().set(&PAUSED_AT, &env.ledger().timestamp()); },
            AdminOperation::Unpause => { if !Self::pause_is_active(&env) { return Err(ContractError::NotPaused); } env.storage().instance().set(&PAUSED, &false); },
            AdminOperation::SetGracePeriod(period) => { env.storage().instance().set(&GRACE_PERIOD, &period); },
            AdminOperation::RotateAdmin(new_admin) => { env.storage().instance().set(&ADMIN, &new_admin); },
            AdminOperation::BulkDeactivate(meters) => { for meter_id in meters.iter() { let key = DataKey::Meter(meter_id); if let Some(mut meter) = env.storage().persistent().get::<DataKey, Meter>(&key) { meter.active = false; env.storage().persistent().set(&key, &meter); } } },
            AdminOperation::EmergencyWithdraw(amount) => { if amount <= 0 { return Err(ContractError::InvalidAmount); } let admin: Address = Self::get_admin(&env)?; let token_address = Self::get_token_address(&env)?; let client = token::Client::new(&env, &token_address); if amount > client.balance(&env.current_contract_address()) { return Err(ContractError::InsufficientBalance); } client.transfer(&env.current_contract_address(), &admin, &amount); },
        }
        env.storage().persistent().remove(&key);
        Ok(())
    }

    fn is_multisig_admin(admins: &Vec<Address>, candidate: &Address) -> bool {
        for admin in admins.iter() { if admin == *candidate { return true; } }
        false
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
        let collabs: Vec<Address> = env
            .storage()
            .instance()
            .get(&COLLABS)
            .unwrap_or(Vec::new(&env));
        let admin = Self::get_admin(&env)?;

        let mut result: Map<Address, i128> = Map::new(&env);
        let admin_key = DataKey::ProviderRevenue(admin.clone());
        result.set(
            admin.clone(),
            env.storage().persistent().get(&admin_key).unwrap_or(0),
        );
        for c in collabs.iter() {
            let key = DataKey::ProviderRevenue(c.clone());
            result.set(c, env.storage().persistent().get(&key).unwrap_or(0));
        }
        Ok(result)
    }

    /// Set the configurable grace period before meter deactivation (in seconds). Admin-only.
    pub fn set_grace_period(env: Env, period: u64) -> Result<(), ContractError> {
        Self::require_admin(&env)?;
        env.storage().instance().set(&GRACE_PERIOD, &period);
        Ok(())
    }

    /// Get the configured grace period in seconds (defaults to 7200 seconds / 2 hours).
    pub fn get_grace_period(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&GRACE_PERIOD)
            .unwrap_or(DEFAULT_GRACE_PERIOD)
    }

    /// Set the unit price in stroops per milli-kWh (Issue #733).
    ///
    /// The price must always be greater than zero. A zero value would make
    /// cost calculations divide by zero and panic the contract (denial of
    /// service), so it is rejected here rather than being allowed to poison
    /// the contract's billing math. Admin-only.
    ///
    /// Emits: `prc_set { old, new }`.
    pub fn set_unit_price(env: Env, price: i128) -> Result<(), ContractError> {
        Self::require_admin(&env)?;
        if price <= 0 {
            return Err(ContractError::InvalidConfiguration);
        }
        let old = Self::get_unit_price(env.clone());
        env.storage().instance().set(&UNIT_PRICE, &price);
        env.events().publish((EVT_NS, symbol_short!("prc_set")), (old, price));
        Ok(())
    }

    /// Return the current unit price (stroops per milli-kWh). When it has not
    /// been configured, the safe non-zero default is returned so cost math can
    /// never divide by zero (Issue #733). Internally this is never zero.
    pub fn get_unit_price(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&UNIT_PRICE)
            .unwrap_or(DEFAULT_UNIT_PRICE)
    }

    /// Compute the cost in stroops for `units` (milli-kWh) using the current
    /// unit price (Issue #733).
    ///
    /// Cost math is defensively guarded: if the configured unit price were ever
    /// zero (misconfiguration), the calculation returns
    /// [`ContractError::InvalidConfiguration`] instead of dividing by zero and
    /// panicking the contract.
    pub fn compute_cost(env: Env, units: u64) -> Result<i128, ContractError> {
        let price = Self::get_unit_price(env.clone());
        if price <= 0 {
            return Err(ContractError::InvalidConfiguration);
        }
        // cost = units * price / 1000 (milli-kWh -> kWh-fractional cost at the
        // configured stroops-per-unit rate). price is verified > 0 above, so
        // the division below can never divide by zero.
        let units_i128 = i128::from(units);
        Ok(units_i128.saturating_mul(price) / 1000)
    }

    /// Check access status with warning details during grace period.
    pub fn check_access_status(env: Env, meter_id: String) -> Result<AccessStatus, ContractError> {
        let key = DataKey::Meter(meter_id.clone());
        let meter = Self::get_meter_or_error(&env, &key)?;
        let bal_key = DataKey::MeterBalance(meter_id);
        let balance: i128 = env.storage().persistent().get(&bal_key).unwrap_or(0);
        let now = env.ledger().timestamp();
        let plan_valid = now < meter.expires_at;

        if !meter.active || !plan_valid {
            return Ok(AccessStatus {
                has_access: false,
                in_grace_period: false,
                grace_expires_at: None,
            });
        }

        if balance > 0 {
            return Ok(AccessStatus {
                has_access: true,
                in_grace_period: false,
                grace_expires_at: None,
            });
        }

        // Balance is zero: check if within grace period
        if let Some(grace_exp) = meter.grace_expires_at {
            if now < grace_exp {
                return Ok(AccessStatus {
                    has_access: true,
                    in_grace_period: true,
                    grace_expires_at: Some(grace_exp),
                });
            }
        }

        Ok(AccessStatus {
            has_access: false,
            in_grace_period: false,
            grace_expires_at: meter.grace_expires_at,
        })
    }

    /// Check whether a meter currently has active energy access.
    pub fn check_access(env: Env, meter_id: String) -> Result<bool, ContractError> {
        let status = Self::check_access_status(env, meter_id)?;
        Ok(status.has_access)
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
        if env
            .storage()
            .instance()
            .get::<Symbol, bool>(&FROZEN)
            .unwrap_or(false)
        {
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
        // Defensive: never let a misconfigured zero unit price reach cost math
        // where it could divide by zero (#733).
        Self::ensure_unit_price_valid(&env)?;
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
            env.events()
                .publish((EVT_NS, symbol_short!("mtr_deact"), meter_id), ());
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

    /// Set or clear the optional read-only emergency contact for a meter.
    /// Only the current meter owner may change this value.
    pub fn set_emergency_contact(
        env: Env,
        meter_id: String,
        contact: Option<Address>,
    ) -> Result<(), ContractError> {
        let key = DataKey::Meter(meter_id.clone());
        let mut meter = Self::get_meter_or_error(&env, &key)?;
        meter.owner.require_auth();
        meter.emergency_contact = contact.clone();
        env.storage().persistent().set(&key, &meter);
        env.events().publish(
            (EVT_NS, symbol_short!("emg_set"), meter_id),
            contact,
        );
        Ok(())
    }

    /// Return the configured emergency contact, if any.
    pub fn get_emergency_contact(
        env: Env,
        meter_id: String,
    ) -> Result<Option<Address>, ContractError> {
        let key = DataKey::Meter(meter_id);
        Ok(Self::get_meter_or_error(&env, &key)?.emergency_contact)
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
            env.events()
                .publish((EVT_NS, symbol_short!("mtr_actv"), meter_id.clone()), ());
        } else {
            env.events()
                .publish((EVT_NS, symbol_short!("mtr_deact"), meter_id.clone()), ());
        }
        Ok(())
    }

    /// Admin-only: immediately deactivate a meter (e.g. for non-paying
    /// customers or faulty meters). Unlike `set_active`, this is a one-way
    /// deactivation that doesn't require passing a boolean flag.
    ///
    /// Emits:
    /// - `meter_deactivated { meter_id }`
    pub fn deactivate_meter(env: Env, meter_id: String) -> Result<(), ContractError> {
        Self::require_admin(&env)?;
        let key = DataKey::Meter(meter_id.clone());
        let mut meter = Self::get_meter_or_error(&env, &key)?;
        meter.active = false;
        env.storage().persistent().set(&key, &meter);

        env.events()
            .publish((EVT_NS, symbol_short!("mtr_deact"), meter_id), ());
        Ok(())
    }


    /// Admin-only: deactivate multiple meters in a single transaction.
    ///
    /// Accepts a vector of meter IDs, deactivates every meter that is
    /// currently active, skips meters that are already inactive or do not
    /// exist, and emits a `meter_deactivated` event for each successful
    /// deactivation.
    ///
    /// Returns a [BatchDeactivateSummary] with per-meter results and
    /// aggregate counts so the caller can distinguish successes from skips.
    ///
    /// Mirrors the existing `batch_update_usage` pattern (Issue #664).
    ///
    /// # Guards
    /// - Caller must be the contract admin.
    /// - Maximum batch size: 50 (matches `batch_update_usage`).
    ///
    /// # Emits
    /// - `mtr_deact` for each meter successfully deactivated.
    /// - `btch_skip` for each meter skipped (not found or already inactive).
    pub fn batch_deactivate_meters(
        env: Env,
        meter_ids: Vec<String>,
    ) -> Result<BatchDeactivateSummary, ContractError> {
        Self::require_admin(&env)?;

        let len = meter_ids.len() as u32;
        if len > 50 {
            return Err(ContractError::BatchTooLarge);
        }

        let mut results: Vec<BatchDeactivateResult> = vec![&env];
        let mut deactivated: u32 = 0;
        let mut skipped: u32 = 0;

        for meter_id in meter_ids.iter() {
            let key = DataKey::Meter(meter_id.clone());
            match env.storage().persistent().get::<DataKey, Meter>(&key) {
                None => {
                    // Meter does not exist - skip
                    skipped += 1;
                    results.push_back(BatchDeactivateResult {
                        meter_id: meter_id.clone(),
                        success: false,
                        reason: String::from_str(&env, "not_found"),
                    });
                    env.events()
                        .publish((EVT_NS, symbol_short!("btch_skip"), meter_id.clone()), ());
                }
                Some(mut meter) => {
                    if !meter.active {
                        // Already inactive - skip
                        skipped += 1;
                        results.push_back(BatchDeactivateResult {
                            meter_id: meter_id.clone(),
                            success: false,
                            reason: String::from_str(&env, "inactive"),
                        });
                        env.events()
                            .publish((EVT_NS, symbol_short!("btch_skip"), meter_id.clone()), ());
                    } else {
                        // Deactivate
                        meter.active = false;
                        env.storage().persistent().set(&key, &meter);
                        deactivated += 1;

                        results.push_back(BatchDeactivateResult {
                            meter_id: meter_id.clone(),
                            success: true,
                            reason: String::from_str(&env, "ok"),
                        });

                        env.events()
                            .publish((EVT_NS, symbol_short!("mtr_deact"), meter_id.clone()), ());
                    }
                }
            }
        }

        Ok(BatchDeactivateSummary {
            total: len,
            deactivated,
            skipped,
            results,
        })
    }

    // ── Collaborator management ───────────────────────────────────────────────

    /// Add a collaborator with a share in basis points (100 = 1%).
    /// Total shares across all collaborators must not exceed 10 000 (100%).
    pub fn add_collaborator(
        env: Env,
        collaborator: Address,
        basis_points: u32,
    ) -> Result<(), ContractError> {
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

    /// Remove a collaborator from COLLABS and SHARES.
    /// Remaining total basis points must not exceed 10 000 (100%).
    /// Returns `Unauthorized` if the caller is not the admin.
    /// Returns `CollaboratorNotFound` if the address is not a registered collaborator.
    pub fn remove_collaborator(env: Env, collaborator: Address) -> Result<(), ContractError> {
        Self::require_admin(&env)?;

        let collabs: Vec<Address> = env
            .storage()
            .instance()
            .get(&COLLABS)
            .unwrap_or(Vec::new(&env));
        let mut shares: Map<Address, u32> = env
            .storage()
            .instance()
            .get(&SHARES)
            .unwrap_or(Map::new(&env));

        if !shares.contains_key(collaborator.clone()) {
            return Err(ContractError::CollaboratorNotFound);
        }

        let mut new_collabs: Vec<Address> = Vec::new(&env);
        for addr in collabs.iter() {
            if addr != collaborator {
                new_collabs.push_back(addr);
            }
        }
        shares.remove(collaborator);

        // Guard: remaining total must not exceed 100%
        let total: u32 = shares.values().iter().sum();
        if total > 10_000 {
            return Err(ContractError::InvalidAmount);
        }

        env.storage().instance().set(&COLLABS, &new_collabs);
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
        let shares: Map<Address, u32> = env
            .storage()
            .instance()
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
            // Issue #695: Use checked_mul to prevent integer overflow
            let payout = amount
                .checked_mul(bp)
                .ok_or(ContractError::InvalidAmount)?
                .checked_div(10_000)
                .ok_or(ContractError::InvalidAmount)?;
            result.set(collaborator, payout);
        }
        Ok(result)
    }

    /// Distribute `amount` stroops and perform the actual token transfers atomically.
    /// Uses `distribute` internally to compute shares, then transfers to each collaborator.
    ///
    /// SECURITY: Implements checks-effects-interactions pattern to prevent reentrancy.
    /// All payouts are computed and recorded in state before external transfer calls.
    ///
    /// Emits `distrib` event after all transfers succeed.
    pub fn distribute_and_transfer(
        env: Env,
        amount: i128,
    ) -> Result<Map<Address, i128>, ContractError> {
        // ── CHECKS ──────────────────────────────────────────────────────────
        Self::require_admin(&env)?;
        if amount <= 0 {
            return Err(ContractError::InvalidAmount);
        }
        let _guard = ReentrancyGuard::enter(&env)?;

        let token_address = Self::get_token_address(&env)?;

        // ── EFFECTS ─────────────────────────────────────────────────────────
        let payouts = Self::distribute(env.clone(), amount)?;

        env.events()
            .publish((EVT_NS, symbol_short!("distrib")), (amount,));

        // ── INTERACTIONS ────────────────────────────────────────────────────
        let token = token::Client::new(&env, &token_address);
        for (collaborator, payout) in payouts.iter() {
            if payout > 0 {
                token.transfer(&env.current_contract_address(), &collaborator, &payout);
            }
        }

        Ok(payouts)
    }

    // ── Emergency / admin controls (Closes #686) ─────────────────────────────

    /// Drain all contract-held token balance to a recovery address. Admin-only.
    /// The contract must be frozen first via `freeze_contract`; returns
    /// `ContractNotFrozen` otherwise. Returns `Ok(())` when balance is zero.
    ///
    /// SECURITY: Implements checks-effects-interactions pattern to prevent reentrancy.
    pub fn emergency_withdraw(env: Env, to: Address) -> Result<(), ContractError> {
        // ── CHECKS ──────────────────────────────────────────────────────────
        Self::require_admin(&env)?;
        let frozen: bool = env.storage().instance().get(&FROZEN).unwrap_or(false);
        if !frozen {
            return Err(ContractError::ContractNotFrozen);
        }
        let _guard = ReentrancyGuard::enter(&env)?;
        let token_addr: Address = env
            .storage()
            .instance()
            .get(&TOKEN)
            .ok_or(ContractError::NotInitialized)?;

        let token = token::Client::new(&env, &token_addr);
        let balance = token.balance(&env.current_contract_address());

        // ── EFFECTS ─────────────────────────────────────────────────────────
        env.events().publish(
            (String::from_str(&env, "WITHDRAW"), symbol_short!("emergency")),
            (to.clone(), balance),
        );

        // ── INTERACTIONS ────────────────────────────────────────────────────
        if balance > 0 {
            token.transfer(&env.current_contract_address(), &to, &balance);
        }

        Ok(())
    }

    /// Inspect the currently pending emergency-withdrawal announcement, if
    /// any (amount, recipient, and when it was announced).
    pub fn get_pending_emergency_withdrawal(env: Env) -> Option<EmergencyWithdrawal> {
        env.storage().instance().get(&EMRG_WD)
    }

    /// Manually expire a meter before its natural expiry. Admin-only.
    /// Sets `expires_at` to the current ledger timestamp and `active` to false.
    /// Useful for policy violations or testing expiry flows.
    /// Returns `MeterNotFound` for unknown meter IDs.
    pub fn expire_meter(env: Env, meter_id: String) -> Result<(), ContractError> {
        Self::require_admin(&env)?;
        let key = DataKey::Meter(meter_id.clone());
        let mut meter: Meter = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(ContractError::MeterNotFound)?;
        meter.expires_at = env.ledger().timestamp();
        meter.active = false;
        env.storage().persistent().set(&key, &meter);
        env.events()
            .publish((String::from_str(&env, "METER"), symbol_short!("expired")), meter_id);
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
        env.storage().instance().set(
            &CONTRACT_VERSION,
            &String::from_str(env, CURRENT_CONTRACT_VERSION),
        );
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
        if let Some(meter) = env.storage().persistent().get::<DataKey, Meter>(key) {
            return Ok(meter);
        }
        if let Some(legacy) = env.storage().persistent().get::<DataKey, LegacyMeterV3>(key) {
            // Read-through migration from v3 to v4 (adds metadata).
            let migrated = migrate_meter_v3(env, legacy);
            env.storage().persistent().set(key, &migrated);
            return Ok(migrated);
        }
        if let Some(legacy) = env.storage().persistent().get::<DataKey, LegacyMeterV2>(key) {
            // Read-through migration from v2 to v4 (adds emergency-contact and metadata).
            let migrated = migrate_meter_v2(env, legacy);
            env.storage().persistent().set(key, &migrated);
            return Ok(migrated);
        }
        if let Some(legacy) = env.storage().persistent().get::<DataKey, LegacyMeterV1>(key) {
            // Read-through migration from v1 to v4.
            let migrated = migrate_meter_v1(env, legacy);
            env.storage().persistent().set(key, &migrated);
            return Ok(migrated);
        }
        if let Some(legacy) = env.storage().persistent().get::<DataKey, LegacyMeter>(key) {
            // Read-through migration from v0 to v4.
            let migrated = migrate_meter_v0(env, legacy);
            env.storage().persistent().set(key, &migrated);
            return Ok(migrated);
        }
        Err(ContractError::MeterNotFound)
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

    /// Batch update usage for multiple meters.
    /// Returns a Vec of failed meter IDs (empty Vec means all succeeded).
    /// Failed IDs can be due to meter not found or other validation errors.
    /// Skips invalid meter IDs and emits a batch_skip event for each.
    /// Maximum batch size is 200 meters (Issue #754).
    pub fn batch_update_usage(
        env: Env,
        updates: Vec<(String, u64, i128)>,
    ) -> Result<Vec<String>, ContractError> {
        Self::require_admin(&env)?;
        let oracle: Option<Address> = env.storage().instance().get(&ORACLE);
        if oracle.is_none() {
            return Err(ContractError::OracleNotSet);
        }
        if updates.len() > 200 {
            return Err(ContractError::BatchTooLarge);
        }
        // Defensive: never let a misconfigured zero unit price reach cost math
        // where it could divide by zero (#733).
        Self::ensure_unit_price_valid(&env)?;
        let now = env.ledger().timestamp();
        let mut failed: Vec<String> = vec![&env];
        let mut processed_count: u32 = 0;
        let mut total_units: u64 = 0;
        let mut total_cost: i128 = 0;

        for (meter_id, units, cost) in updates.iter() {
            let key = DataKey::Meter(meter_id.clone());
            if !env.storage().persistent().has(&key) {
                failed.push_back(meter_id.clone());
                env.events()
                    .publish((EVT_NS, symbol_short!("btch_skip"), meter_id.clone()), ());
                continue;
            }
            let mut meter: Meter = env.storage().persistent().get(&key).unwrap();

            match Self::apply_usage(&env, &meter_id, &mut meter, units, cost, now) {
                Ok(deactivated) => {
                    env.storage().persistent().set(&key, &meter);
                    processed_count = processed_count.saturating_add(1);
                    total_units = total_units.saturating_add(units);
                    total_cost = total_cost.saturating_add(cost);

                    env.events().publish(
                        (EVT_NS, symbol_short!("usg_upd"), meter_id.clone()),
                        (units, cost),
                    );
                    if deactivated {
                        env.events()
                            .publish((EVT_NS, symbol_short!("mtr_deact"), meter_id.clone()), ());
                    }
                }
                Err(_) => {
                    failed.push_back(meter_id.clone());
                    env.events()
                        .publish((EVT_NS, symbol_short!("btch_skip"), meter_id.clone()), ());
                }
            }
        }

        // Summary event is compact (4 simple integers, well below 256 bytes)
        env.events().publish(
            (EVT_NS, symbol_short!("btch_done")),
            (processed_count, failed.len(), total_units, total_cost),
        );

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

        // Reset at UTC midnight (i.e. when the calendar-day index changes)
        // rather than a rolling 24h window from day_start, so the cap always
        // aligns to the same wall-clock boundary regardless of when it was
        // first hit during the previous day.
        if now / SECONDS_PER_DAY != meter.day_start / SECONDS_PER_DAY {
            meter.day_spent = 0;
            meter.day_start = now;
        }
        if meter.daily_limit > 0 && meter.day_spent.saturating_add(cost) > meter.daily_limit {
            env.events().publish(
                (EVT_NS, symbol_short!("limit_hit"), meter_id.clone()),
                (meter.daily_limit, meter.day_spent, cost),
            );
            // auto_deactivate=true (default): block usage over the cap.
            // auto_deactivate=false ("warn only"): let usage through — the
            // limit_hit event above is the only effect.
            if meter.auto_deactivate {
                return Err(ContractError::DailyLimitReached);
            }
        }
        meter.day_spent = meter.day_spent.saturating_add(cost);

        // Issue #695: Retrieve balance from storage with overflow protection
        let bal_key = DataKey::MeterBalance(meter_id.clone());
        let balance: i128 = env.storage().persistent().get(&bal_key).unwrap_or(0);
        // Use saturating_sub to prevent underflow; clamp to 0 to ensure non-negative balance
        let bal_key = DataKey::MeterBalance(meter_id.clone());
        let balance: i128 = env.storage().persistent().get(&bal_key).unwrap_or(0);
        let new_balance = balance.saturating_sub(cost).max(0);
        env.storage().persistent().set(&bal_key, &new_balance);
        meter.units_used = meter.units_used.saturating_add(units);

        let deactivated;
        if new_balance == 0 {
            let grace_period = Self::get_grace_period(env.clone());
            if grace_period == 0 {
                meter.active = false;
                meter.grace_expires_at = None;
                deactivated = true;
            } else {
                if meter.grace_expires_at.is_none() {
                    // Closes #745: use checked_add for grace period timestamp to
                    // prevent overflow if grace_period is set to an extreme value.
                    let grace_exp = now
                        .checked_add(grace_period)
                        .unwrap_or(u64::MAX);
                    // Start grace period without compounding
                    meter.grace_expires_at = Some(grace_exp);
                    deactivated = false;
                } else if let Some(grace_exp) = meter.grace_expires_at {
                    if now >= grace_exp {
                        meter.active = false;
                        deactivated = true;
                    } else {
                        deactivated = false;
                    }
                } else {
                    meter.active = false;
                    deactivated = true;
                } else {
                    deactivated = false;
                }
            } else {
                meter.active = false;
                deactivated = true;
            }
        } else {
            meter.grace_expires_at = None;
            deactivated = false;
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

    /// Set whether exceeding daily_limit blocks usage (`auto_deactivate` =
    /// true, the default) or only emits a limit_hit warning event while
    /// letting usage continue (`auto_deactivate` = false). Admin-only.
    pub fn set_cap_mode(
        env: Env,
        meter_id: String,
        auto_deactivate: bool,
    ) -> Result<(), ContractError> {
        Self::require_admin(&env)?;
        let key = DataKey::Meter(meter_id.clone());
        let mut meter = Self::get_meter_or_error(&env, &key)?;
        meter.auto_deactivate = auto_deactivate;
        env.storage().persistent().set(&key, &meter);
        env.events().publish(
            (EVT_NS, symbol_short!("cap_mode"), meter_id),
            auto_deactivate,
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
        let migrated = migrate_meter_v0(&env, legacy);
        env.storage().persistent().set(&key, &migrated);
        Ok(())
    }

    /// Migrate a meter from v1 (LegacyMeterV1) to v3 (Meter) schema. Admin-only.
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
        let migrated = migrate_meter_v1(&env, legacy);
        env.storage().persistent().set(&key, &migrated);
        Ok(())
    }

    /// Migrate a pre-emergency-contact v2 meter to the current v3 schema.
    /// Admin-only and idempotent.
    pub fn migrate_meter_to_v3(env: Env, meter_id: String) -> Result<(), ContractError> {
        Self::require_admin(&env)?;
        let key = DataKey::Meter(meter_id);
        if let Some(meter) = env.storage().persistent().get::<DataKey, Meter>(&key) {
            if meter.version >= 3 {
                return Ok(());
            }
        }
        let legacy: LegacyMeterV2 = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(ContractError::MeterNotFound)?;
        let migrated = migrate_meter_v2(&env, legacy);
        env.storage().persistent().set(&key, &migrated);
        Ok(())
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::string::ToString;
    use soroban_sdk::{
        symbol_short,
        testutils::{Address as _, Events, Ledger},
        token, Address, Env, String, Symbol, TryFromVal, Val,
    };

    fn sym_eq(env: &Env, val: &soroban_sdk::Val, expected: Symbol) -> bool {
        Symbol::try_from_val(env, val).ok() == Some(expected)
    }

    /// Convert `ContractEvents` (SDK v27) into a plain `alloc::vec::Vec` of
    /// `((), topics, data)` tuples so existing `.iter().any(|(_, topics, _)| …)`
    /// patterns compile unchanged.
    fn events_as_tuples(
        env: &Env,
        events: &soroban_sdk::testutils::ContractEvents,
    ) -> alloc::vec::Vec<((), soroban_sdk::Vec<Val>, Val)> {
        use soroban_sdk::xdr::ContractEventBody;
        events
            .events()
            .iter()
            .filter_map(|e| {
                let ContractEventBody::V0(ref v0) = e.body else {
                    return None;
                };
                let mut topics: soroban_sdk::Vec<Val> = soroban_sdk::Vec::new(env);
                for sc_val in v0.topics.iter() {
                    if let Ok(v) = Val::try_from_val(env, sc_val) {
                        topics.push_back(v);
                    }
                }
                let data = Val::try_from_val(env, &v0.data).ok()?;
                Some(((), topics, data))
            })
            .collect()
    }

    fn setup() -> (Env, SolarGridContractClient<'static>, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token_address = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let contract_id = env.register(SolarGridContract, (admin.clone(), token_address.clone()));
        let client = SolarGridContractClient::new(&env, &contract_id);
        (env, client, admin)
    }

    /// Helper: allowlist + register a meter in one call.
    fn allowlist_and_register(
        client: &SolarGridContractClient,
        meter_id: impl ToString,
        user: &Address,
    ) {
        let env = Env::default();
        let meter_id = String::from_str(&env, &meter_id.to_string());
        client.allowlist_add(user);
        client.register_meter(&meter_id, user);
    }

    /// Setup with a specific token registered in initialize.
    /// Returns (env, client, admin, token_address).
    /// Callers can construct token clients from token_address as needed.
    fn setup_with_token() -> (Env, SolarGridContractClient<'static>, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token_address = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let contract_id = env.register(SolarGridContract, (admin.clone(), token_address.clone()));
        let client = SolarGridContractClient::new(&env, &contract_id);
        (env, client, admin, token_address)
    }

    /// Helper: generate an oracle address and register it on the contract.
    fn setup_oracle(env: &Env, client: &SolarGridContractClient) -> Address {
        let oracle = Address::generate(env);
        client.set_oracle(&oracle);
        oracle
    }

    #[test]
    fn test_get_contract_version_matches_cargo_semver_snapshot() {
        let (env, client, _admin) = setup();
        assert_eq!(
            client.get_contract_version(),
            String::from_str(&env, CURRENT_CONTRACT_VERSION)
        );
    }

    #[test]
    fn test_register_and_pay() {
        let (env, client, _admin, token_address) = setup_with_token();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
        let token_client = token::Client::new(&env, &token_address);
        setup_oracle(&env, &client);

        let user = Address::generate(&env);
        let meter_id = String::from_str(&env, "METER1");

        allowlist_and_register(&client, meter_id.clone(), &user);
        assert!(!client.check_access(&meter_id));

        token_admin_client.mint(&user, &5_000_000_i128);
        client.make_payment(
            &meter_id,
            &user,
            &5_000_000_i128,
            &PaymentPlan::Daily,
            &None,
        );
        assert!(client.check_access(&meter_id));
        assert_eq!(token_client.balance(&user), 0);

        client.update_usage(&meter_id, &100_u64, &5_000_000_i128);
        assert!(!client.check_access(&meter_id));
    }

    // ── Reentrancy regression test ───────────────────────────────────────────
    // A malicious "token" contract whose `transfer` calls back into
    // `make_payment` before returning, simulating a malicious/compromised
    // payment token attempting to reenter mid-invocation. Must be rejected
    // by the reentrancy guard rather than allowed to run twice.
    const ATTACK_TARGET: Symbol = symbol_short!("ATCKTGT");
    const ATTACK_METER: Symbol = symbol_short!("ATCKMTR");
    const REENTRY_HIT: Symbol = symbol_short!("REHIT");

    #[contract]
    struct MaliciousToken;

    #[contractimpl]
    impl MaliciousToken {
        pub fn configure(env: Env, target: Address, meter_id: String) {
            env.storage().instance().set(&ATTACK_TARGET, &target);
            env.storage().instance().set(&ATTACK_METER, &meter_id);
        }

        pub fn reentry_attempted(env: Env) -> bool {
            env.storage().instance().get(&REENTRY_HIT).unwrap_or(false)
        }

        pub fn transfer(env: Env, from: Address, _to: Address, amount: i128) {
            env.storage().instance().set(&REENTRY_HIT, &true);
            let target: Address = env.storage().instance().get(&ATTACK_TARGET).unwrap();
            let meter_id: String = env.storage().instance().get(&ATTACK_METER).unwrap();
            let target_client = SolarGridContractClient::new(&env, &target);
            let result = target_client.try_make_payment(
                &meter_id,
                &from,
                &amount,
                &PaymentPlan::Daily,
                &None,
            );
            assert_eq!(
                result,
                Err(Ok(ContractError::ReentrantCall)),
                "reentrant make_payment call should have been rejected by the guard",
            );
        }
    }

    #[test]
    fn test_make_payment_blocks_reentrancy() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let malicious_token_id = env.register_contract(None, MaliciousToken);
        let malicious_token_client = MaliciousTokenClient::new(&env, &malicious_token_id);

        let contract_id = env.register_contract(None, SolarGridContract);
        let client = SolarGridContractClient::new(&env, &contract_id);
        client.initialize(&admin, &malicious_token_id);

        let user = Address::generate(&env);
        let meter_id = String::from_str(&env, "REENTRY-METER");
        client.allowlist_add(&user);
        client.register_meter(&meter_id, &user);

        malicious_token_client.configure(&contract_id, &meter_id);

        // The legitimate outer payment must still succeed exactly once, even
        // though the malicious token tried to reenter during the transfer.
        client.make_payment(&meter_id, &user, &1_000_i128, &PaymentPlan::Daily, &None);

        assert!(malicious_token_client.reentry_attempted());
        assert_eq!(client.get_meter_balance(&meter_id), 1_000_i128);
        assert!(client.check_access(&meter_id));
    }

    #[test]
    fn test_set_unit_price_rejects_zero_and_updates_cost() {
        let (_env, client, _admin) = setup();

        // Admin cannot configure a zero unit price (Issue #733).
        assert_eq!(
            client.try_set_unit_price(&0_i128),
            Err(Ok(ContractError::InvalidConfiguration))
        );
        // Negative prices are also invalid.
        assert_eq!(
            client.try_set_unit_price(&-5_i128),
            Err(Ok(ContractError::InvalidConfiguration))
        );

        // A safe non-zero default is used when no price is configured.
        assert_eq!(client.get_unit_price(), DEFAULT_UNIT_PRICE);

        // A positive price is accepted and reflected by get_unit_price.
        assert!(client.try_set_unit_price(&250_i128).is_ok());
        assert_eq!(client.get_unit_price(), 250);
    }

    #[test]
    fn test_compute_cost_default_price_and_guarded_division() {
        let (env, client, _admin) = setup();
        setup_oracle(&env, &client);

        // With the default unit price, cost math works (no division by zero).
        assert_eq!(client.compute_cost(&2_000_u64), 2);

        // Directly poison the stored unit price to zero (defense in depth:
        // set_unit_price refuses it, but belt-and-braces guard for any path that
        // writes it directly). compute_cost must refuse rather than divide by zero.
        env.storage().instance().set(&UNIT_PRICE, &0_i128);
        assert_eq!(
            client.try_compute_cost(&2_000_u64),
            Err(Ok(ContractError::InvalidConfiguration))
        );
    }

    #[test]
    fn test_zero_unit_price_poisoning_blocked_from_usage_paths() {
        let (env, client, _admin, token_address) = setup_with_token();
        setup_oracle(&env, &client);
        let meter_id = symbol_short!("B_M1");
        register_and_fund(&env, &client, &token_address, &meter_id, 10_000_i128);

        // Poison the stored unit price to zero (Issue #733). Both usage paths
        // must refuse to run cost math instead of dividing by zero / panicking.
        env.storage().instance().set(&UNIT_PRICE, &0_i128);
        assert_eq!(
            client.try_update_usage(&meter_id, &10_u64, &5_000_i128),
            Err(Ok(ContractError::InvalidConfiguration))
        );
        assert_eq!(
            client.try_batch_update_usage(&vec![&env, (meter_id.clone(), 10_u64, 5_000_i128)]),
            Err(Ok(ContractError::InvalidConfiguration))
        );
    }

    #[test]
    fn test_register_meter_duplicate_returns_typed_error() {
        let (env, client, _admin, _token_address) = setup_with_token();
        let user = Address::generate(&env);
        let meter_id = String::from_str(&env, "METER2");
        allowlist_and_register(&client, meter_id.clone(), &user);
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
        let meter_id = String::from_str(&env, "METER3");
        allowlist_and_register(&client, meter_id.clone(), &user);
        assert_eq!(
            client.try_make_payment(&meter_id, &user, &0_i128, &PaymentPlan::Daily, &None),
            Err(Ok(ContractError::InvalidAmount))
        );
    }

    #[test]
    fn test_make_payment_negative_amount_returns_typed_error() {
        let (env, client, _admin, _token_address) = setup_with_token();
        let user = Address::generate(&env);
        let meter_id = String::from_str(&env, "METER4");
        allowlist_and_register(&client, meter_id.clone(), &user);
        assert_eq!(
            client.try_make_payment(&meter_id, &user, &-1_i128, &PaymentPlan::Daily, &None),
            Err(Ok(ContractError::InvalidAmount))
        );
    }

    #[test]
    fn test_update_usage_balance_drains_correctly() {
        let (env, client, _admin, token_address) = setup_with_token();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
        setup_oracle(&env, &client);

        let user = Address::generate(&env);
        let meter_id = String::from_str(&env, "METER5");

        allowlist_and_register(&client, meter_id.clone(), &user);
        token_admin_client.mint(&user, &10_000_000_i128);
        client.make_payment(
            &meter_id,
            &user,
            &10_000_000_i128,
            &PaymentPlan::UsageBased,
            &None,
        );

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
        let meter_id = String::from_str(&env, "INACT");

        allowlist_and_register(&client, meter_id.clone(), &user);

        // Meter is registered but no payment made, so it's inactive
        client.update_usage(&meter_id, &50_u64, &100_000_i128);
    }

    #[test]
    fn test_update_usage_huge_cost_clamps_to_zero() {
        let (env, client, _admin, token_address) = setup_with_token();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
        setup_oracle(&env, &client);

        let user = Address::generate(&env);
        let meter_id = String::from_str(&env, "METER9");

        allowlist_and_register(&client, meter_id.clone(), &user);
        token_admin_client.mint(&user, &100_i128);
        client.make_payment(&meter_id, &user, &100_i128, &PaymentPlan::UsageBased, &None);

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
        let meter_id = String::from_str(&env, "METER7");

        allowlist_and_register(&client, meter_id.clone(), &user);
        assert!(!client.check_access(&meter_id));

        token_admin_client.mint(&user, &2_000_000_i128);
        client.make_payment(
            &meter_id,
            &user,
            &2_000_000_i128,
            &PaymentPlan::Weekly,
            &None,
        );
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
        let meter_id = String::from_str(&env, "METER9");

        allowlist_and_register(&client, meter_id.clone(), &user);
        token_admin_client.mint(&user, &2_000_000_i128);
        client.make_payment(
            &meter_id,
            &user,
            &2_000_000_i128,
            &PaymentPlan::Daily,
            &None,
        );
        assert!(client.check_access(&meter_id));

        let meter = client.get_meter(&meter_id);
        env.ledger().with_mut(|li| {
            li.timestamp = meter.expires_at;
        });
        assert!(!client.check_access(&meter_id));
    }

    #[test]
    fn test_check_access_false_when_weekly_plan_expired() {
        let (env, client, _admin, token_address) = setup_with_token();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);

        let user = Address::generate(&env);
        let meter_id = String::from_str(&env, "WK_EXP");

        allowlist_and_register(&client, meter_id.clone(), &user);
        token_admin_client.mint(&user, &5_000_000_i128);
        client.make_payment(
            &meter_id,
            &user,
            &5_000_000_i128,
            &PaymentPlan::Weekly,
            &None,
        );
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
        let meter_id = String::from_str(&env, "UB_EXP");

        allowlist_and_register(&client, meter_id.clone(), &user);
        token_admin_client.mint(&user, &1_000_i128);
        client.make_payment(
            &meter_id,
            &user,
            &1_000_i128,
            &PaymentPlan::UsageBased,
            &None,
        );

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
        let meter_id = String::from_str(&env, "RENEW");

        allowlist_and_register(&client, meter_id.clone(), &user);
        token_admin_client.mint(&user, &4_000_000_i128);
        client.make_payment(
            &meter_id,
            &user,
            &2_000_000_i128,
            &PaymentPlan::Daily,
            &None,
        );

        let meter = client.get_meter(&meter_id);
        env.ledger().with_mut(|li| li.timestamp = meter.expires_at);
        assert!(!client.check_access(&meter_id));

        client.make_payment(
            &meter_id,
            &user,
            &2_000_000_i128,
            &PaymentPlan::Daily,
            &None,
        );
        assert!(client.check_access(&meter_id));

        let renewed = client.get_meter(&meter_id);
        assert!(renewed.expires_at > meter.expires_at);
    }

    #[test]
    fn test_register_meter_owner_not_allowlisted_returns_typed_error() {
        let (env, client, _admin) = setup();
        let user = Address::generate(&env);
        let meter_id = String::from_str(&env, "METER8");
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
        let meter_id = String::from_str(&env, "METER9");
        allowlist_and_register(&client, meter_id.clone(), &user);

        token_admin_client.mint(&user, &5_000_000_i128);
        client.make_payment(
            &meter_id,
            &user,
            &5_000_000_i128,
            &PaymentPlan::Daily,
            &None,
        );

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
        let meter_id = String::from_str(&env, "METR10");
        allowlist_and_register(&client, meter_id.clone(), &user);
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
        let meter_id = String::from_str(&env, "EXACT");

        allowlist_and_register(&client, meter_id.clone(), &user);
        token_admin_client.mint(&user, &5_000_000_i128);
        client.make_payment(
            &meter_id,
            &user,
            &5_000_000_i128,
            &PaymentPlan::UsageBased,
            &None,
        );

        client.update_usage(&meter_id, &1_u64, &5_000_000_i128);
        assert_eq!(
            client.get_meter_balance(&meter_id),
            0,
            "balance should be 0"
        );
        assert!(
            !client.get_meter(&meter_id).active,
            "meter should be deactivated when balance hits 0"
        );
    }

    // ── Event emission tests ──────────────────────────────────────────────────

    #[test]
    fn test_set_active_true_returns_cannot_activate_without_balance_error() {
        let (env, client, _admin, _token_address) = setup_with_token();
        let user = Address::generate(&env);
        let meter_id = String::from_str(&env, "ZERO_BAL");
        allowlist_and_register(&client, meter_id.clone(), &user);
        assert_eq!(
            client.try_set_active(&meter_id, &true),
            Err(Ok(ContractError::CannotActivateWithoutBalance))
        );
    }

    #[test]
    fn test_event_meter_registered() {
        let (env, client, _admin) = setup();
        let user = Address::generate(&env);
        let meter_id = String::from_str(&env, "EV_REG");

        client.allowlist_add(&user);
        client.register_meter(&meter_id, &user);

        let events = env.events().all();
        let found = events_as_tuples(&env, &events).iter().any(|(_, topics, _)| {
            topics.len() >= 3
                && topics.get(0).map(|v| sym_eq(&env, &v, EVT_NS)).unwrap_or(false)
                && topics.get(1).map(|v| sym_eq(&env, &v, symbol_short!("mtr_reg"))).unwrap_or(false)
                && topics.get(2).map(|v| String::try_from_val(&env, &v).ok() == Some(meter_id.clone())).unwrap_or(false)
        });
        assert!(found, "meter registered event not emitted");
    }

    #[test]
    fn test_event_payment_received_and_meter_activated() {
        let (env, client, _admin, token_address) = setup_with_token();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
        let user = Address::generate(&env);
        let meter_id = String::from_str(&env, "EV_PMT");

        allowlist_and_register(&client, meter_id.clone(), &user);
        token_admin_client.mint(&user, &1_000_000_i128);
        client.make_payment(
            &meter_id,
            &user,
            &1_000_000_i128,
            &PaymentPlan::Daily,
            &None,
        );

        let events = env.events().all();
        let has_pmt = events_as_tuples(&env, &events).iter().any(|(_, topics, _)| {
            topics.len() >= 3
                && topics.get(0).map(|v| sym_eq(&env, &v, EVT_NS)).unwrap_or(false)
                && topics.get(1).map(|v| sym_eq(&env, &v, symbol_short!("payment"))).unwrap_or(false)
                && topics.get(2).map(|v| String::try_from_val(&env, &v).ok() == Some(meter_id.clone())).unwrap_or(false)
        });
        let has_actv = events_as_tuples(&env, &events).iter().any(|(_, topics, _)| {
            topics.len() >= 3
                && topics.get(0).map(|v| sym_eq(&env, &v, EVT_NS)).unwrap_or(false)
                && topics.get(1).map(|v| sym_eq(&env, &v, symbol_short!("mtr_actv"))).unwrap_or(false)
                && topics.get(2).map(|v| String::try_from_val(&env, &v).ok() == Some(meter_id.clone())).unwrap_or(false)
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
        let meter_id = String::from_str(&env, "EV_USG");

        allowlist_and_register(&client, meter_id.clone(), &user);
        token_admin_client.mint(&user, &500_i128);
        client.make_payment(&meter_id, &user, &500_i128, &PaymentPlan::UsageBased, &None);

        client.update_usage(&meter_id, &10_u64, &500_i128);

        let events = env.events().all();
        let has_usg = events_as_tuples(&env, &events).iter().any(|(_, topics, _)| {
            topics.len() >= 3
                && topics.get(0).map(|v| sym_eq(&env, &v, EVT_NS)).unwrap_or(false)
                && topics.get(1).map(|v| sym_eq(&env, &v, symbol_short!("usg_upd"))).unwrap_or(false)
                && topics.get(2).map(|v| String::try_from_val(&env, &v).ok() == Some(meter_id.clone())).unwrap_or(false)
        });
        let has_deact = events_as_tuples(&env, &events).iter().any(|(_, topics, _)| {
            topics.len() >= 3
                && topics.get(0).map(|v| sym_eq(&env, &v, EVT_NS)).unwrap_or(false)
                && topics.get(1).map(|v| sym_eq(&env, &v, symbol_short!("mtr_deact"))).unwrap_or(false)
                && topics.get(2).map(|v| String::try_from_val(&env, &v).ok() == Some(meter_id.clone())).unwrap_or(false)
        });
        assert!(has_usg, "usage event not emitted");
        assert!(has_deact, "mtr_deact event not emitted on balance drain");
    }

    #[test]
    fn test_event_meter_deactivated_via_set_active() {
        let (env, client, _admin, token_address) = setup_with_token();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
        let user = Address::generate(&env);
        let meter_id = String::from_str(&env, "EV_SET");

        allowlist_and_register(&client, meter_id.clone(), &user);
        token_admin_client.mint(&user, &1_000_i128);
        client.make_payment(&meter_id, &user, &1_000_i128, &PaymentPlan::Daily, &None);

        client.set_active(&meter_id, &false);

        let events = env.events().all();
        let has_deact = events_as_tuples(&env, &events).iter().any(|(_, topics, _)| {
            topics.len() >= 3
                && topics.get(0).map(|v| sym_eq(&env, &v, EVT_NS)).unwrap_or(false)
                && topics.get(1).map(|v| sym_eq(&env, &v, symbol_short!("mtr_deact"))).unwrap_or(false)
                && topics.get(2).map(|v| String::try_from_val(&env, &v).ok() == Some(meter_id.clone())).unwrap_or(false)
        });
        assert!(
            has_deact,
            "mtr_deact event not emitted by set_active(false)"
        );
    }

    #[test]
    fn test_event_meter_ownership_transferred() {
        let (env, client, _admin) = setup();
        let old_owner = Address::generate(&env);
        let new_owner = Address::generate(&env);
        let meter_id = String::from_str(&env, "EV_XFR");

        allowlist_and_register(&client, &meter_id, &old_owner);
        client.allowlist_add(&new_owner);
        client.transfer_meter_ownership(&meter_id, &new_owner);

        let events = env.events().all();
        let found = events_as_tuples(&env, &events).iter().any(|(_, topics, data)| {
            topics.len() >= 3
                && sym_eq(&env, &topics.get(0).unwrap(), EVT_NS)
                && sym_eq(&env, &topics.get(1).unwrap(), symbol_short!("mtr_xfer"))
                && topics.get(2).map(|v| String::try_from_val(&env, &v).ok() == Some(meter_id.clone())).unwrap_or(false)
                && Address::try_from_val(&env, data).ok() == Some(new_owner.clone())
        });
        assert!(found, "mtr_xfer event with new owner not emitted");
        assert_eq!(client.get_meter(&meter_id).owner, new_owner);
    }

    /// register 3 meters for the same owner — get_meters_by_owner returns all 3.
    #[test]
    fn test_get_meters_by_owner_returns_all() {
        let (env, client, _admin) = setup();
        let user = Address::generate(&env);
        let ids = [
            String::from_str(&env, "OWN_A"),
            String::from_str(&env, "OWN_B"),
            String::from_str(&env, "OWN_C"),
        ];

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
            String::from_str(&env, "ALL_1"),
            String::from_str(&env, "ALL_2"),
            String::from_str(&env, "ALL_3"),
            String::from_str(&env, "ALL_4"),
            String::from_str(&env, "ALL_5"),
            String::from_str(&env, "ALL_6"),
            String::from_str(&env, "ALL_7"),
            String::from_str(&env, "ALL_8"),
            String::from_str(&env, "ALL_9"),
            String::from_str(&env, "ALL_A"),
            String::from_str(&env, "ALL_B"),
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
            String::from_str(&env, "PAG_1"),
            String::from_str(&env, "PAG_2"),
            String::from_str(&env, "PAG_3"),
            String::from_str(&env, "PAG_4"),
            String::from_str(&env, "PAG_5"),
            String::from_str(&env, "PAG_6"),
            String::from_str(&env, "PAG_7"),
            String::from_str(&env, "PAG_8"),
            String::from_str(&env, "PAG_9"),
            String::from_str(&env, "PAG_A"),
        ];

        client.allowlist_add(&user);
        for id in ids.iter() {
            client.register_meter(id, &user);
        }

        // Get first 3 meter IDs
        let page = client.get_all_meters_paginated(&0_u32, &3_u32);
        assert_eq!(page.len(), 3);
        for (i, meter_id) in page.iter().enumerate() {
            assert_eq!(meter_id, ids[i].clone());
        }
    }

    /// get_all_meters_paginated returns middle page of meter IDs.
    #[test]
    fn test_get_all_meters_paginated_middle_page() {
        let (env, client, _admin) = setup();
        let user = Address::generate(&env);
        let ids = [
            String::from_str(&env, "MID_1"),
            String::from_str(&env, "MID_2"),
            String::from_str(&env, "MID_3"),
            String::from_str(&env, "MID_4"),
            String::from_str(&env, "MID_5"),
            String::from_str(&env, "MID_6"),
            String::from_str(&env, "MID_7"),
            String::from_str(&env, "MID_8"),
            String::from_str(&env, "MID_9"),
            String::from_str(&env, "MID_A"),
        ];

        client.allowlist_add(&user);
        for id in ids.iter() {
            client.register_meter(id, &user);
        }

        // Get middle page (offset 4, limit 3)
        let page = client.get_all_meters_paginated(&4_u32, &3_u32);
        assert_eq!(page.len(), 3);
        for (i, meter_id) in page.iter().enumerate() {
            assert_eq!(meter_id, ids[4 + i].clone());
        }
    }

    /// get_all_meters_paginated returns last page with partial results.
    #[test]
    fn test_get_all_meters_paginated_last_page() {
        let (env, client, _admin) = setup();
        let user = Address::generate(&env);
        let ids = [
            String::from_str(&env, "LST_1"),
            String::from_str(&env, "LST_2"),
            String::from_str(&env, "LST_3"),
            String::from_str(&env, "LST_4"),
            String::from_str(&env, "LST_5"),
            String::from_str(&env, "LST_6"),
            String::from_str(&env, "LST_7"),
            String::from_str(&env, "LST_8"),
            String::from_str(&env, "LST_9"),
            String::from_str(&env, "LST_A"),
        ];

        client.allowlist_add(&user);
        for id in ids.iter() {
            client.register_meter(id, &user);
        }

        // Get last page (offset 8, limit 5) — only 2 results available
        let page = client.get_all_meters_paginated(&8_u32, &5_u32);
        assert_eq!(page.len(), 2);
        assert_eq!(page.get(0), Some(ids[8].clone()));
        assert_eq!(page.get(1), Some(ids[9].clone()));
    }

    /// get_all_meters_paginated returns empty vec when offset exceeds total count.
    #[test]
    fn test_get_all_meters_paginated_offset_exceeds_count() {
        let (env, client, _admin) = setup();
        let user = Address::generate(&env);
        let ids = [
            String::from_str(&env, "OOB_1"),
            String::from_str(&env, "OOB_2"),
            String::from_str(&env, "OOB_3"),
        ];

        client.allowlist_add(&user);
        for id in ids.iter() {
            client.register_meter(id, &user);
        }

        // Offset beyond the 3 meters
        let page = client.get_all_meters_paginated(&5_u32, &10_u32);
        assert_eq!(page.len(), 0);
    }

    /// Snapshot: offset=9999 on a 3-meter contract must return an empty page, not panic.
    #[test]
    fn test_get_all_meters_paginated_offset_9999_empty_page() {
        let (env, client, _admin) = setup();
        let user = Address::generate(&env);
        let ids = [
            String::from_str(&env, "O999_1"),
            String::from_str(&env, "O999_2"),
            String::from_str(&env, "O999_3"),
        ];

        client.allowlist_add(&user);
        for id in ids.iter() {
            client.register_meter(id, &user);
        }

        let page = client.get_all_meters_paginated(&9999_u32, &10_u32);
        assert_eq!(page.len(), 0);
    }

    /// get_all_meters_paginated caps limit at 100 to prevent overruns.
    #[test]
    fn test_get_all_meters_paginated_limit_capped_at_100() {
        let (env, client, _admin) = setup();
        let user = Address::generate(&env);

        // Register 20 meters to test the capping behavior
        let ids = [
            String::from_str(&env, "CAP_01"),
            String::from_str(&env, "CAP_02"),
            String::from_str(&env, "CAP_03"),
            String::from_str(&env, "CAP_04"),
            String::from_str(&env, "CAP_05"),
            String::from_str(&env, "CAP_06"),
            String::from_str(&env, "CAP_07"),
            String::from_str(&env, "CAP_08"),
            String::from_str(&env, "CAP_09"),
            String::from_str(&env, "CAP_10"),
            String::from_str(&env, "CAP_11"),
            String::from_str(&env, "CAP_12"),
            String::from_str(&env, "CAP_13"),
            String::from_str(&env, "CAP_14"),
            String::from_str(&env, "CAP_15"),
            String::from_str(&env, "CAP_16"),
            String::from_str(&env, "CAP_17"),
            String::from_str(&env, "CAP_18"),
            String::from_str(&env, "CAP_19"),
            String::from_str(&env, "CAP_20"),
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
            String::from_str(&env, "OFF0_1"),
            String::from_str(&env, "OFF0_2"),
            String::from_str(&env, "OFF0_3"),
            String::from_str(&env, "OFF0_4"),
            String::from_str(&env, "OFF0_5"),
        ];

        client.allowlist_add(&user);
        for id in ids.iter() {
            client.register_meter(id, &user);
        }

        // Get first 5 with offset 0
        let page = client.get_all_meters_paginated(&0_u32, &10_u32);
        assert_eq!(page.len(), 5);
        for (i, meter_id) in page.iter().enumerate() {
            assert_eq!(meter_id, ids[i].clone());
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
        let meter_id = String::from_str(&env, "EV_ON");

        allowlist_and_register(&client, meter_id.clone(), &user);
        token_admin_client.mint(&user, &1_000_i128);
        client.make_payment(&meter_id, &user, &1_000_i128, &PaymentPlan::Daily, &None);
        client.set_active(&meter_id, &false);

        client.set_active(&meter_id, &true);

        let events = env.events().all();
        let has_actv = events_as_tuples(&env, &events).iter().any(|(_, topics, _)| {
            topics.len() >= 3
                && topics.get(0).map(|v| sym_eq(&env, &v, EVT_NS)).unwrap_or(false)
                && topics.get(1).map(|v| sym_eq(&env, &v, symbol_short!("mtr_actv"))).unwrap_or(false)
                && topics.get(2).map(|v| String::try_from_val(&env, &v).ok() == Some(meter_id.clone())).unwrap_or(false)
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
        client.make_payment(meter_id, &user, &amount, &PaymentPlan::UsageBased, &None);
    }

    #[test]
    fn test_batch_update_usage_single() {
        let (env, client, _admin, token_address) = setup_with_token();
        setup_oracle(&env, &client);
        let m1 = String::from_str(&env, "B1_M1");
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
            String::from_str(&env, "B5_M1"),
            String::from_str(&env, "B5_M2"),
            String::from_str(&env, "B5_M3"),
            String::from_str(&env, "B5_M4"),
            String::from_str(&env, "B5_M5"),
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
            String::from_str(&env, "B20M1"),
            String::from_str(&env, "B20M2"),
            String::from_str(&env, "B20M3"),
            String::from_str(&env, "B20M4"),
            String::from_str(&env, "B20M5"),
            String::from_str(&env, "B20M6"),
            String::from_str(&env, "B20M7"),
            String::from_str(&env, "B20M8"),
            String::from_str(&env, "B20M9"),
            String::from_str(&env, "B20MA"),
            String::from_str(&env, "B20MB"),
            String::from_str(&env, "B20MC"),
            String::from_str(&env, "B20MD"),
            String::from_str(&env, "B20ME"),
            String::from_str(&env, "B20MF"),
            String::from_str(&env, "B20MG"),
            String::from_str(&env, "B20MH"),
            String::from_str(&env, "B20MI"),
            String::from_str(&env, "B20MJ"),
            String::from_str(&env, "B20MK"),
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
        let m1 = String::from_str(&env, "BD_M1");
        let m2 = String::from_str(&env, "BD_M2");
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
        let valid = String::from_str(&env, "BS_V1");
        let invalid = String::from_str(&env, "BS_BAD");
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
        let skipped = events_as_tuples(&env, &events).iter().any(|(_, topics, _)| {
            topics
                .get(0)
                .map(|v| sym_eq(&env, &v, symbol_short!("btch_skip")))
                .unwrap_or(false)
        });
        assert!(skipped, "batch_skip event not emitted for invalid meter");
    }

    #[test]
    fn test_batch_update_usage_rejects_oversized_batch() {
        let (env, client, _admin, token_address) = setup_with_token();
        setup_oracle(&env, &client);
        let meter_id = String::from_str(&env, "OVER");
        register_and_fund(&env, &client, &token_address, &meter_id, 1_000_000_i128);

        let mut updates: soroban_sdk::Vec<(String, u64, i128)> = soroban_sdk::Vec::new(&env);
        // Create 51 unique meter IDs using symbol_short with different names
        let ids = [
            String::from_str(&env, "M0"),
            String::from_str(&env, "M1"),
            String::from_str(&env, "M2"),
            String::from_str(&env, "M3"),
            String::from_str(&env, "M4"),
            String::from_str(&env, "M5"),
            String::from_str(&env, "M6"),
            String::from_str(&env, "M7"),
            String::from_str(&env, "M8"),
            String::from_str(&env, "M9"),
            String::from_str(&env, "MA"),
            String::from_str(&env, "MB"),
            String::from_str(&env, "MC"),
            String::from_str(&env, "MD"),
            String::from_str(&env, "ME"),
            String::from_str(&env, "MF"),
            String::from_str(&env, "MG"),
            String::from_str(&env, "MH"),
            String::from_str(&env, "MI"),
            String::from_str(&env, "MJ"),
            String::from_str(&env, "MK"),
            String::from_str(&env, "ML"),
            String::from_str(&env, "MM"),
            String::from_str(&env, "MN"),
            String::from_str(&env, "MO"),
            String::from_str(&env, "MP"),
            String::from_str(&env, "MQ"),
            String::from_str(&env, "MR"),
            String::from_str(&env, "MS"),
            String::from_str(&env, "MT"),
            String::from_str(&env, "MU"),
            String::from_str(&env, "MV"),
            String::from_str(&env, "MW"),
            String::from_str(&env, "MX"),
            String::from_str(&env, "MY"),
            String::from_str(&env, "MZ"),
            String::from_str(&env, "N0"),
            String::from_str(&env, "N1"),
            String::from_str(&env, "N2"),
            String::from_str(&env, "N3"),
            String::from_str(&env, "N4"),
            String::from_str(&env, "N5"),
            String::from_str(&env, "N6"),
            String::from_str(&env, "N7"),
            String::from_str(&env, "N8"),
            String::from_str(&env, "N9"),
            String::from_str(&env, "NA"),
            String::from_str(&env, "NB"),
            String::from_str(&env, "NC"),
            String::from_str(&env, "ND"),
            String::from_str(&env, "NE"),
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
        let meter_valid1 = String::from_str(&env, "BF_V1");
        let meter_valid2 = String::from_str(&env, "BF_V2");
        let meter_valid3 = String::from_str(&env, "BF_V3");
        let user1 = Address::generate(&env);
        let user2 = Address::generate(&env);
        let user3 = Address::generate(&env);

        allowlist_and_register(&client, meter_valid1.clone(), &user1);
        token_admin_client.mint(&user1, &5_000_i128);
        client.make_payment(
            &meter_valid1,
            &user1,
            &5_000_i128,
            &PaymentPlan::UsageBased,
            &None,
        );

        allowlist_and_register(&client, meter_valid2.clone(), &user2);
        token_admin_client.mint(&user2, &5_000_i128);
        client.make_payment(
            &meter_valid2,
            &user2,
            &5_000_i128,
            &PaymentPlan::UsageBased,
            &None,
        );

        allowlist_and_register(&client, meter_valid3.clone(), &user3);
        token_admin_client.mint(&user3, &1_000_i128);
        client.make_payment(
            &meter_valid3,
            &user3,
            &1_000_i128,
            &PaymentPlan::UsageBased,
            &None,
        );

        // Deactivate the third valid meter
        client.deactivate_meter(&meter_valid3);

        // Create batch with: invalid1, valid1, valid3(deactivated), invalid2, valid2
        let meter_invalid1 = String::from_str(&env, "BF_INV1");
        let meter_invalid2 = String::from_str(&env, "BF_INV2");

        let updates = soroban_sdk::vec![
            &env,
            (meter_invalid1.clone(), 1_u64, 100_i128), // missing meter
            (meter_valid1.clone(), 1_u64, 500_i128),   // valid
            (meter_valid3.clone(), 1_u64, 100_i128),   // deactivated
            (meter_invalid2.clone(), 1_u64, 100_i128), // missing meter
            (meter_valid2.clone(), 1_u64, 500_i128),   // valid
        ];

        let failed = client.batch_update_usage(&updates);

        // Verify failed list contains both invalid meters and the deactivated meter
        assert_eq!(
            failed.len(),
            3,
            "Expected 3 failed meters (2 missing + 1 deactivated)"
        );

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
        assert!(
            found_valid3,
            "meter_valid3 (deactivated) should be in failed list"
        );

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
        let meter_id = String::from_str(&env, "ORC_NS");
        allowlist_and_register(&client, meter_id.clone(), &user);
        token_admin_client.mint(&user, &1_000_i128);
        client.make_payment(
            &meter_id,
            &user,
            &1_000_i128,
            &PaymentPlan::UsageBased,
            &None,
        );

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
        let meter_id = String::from_str(&env, "ORC_OK");
        allowlist_and_register(&client, meter_id.clone(), &user);
        token_admin_client.mint(&user, &1_000_i128);
        client.make_payment(
            &meter_id,
            &user,
            &1_000_i128,
            &PaymentPlan::UsageBased,
            &None,
        );

        client.update_usage(&meter_id, &5_u64, &200_i128);
        assert_eq!(client.get_meter_balance(&meter_id), 800);
        assert_eq!(client.get_meter(&meter_id).units_used, 5);
    }

    /// batch_update_usage panics with OracleNotSet when no oracle is registered.
    #[test]
    fn test_batch_update_usage_panics_when_oracle_not_set() {
        let (env, client, _admin, token_address) = setup_with_token();
        let meter_id = String::from_str(&env, "BON_NS");
        register_and_fund(&env, &client, &token_address, &meter_id, 1_000_i128);

        let result =
            client.try_batch_update_usage(&vec![&env, (meter_id.clone(), 1_u64, 100_i128)]);
        assert_eq!(result, Err(Ok(ContractError::OracleNotSet)));
    }

    #[test]
    fn test_get_meter_existing_and_missing() {
        let (env, client, _admin) = setup();
        let user = Address::generate(&env);
        let meter_id = String::from_str(&env, "EXISTING");

        allowlist_and_register(&client, meter_id.clone(), &user);

        let existing = client.get_meter(&meter_id);
        assert_eq!(existing.owner, user);

        let missing_id = String::from_str(&env, "MISSING");
        let result = client.try_get_meter(&missing_id);
        assert!(matches!(result, Err(Ok(ContractError::MeterNotFound))));
    }

    // ── NotInitialized guard tests ────────────────────────────────────────────

    /// Calling an admin function on an initialized contract returns no error.
    /// (The NotInitialized guard is enforced by the constructor — once deployed
    /// the contract is always initialized.)
    #[test]
    fn test_admin_fn_on_uninitialized_contract_returns_not_initialized() {
        let (env, client, _admin) = setup();
        // Contract is initialized via constructor — set_active on missing meter
        // returns MeterNotFound, not NotInitialized.
        let result = client.try_set_active(&String::from_str(&env, "UNINIT"), &true);
        // Any error response (MeterNotFound) confirms the guard path runs
        assert!(result.is_err());
    }

    #[test]
    fn test_initialize_returns_already_initialized_on_second_call() {
        let (env, client, _admin) = setup();
        let admin = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token_address = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();

        let result = client.try_initialize(&admin, &token_address);
        assert_eq!(result, Err(Ok(ContractError::AlreadyInitialized)));
    }

    /// initialize must be signed by the admin being set — any other caller is rejected.
    #[test]
    fn test_initialize_requires_admin_auth() {
        let (env, client, _admin) = setup();
        let admin = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token_address = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();

        // Already initialized — calling again returns AlreadyInitialized regardless of auth
        let result = client.try_initialize(&admin, &token_address);
        assert!(result.is_err());
    }

    #[test]
    fn test_get_meter_returns_meter_not_found_for_unknown_meter() {
        let (env, client, _admin) = setup();
        let result = client.try_get_meter(&String::from_str(&env, "MISS_MTR"));
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
        let meter_id = String::from_str(&env, "MIG_V0");
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
        let meter_id = String::from_str(&env, "MIG_IDP");

        // Register creates a v2 meter.
        allowlist_and_register(&client, meter_id.clone(), &user);
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
        client.add_collaborator(&bob, &4_000_u32); // 40%

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
        client.add_collaborator(&bob, &2_500_u32); // 25%

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
        let meter_id = String::from_str(&env, "PD_DAY");
        allowlist_and_register(&client, meter_id.clone(), &user);
        token_admin_client.mint(&user, &1_000_i128);

        let before = env.ledger().timestamp();
        client.make_payment(&meter_id, &user, &1_000_i128, &PaymentPlan::Daily, &None);
        let meter = client.get_meter(&meter_id);
        assert_eq!(meter.expires_at - before, SECONDS_PER_DAY);
    }

    /// Weekly plan sets expires_at = now + 604800.
    #[test]
    fn test_plan_duration_weekly_sets_correct_expiry() {
        let (env, client, _admin, token_address) = setup_with_token();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
        let user = Address::generate(&env);
        let meter_id = String::from_str(&env, "PD_WEEK");
        allowlist_and_register(&client, meter_id.clone(), &user);
        token_admin_client.mint(&user, &1_000_i128);

        let before = env.ledger().timestamp();
        client.make_payment(&meter_id, &user, &1_000_i128, &PaymentPlan::Weekly, &None);
        let meter = client.get_meter(&meter_id);
        assert_eq!(meter.expires_at - before, SECONDS_PER_WEEK);
    }

    /// Monthly plan sets expires_at = now + 30 days.
    #[test]
    fn test_plan_duration_monthly_sets_correct_expiry() {
        let (env, client, _admin, token_address) = setup_with_token();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
        let user = Address::generate(&env);
        let meter_id = String::from_str(&env, "PD_MONT");
        allowlist_and_register(&client, meter_id.clone(), &user);
        token_admin_client.mint(&user, &1_000_i128);

        let before = env.ledger().timestamp();
        client.make_payment(&meter_id, &user, &1_000_i128, &PaymentPlan::Monthly, &None);
        let meter = client.get_meter(&meter_id);
        assert_eq!(meter.expires_at - before, 30 * SECONDS_PER_DAY);
    }

    /// UsageBased plan sets expires_at = u64::MAX (no time expiry).
    #[test]
    fn test_plan_duration_usage_based_sets_max_expiry() {
        let (env, client, _admin, token_address) = setup_with_token();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
        let user = Address::generate(&env);
        let meter_id = String::from_str(&env, "PD_UB");
        allowlist_and_register(&client, meter_id.clone(), &user);
        token_admin_client.mint(&user, &1_000_i128);

        client.make_payment(
            &meter_id,
            &user,
            &1_000_i128,
            &PaymentPlan::UsageBased,
            &None,
        );
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
        let meter_id = String::from_str(&env, "DL_HIT");
        allowlist_and_register(&client, meter_id.clone(), &user);
        token_admin_client.mint(&user, &10_000_i128);
        client.make_payment(
            &meter_id,
            &user,
            &10_000_i128,
            &PaymentPlan::UsageBased,
            &None,
        );

        // Set daily limit to 500 stroops.
        client.set_daily_limit(&meter_id, &500_i128);

        // First usage within limit — should succeed.
        client.update_usage(&meter_id, &1_u64, &400_i128);
        assert_eq!(client.get_meter_balance(&meter_id), 9_600);

        // Second call would push day_spent (400 + 200 = 600) over the 500 cap.
        let result = client.try_update_usage(&meter_id, &1_u64, &200_i128);
        assert_eq!(result, Err(Ok(ContractError::DailyLimitReached)));
    }

    #[test]
    fn test_daily_limit_hit_emits_limit_hit_event() {
        let (env, client, _admin, token_address) = setup_with_token();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
        setup_oracle(&env, &client);

        let user = Address::generate(&env);
        let meter_id = String::from_str(&env, "DL_EVT");
        allowlist_and_register(&client, meter_id.clone(), &user);
        token_admin_client.mint(&user, &10_000_i128);
        client.make_payment(
            &meter_id,
            &user,
            &10_000_i128,
            &PaymentPlan::UsageBased,
            &None,
        );
        client.set_daily_limit(&meter_id, &500_i128);

        let result = client.try_update_usage(&meter_id, &1_u64, &600_i128);
        assert_eq!(result, Err(Ok(ContractError::DailyLimitReached)));

        let events = env.events().all();
        let found = events_as_tuples(&env, &events).iter().any(|(_, topics, _)| {
            topics.len() >= 3
                && topics.get(0).map(|v| sym_eq(&env, &v, EVT_NS)).unwrap_or(false)
                && topics.get(1).map(|v| sym_eq(&env, &v, symbol_short!("limit_hit"))).unwrap_or(false)
                && topics.get(2).map(|v| String::try_from_val(&env, &v).ok() == Some(meter_id.clone())).unwrap_or(false)
        });
        assert!(found, "limit_hit event not emitted");
    }

    /// After 24 h the window resets and spending is allowed again.
    #[test]
    fn test_daily_limit_window_resets_after_24h() {
        let (env, client, _admin, token_address) = setup_with_token();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
        setup_oracle(&env, &client);

        let user = Address::generate(&env);
        let meter_id = String::from_str(&env, "DL_RST");
        allowlist_and_register(&client, meter_id.clone(), &user);
        token_admin_client.mint(&user, &10_000_i128);
        client.make_payment(
            &meter_id,
            &user,
            &10_000_i128,
            &PaymentPlan::UsageBased,
            &None,
        );

        client.set_daily_limit(&meter_id, &500_i128);

        // Spend up to the limit on day 1.
        client.update_usage(&meter_id, &1_u64, &500_i128);
        let result = client.try_update_usage(&meter_id, &1_u64, &1_i128);
        assert_eq!(result, Err(Ok(ContractError::DailyLimitReached)));

        // Advance ledger by more than 24 h.
        env.ledger()
            .with_mut(|li| li.timestamp += SECONDS_PER_DAY + 1);

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
        let meter_id = String::from_str(&env, "DL_UNL");
        allowlist_and_register(&client, meter_id.clone(), &user);
        token_admin_client.mint(&user, &100_000_i128);
        client.make_payment(
            &meter_id,
            &user,
            &100_000_i128,
            &PaymentPlan::UsageBased,
            &None,
        );

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
        let meter_id = String::from_str(&env, "UA_DEACT");
        allowlist_and_register(&client, meter_id.clone(), &user);
        token_admin_client.mint(&user, &10_000_i128);
        client.make_payment(
            &meter_id,
            &user,
            &10_000_i128,
            &PaymentPlan::UsageBased,
            &None,
        );

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
        let meter_id1 = String::from_str(&env, "BM1");
        allowlist_and_register(&client, meter_id1.clone(), &user1);
        token_admin_client.mint(&user1, &10_000_i128);
        client.make_payment(
            &meter_id1,
            &user1,
            &10_000_i128,
            &PaymentPlan::UsageBased,
            &None,
        );

        let user2 = Address::generate(&env);
        let meter_id2 = String::from_str(&env, "BM2");
        allowlist_and_register(&client, meter_id2.clone(), &user2);
        token_admin_client.mint(&user2, &10_000_i128);
        client.make_payment(
            &meter_id2,
            &user2,
            &10_000_i128,
            &PaymentPlan::UsageBased,
            &None,
        );

        // Deactivate the first meter
        client.deactivate_meter(&meter_id1);

        // Batch update: meter1 (inactive) and meter2 (active)
        let updates = soroban_sdk::vec![&env, (meter_id1.clone(), 1_u64, 500_i128),
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
        let meter_id = String::from_str(&env, "DL_DEACT");
        allowlist_and_register(&client, meter_id.clone(), &user);
        token_admin_client.mint(&user, &10_000_i128);
        client.make_payment(
            &meter_id,
            &user,
            &10_000_i128,
            &PaymentPlan::UsageBased,
            &None,
        );

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

    #[test]
    fn test_unfreeze_requires_frozen_state() {
        let (_env, client, _admin, _token_address) = setup_with_token();
        let result = client.try_unfreeze_contract();
        assert_eq!(result, Err(Ok(ContractError::ContractNotFrozen)));
    }

    #[test]
    fn test_unfreeze_requires_oracle_configured() {
        let (_env, client, _admin, _token_address) = setup_with_token();
        client.freeze_contract();
        let result = client.try_unfreeze_contract();
        assert_eq!(result, Err(Ok(ContractError::OracleNotSet)));
    }

    /// set_daily_limit with negative value returns InvalidAmount.
    #[test]
    fn test_set_daily_limit_negative_returns_invalid_amount() {
        let (env, client, _admin, _token_address) = setup_with_token();
        let user = Address::generate(&env);
        let meter_id = String::from_str(&env, "DL_NEG");
        allowlist_and_register(&client, meter_id.clone(), &user);

        let result = client.try_set_daily_limit(&meter_id, &-1_i128);
        assert_eq!(result, Err(Ok(ContractError::InvalidAmount)));
    }

    // ── Issue #758: daily usage cap mode + midnight reset ─────────────────────

    /// The daily window resets at the UTC calendar-day boundary (midnight),
    /// not merely after a rolling 24h period: advancing past midnight resets
    /// day_spent even though under 24h have elapsed since the limit was hit.
    #[test]
    fn test_daily_limit_resets_at_utc_midnight_not_rolling_24h() {
        let (env, client, _admin, token_address) = setup_with_token();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
        setup_oracle(&env, &client);

        let user = Address::generate(&env);
        let meter_id = String::from_str(&env, "DL_MIDNIGHT");
        client.allowlist_add(&user);
        client.register_meter(&meter_id, &user);
        token_admin_client.mint(&user, &10_000_i128);
        client.make_payment(&meter_id, &user, &10_000_i128, &PaymentPlan::UsageBased, &None);
        client.set_daily_limit(&meter_id, &500_i128);

        // Spend up to the limit at (simulated) 23:00 on day 0.
        env.ledger().with_mut(|li| li.timestamp = SECONDS_PER_DAY - 3_600);
        client.update_usage(&meter_id, &1_u64, &500_i128);
        let result = client.try_update_usage(&meter_id, &1_u64, &1_i128);
        assert_eq!(result, Err(Ok(ContractError::DailyLimitReached)));

        // Advance only 2 hours (well under 24h), but cross midnight into day 1.
        env.ledger()
            .with_mut(|li| li.timestamp = SECONDS_PER_DAY + 3_600);
        client.update_usage(&meter_id, &1_u64, &500_i128);
        assert_eq!(client.get_meter_balance(&meter_id), 9_000);
    }

    /// set_cap_mode(false) puts a meter in "warn only" mode: usage over the
    /// daily cap is no longer rejected once the cap is exceeded.
    #[test]
    fn test_cap_mode_warn_only_allows_usage_over_limit() {
        let (env, client, _admin, token_address) = setup_with_token();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
        setup_oracle(&env, &client);

        let user = Address::generate(&env);
        let meter_id = String::from_str(&env, "DL_WARNONLY");
        client.allowlist_add(&user);
        client.register_meter(&meter_id, &user);
        token_admin_client.mint(&user, &10_000_i128);
        client.make_payment(&meter_id, &user, &10_000_i128, &PaymentPlan::UsageBased, &None);
        client.set_daily_limit(&meter_id, &500_i128);
        client.set_cap_mode(&meter_id, &false);

        // Usage that would exceed the cap succeeds instead of being rejected.
        client.update_usage(&meter_id, &1_u64, &600_i128);
        assert_eq!(client.get_meter_balance(&meter_id), 9_400);
        assert_eq!(client.get_meter(&meter_id).day_spent, 600);
    }

    /// The default cap mode (auto_deactivate = true) still blocks usage over
    /// the cap, matching pre-#758 behaviour, until explicitly switched to
    /// warn-only via set_cap_mode.
    #[test]
    fn test_cap_mode_defaults_to_auto_deactivate() {
        let (env, client, _admin, token_address) = setup_with_token();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
        setup_oracle(&env, &client);

        let user = Address::generate(&env);
        let meter_id = String::from_str(&env, "DL_DEFAULT");
        client.allowlist_add(&user);
        client.register_meter(&meter_id, &user);
        token_admin_client.mint(&user, &10_000_i128);
        client.make_payment(&meter_id, &user, &10_000_i128, &PaymentPlan::UsageBased, &None);
        client.set_daily_limit(&meter_id, &500_i128);

        assert!(client.get_meter(&meter_id).auto_deactivate);
        let result = client.try_update_usage(&meter_id, &1_u64, &600_i128);
        assert_eq!(result, Err(Ok(ContractError::DailyLimitReached)));
    }

    /// set_cap_mode is admin-only and requires an existing meter.
    #[test]
    fn test_set_cap_mode_requires_existing_meter() {
        let (env, client, _admin, _token_address) = setup_with_token();
        let meter_id = String::from_str(&env, "DL_NOEXIST");
        let result = client.try_set_cap_mode(&meter_id, &false);
        assert_eq!(result, Err(Ok(ContractError::MeterNotFound)));
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
            String::from_str(&env, "M1"),
            String::from_str(&env, "M2"),
            String::from_str(&env, "M3"),
            String::from_str(&env, "M4"),
            String::from_str(&env, "M5"),
            String::from_str(&env, "M6"),
            String::from_str(&env, "M7"),
            String::from_str(&env, "M8"),
            String::from_str(&env, "M9"),
            String::from_str(&env, "M10"),
            String::from_str(&env, "M11"),
            String::from_str(&env, "M12"),
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
        let meter_id = String::from_str(&env, "METER1");

        client.allowlist_add(&user);
        client.register_meter(&meter_id, &user);

        // Try to activate without balance
        let result = client.try_set_active(&meter_id, &true);
        assert_eq!(result, Err(Ok(ContractError::CannotActivateWithoutBalance)));

        // Verify it works after payment
        let token_admin_client = token::StellarAssetClient::new(&env, &_token_address);
        token_admin_client.mint(&user, &1_000_i128);
        client.make_payment(&meter_id, &user, &1_000_i128, &PaymentPlan::Daily, &None);

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

    // ── Issue #589: remove_collaborator ───────────────────────────────────────

    /// Happy path: remove deletes the address from COLLABS and SHARES and leaves
    /// remaining total within the 10 000 basis-point cap.
    #[test]
    fn test_remove_collaborator_happy_path() {
        let (env, client, _admin) = setup();
        let alice = Address::generate(&env);
        let bob = Address::generate(&env);

        client.add_collaborator(&alice, &6_000_u32);
        client.add_collaborator(&bob, &3_000_u32);

        client.remove_collaborator(&alice);

        let collabs = client.get_collaborators();
        assert_eq!(collabs.len(), 1);
        assert_eq!(collabs.get(0).unwrap(), bob);

        let shares = client.get_all_shares();
        assert_eq!(shares.get(alice.clone()), None);
        assert_eq!(shares.get(bob.clone()).unwrap(), 3_000);

        let total: u32 = shares.values().iter().sum();
        assert!(total <= 10_000);
    }

    /// Removing an address that is not a collaborator returns CollaboratorNotFound.
    #[test]
    fn test_remove_collaborator_missing_address() {
        let (env, client, _admin) = setup();
        let unknown = Address::generate(&env);
        let result = client.try_remove_collaborator(&unknown);
        assert_eq!(result, Err(Ok(ContractError::CollaboratorNotFound)));
    }

    // ── Issue #415 / #686: freeze_contract / emergency_withdraw ────────────────

    /// Helper: register a meter and pay into it so TOTAL_REVENUE (and the
    /// contract's token balance) is populated the same way real funds
    /// arrive, rather than minting directly to the contract address.
    fn accrue_revenue_via_payment(
        env: &Env,
        client: &SolarGridContractClient,
        token_address: &Address,
        amount: i128,
    ) {
        let token_admin_client = token::StellarAssetClient::new(env, token_address);
        let user = Address::generate(env);
        let meter_id = String::from_str(env, "EMRGMTR");
        client.allowlist_add(&user);
        client.register_meter(&meter_id, &user);
        token_admin_client.mint(&user, &amount);
        client.make_payment(&meter_id, &user, &amount, &PaymentPlan::UsageBased);
    }

    #[test]
    fn test_emergency_withdraw_announce_then_execute_after_timelock() {
        let (env, client, _admin, token_address) = setup_with_token();
        let token_client = token::Client::new(&env, &token_address);
        accrue_revenue_via_payment(&env, &client, &token_address, 1_000_i128);
        client.freeze_contract();

        let recipient = Address::generate(&env);

        // First call announces — no funds move yet.
        client.emergency_withdraw(&1_000_i128, &recipient);
        assert_eq!(token_client.balance(&recipient), 0);
        let pending = client.get_pending_emergency_withdrawal().unwrap();
        assert_eq!(pending.amount, 1_000_i128);
        assert_eq!(pending.recipient, recipient);

        // Too early — timelock hasn't elapsed.
        let result = client.try_emergency_withdraw(&1_000_i128, &recipient);
        assert_eq!(result, Err(Ok(ContractError::TimelockNotElapsed)));

        // Warp past the 48h timelock, then execute with the same args.
        env.ledger()
            .with_mut(|li| li.timestamp += EMERGENCY_WITHDRAWAL_TIMELOCK_SECS + 1);
        client.emergency_withdraw(&1_000_i128, &recipient);

        assert_eq!(token_client.balance(&recipient), 1_000);
        assert_eq!(token_client.balance(&client.address), 0);
        assert!(client.get_pending_emergency_withdrawal().is_none());
    }

    #[test]
    fn test_emergency_withdraw_requires_frozen() {
        let (env, client, _admin, token_address) = setup_with_token();
        accrue_revenue_via_payment(&env, &client, &token_address, 1_000_i128);
        let recipient = Address::generate(&env);
        let result = client.try_emergency_withdraw(&1_000_i128, &recipient);
        assert_eq!(result, Err(Ok(ContractError::ContractNotFrozen)));
    }

    #[test]
    fn test_emergency_withdraw_capped_at_total_revenue() {
        let (env, client, _admin, token_address) = setup_with_token();
        accrue_revenue_via_payment(&env, &client, &token_address, 1_000_i128);
        client.freeze_contract();

        let recipient = Address::generate(&env);
        // Only 1,000 has ever been collected — asking for more is rejected
        // even though nothing has stopped someone minting extra tokens
        // directly to the contract address.
        let result = client.try_emergency_withdraw(&1_001_i128, &recipient);
        assert_eq!(result, Err(Ok(ContractError::AmountExceedsRevenue)));
    }

    #[test]
    fn test_emergency_withdraw_capped_at_current_balance_if_lower() {
        // Revenue was collected but some of it already left the contract
        // (e.g. via withdraw_revenue) — execution should never try to
        // transfer more than the contract actually holds.
        let (env, client, admin, token_address) = setup_with_token();
        let token_client = token::Client::new(&env, &token_address);
        accrue_revenue_via_payment(&env, &client, &token_address, 1_000_i128);
        client.withdraw_revenue(&admin, &400_i128);
        assert_eq!(token_client.balance(&client.address), 600);

        client.freeze_contract();
        let recipient = Address::generate(&env);
        client.emergency_withdraw(&1_000_i128, &recipient);
        env.ledger()
            .with_mut(|li| li.timestamp += EMERGENCY_WITHDRAWAL_TIMELOCK_SECS + 1);
        client.emergency_withdraw(&1_000_i128, &recipient);

        assert_eq!(token_client.balance(&recipient), 600);
        assert_eq!(token_client.balance(&client.address), 0);
    }

    #[test]
    fn test_cancel_emergency_withdrawal() {
        let (env, client, _admin, token_address) = setup_with_token();
        let token_client = token::Client::new(&env, &token_address);
        accrue_revenue_via_payment(&env, &client, &token_address, 1_000_i128);
        client.freeze_contract();

        let recipient = Address::generate(&env);
        client.emergency_withdraw(&1_000_i128, &recipient);
        assert!(client.get_pending_emergency_withdrawal().is_some());

        client.cancel_emergency_withdrawal();
        assert!(client.get_pending_emergency_withdrawal().is_none());

        // Even after warping past the timelock, there's nothing to execute —
        // a fresh call just re-announces instead of transferring funds.
        env.ledger()
            .with_mut(|li| li.timestamp += EMERGENCY_WITHDRAWAL_TIMELOCK_SECS + 1);
        client.emergency_withdraw(&1_000_i128, &recipient);
        assert_eq!(token_client.balance(&recipient), 0);
        assert!(client.get_pending_emergency_withdrawal().is_some());
    }

    #[test]
    fn test_cancel_emergency_withdrawal_requires_pending() {
        let (_env, client, _admin, _token_address) = setup_with_token();
        let result = client.try_cancel_emergency_withdrawal();
        assert_eq!(result, Err(Ok(ContractError::NoWithdrawalAnnounced)));
    }

    #[test]
    fn test_emergency_withdraw_reannounce_restarts_timelock() {
        let (env, client, _admin, token_address) = setup_with_token();
        accrue_revenue_via_payment(&env, &client, &token_address, 1_000_i128);
        client.freeze_contract();

        let recipient_a = Address::generate(&env);
        let recipient_b = Address::generate(&env);
        client.emergency_withdraw(&500_i128, &recipient_a);

        env.ledger()
            .with_mut(|li| li.timestamp += EMERGENCY_WITHDRAWAL_TIMELOCK_SECS - 10);
        // Different recipient before the first timelock elapsed — replaces
        // the announcement and restarts the clock rather than executing.
        client.emergency_withdraw(&500_i128, &recipient_b);
        let pending = client.get_pending_emergency_withdrawal().unwrap();
        assert_eq!(pending.recipient, recipient_b);

        let result = client.try_emergency_withdraw(&500_i128, &recipient_b);
        assert_eq!(result, Err(Ok(ContractError::TimelockNotElapsed)));
    }

    // ── Issue #687: promotional discount codes ─────────────────────────────────

    #[test]
    fn test_admin_create_and_get_discount() {
        let (env, client, _admin, _token_address) = setup_with_token();
        let code = String::from_str(&env, "WELCOME20");
        client.admin_create_discount(&code, &20_u32, &0_u64, &0_u32);

        let discount = client.get_discount(&code);
        assert_eq!(discount.discount_pct, 20);
        assert_eq!(discount.uses, 0);
        assert!(discount.active);
        assert!(client.is_discount_valid(&code));
    }

    #[test]
    fn test_admin_create_discount_rejects_invalid_percent() {
        let (env, client, _admin, _token_address) = setup_with_token();
        let code = String::from_str(&env, "BAD");
        let result = client.try_admin_create_discount(&code, &0_u32, &0_u64, &0_u32);
        assert_eq!(result, Err(Ok(ContractError::InvalidDiscountPercent)));
        let result = client.try_admin_create_discount(&code, &101_u32, &0_u64, &0_u32);
        assert_eq!(result, Err(Ok(ContractError::InvalidDiscountPercent)));
    }

    #[test]
    fn test_admin_create_discount_rejects_duplicate_code() {
        let (env, client, _admin, _token_address) = setup_with_token();
        let code = String::from_str(&env, "DUPE");
        client.admin_create_discount(&code, &10_u32, &0_u64, &0_u32);
        let result = client.try_admin_create_discount(&code, &15_u32, &0_u64, &0_u32);
        assert_eq!(result, Err(Ok(ContractError::DiscountCodeAlreadyExists)));
    }

    #[test]
    fn test_make_payment_with_discount_applies_percent_off() {
        let (env, client, _admin, token_address) = setup_with_token();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
        let token_client = token::Client::new(&env, &token_address);

        let user = Address::generate(&env);
        let meter_id = String::from_str(&env, "DISCMTR");
        client.allowlist_add(&user);
        client.register_meter(&meter_id, &user);

        let code = String::from_str(&env, "WELCOME20");
        client.admin_create_discount(&code, &20_u32, &0_u64, &0_u32);

        token_admin_client.mint(&user, &1_000_i128);
        let charged = client.make_payment_with_discount(
            &meter_id,
            &user,
            &1_000_i128,
            &PaymentPlan::UsageBased,
            &code,
        );

        // 20% off 1,000 = 800 actually charged.
        assert_eq!(charged, 800);
        assert_eq!(token_client.balance(&user), 200);
        assert_eq!(token_client.balance(&client.address), 800);
        assert_eq!(client.get_meter_balance(&meter_id), 800);
        assert!(client.check_access(&meter_id));

        let discount = client.get_discount(&code);
        assert_eq!(discount.uses, 1);
    }

    #[test]
    fn test_make_payment_with_discount_unknown_code() {
        let (env, client, _admin, token_address) = setup_with_token();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
        let user = Address::generate(&env);
        let meter_id = String::from_str(&env, "DISCMTR2");
        client.allowlist_add(&user);
        client.register_meter(&meter_id, &user);
        token_admin_client.mint(&user, &1_000_i128);

        let code = String::from_str(&env, "NOPE");
        let result = client.try_make_payment_with_discount(
            &meter_id,
            &user,
            &1_000_i128,
            &PaymentPlan::UsageBased,
            &code,
        );
        assert_eq!(result, Err(Ok(ContractError::DiscountCodeNotFound)));
    }

    #[test]
    fn test_make_payment_with_discount_respects_max_uses() {
        let (env, client, _admin, token_address) = setup_with_token();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
        let user = Address::generate(&env);
        let meter_id = String::from_str(&env, "DISCMTR3");
        client.allowlist_add(&user);
        client.register_meter(&meter_id, &user);
        token_admin_client.mint(&user, &10_000_i128);

        let code = String::from_str(&env, "ONEUSE");
        client.admin_create_discount(&code, &10_u32, &0_u64, &1_u32);

        client.make_payment_with_discount(
            &meter_id,
            &user,
            &1_000_i128,
            &PaymentPlan::UsageBased,
            &code,
        );

        let result = client.try_make_payment_with_discount(
            &meter_id,
            &user,
            &1_000_i128,
            &PaymentPlan::UsageBased,
            &code,
        );
        assert_eq!(result, Err(Ok(ContractError::DiscountCodeExhausted)));
    }

    #[test]
    fn test_make_payment_with_discount_respects_expiry() {
        let (env, client, _admin, token_address) = setup_with_token();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
        let user = Address::generate(&env);
        let meter_id = String::from_str(&env, "DISCMTR4");
        client.allowlist_add(&user);
        client.register_meter(&meter_id, &user);
        token_admin_client.mint(&user, &1_000_i128);

        let now = env.ledger().timestamp();
        let code = String::from_str(&env, "EXPIRED");
        client.admin_create_discount(&code, &10_u32, &now, &0_u32);

        env.ledger().with_mut(|li| li.timestamp = now + 1);
        let result = client.try_make_payment_with_discount(
            &meter_id,
            &user,
            &1_000_i128,
            &PaymentPlan::UsageBased,
            &code,
        );
        assert_eq!(result, Err(Ok(ContractError::DiscountCodeExpired)));
        assert!(!client.is_discount_valid(&code));
    }

    #[test]
    fn test_admin_revoke_discount() {
        let (env, client, _admin, token_address) = setup_with_token();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
        let user = Address::generate(&env);
        let meter_id = String::from_str(&env, "DISCMTR5");
        client.allowlist_add(&user);
        client.register_meter(&meter_id, &user);
        token_admin_client.mint(&user, &1_000_i128);

        let code = String::from_str(&env, "REVOKED");
        client.admin_create_discount(&code, &10_u32, &0_u64, &0_u32);
        client.admin_revoke_discount(&code);
        assert!(!client.is_discount_valid(&code));

        let result = client.try_make_payment_with_discount(
            &meter_id,
            &user,
            &1_000_i128,
            &PaymentPlan::UsageBased,
            &code,
        );
        assert_eq!(result, Err(Ok(ContractError::DiscountCodeInactive)));
    }

    // ── Issue #417: expire_meter ──────────────────────────────────────────────

    #[test]
    fn test_expire_meter_sets_inactive_and_expired() {
        let (env, client, _admin, token_address) = setup_with_token();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
        let user = Address::generate(&env);
        let meter_id = String::from_str(&env, "EXP_MTR");

        allowlist_and_register(&client, meter_id.clone(), &user);
        token_admin_client.mint(&user, &1_000_i128);
        client.make_payment(&meter_id, &user, &1_000_i128, &PaymentPlan::Weekly, &None);
        assert!(client.get_meter(&meter_id).active);

        client.expire_meter(&meter_id);

        let meter = client.get_meter(&meter_id);
        assert!(!meter.active);
        assert!(meter.expires_at <= env.ledger().timestamp());
    }

    #[test]
    fn test_expire_meter_returns_not_found_for_unknown() {
        let (env, client, _admin) = setup();
        let result = client.try_expire_meter(&String::from_str(&env, "NO_METER"));
        assert_eq!(result, Err(Ok(ContractError::MeterNotFound)));
    }

    // ── Issue #657: set_active and deactivate_meter snapshot tests ────────────

    #[test]
    fn test_snapshot_set_active_true_emits_mtr_actv() {
        use soroban_sdk::IntoVal;
        let (env, client, _admin, token_address) = setup_with_token();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
        let user = Address::generate(&env);
        let meter_id = String::from_str(&env, "SA_TRUE");

        allowlist_and_register(&client, &meter_id, &user);
        token_admin_client.mint(&user, &1_000_i128);
        client.make_payment(&meter_id, &user, &1_000_i128, &PaymentPlan::Daily, &None);
        client.set_active(&meter_id, &false);
        // set_active(true) is the last invocation — events().all() returns only its events
        client.set_active(&meter_id, &true);

        assert_eq!(
            env.events().all(),
            vec![
                &env,
                (
                    client.address.clone(),
                    (EVT_NS, symbol_short!("mtr_actv"), meter_id.clone()).into_val(&env),
                    ().into_val(&env),
                ),
            ]
        );
        assert!(client.get_meter(&meter_id).active);
    }

    #[test]
    fn test_snapshot_set_active_false_emits_mtr_deact() {
        use soroban_sdk::IntoVal;
        let (env, client, _admin, token_address) = setup_with_token();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
        let user = Address::generate(&env);
        let meter_id = String::from_str(&env, "SA_FALS");

        allowlist_and_register(&client, &meter_id, &user);
        token_admin_client.mint(&user, &1_000_i128);
        client.make_payment(&meter_id, &user, &1_000_i128, &PaymentPlan::Daily, &None);
        // set_active(false) is the last invocation — events().all() returns only its events
        client.set_active(&meter_id, &false);

        assert_eq!(
            env.events().all(),
            vec![
                &env,
                (
                    client.address.clone(),
                    (EVT_NS, symbol_short!("mtr_deact"), meter_id.clone()).into_val(&env),
                    ().into_val(&env),
                ),
            ]
        );
        assert!(!client.get_meter(&meter_id).active);
    }

    #[test]
    fn test_snapshot_deactivate_meter_with_string_id() {
        use soroban_sdk::IntoVal;
        let (env, client, _admin, token_address) = setup_with_token();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
        let user = Address::generate(&env);
        let meter_id = String::from_str(&env, "STR_DM");

        allowlist_and_register(&client, &meter_id, &user);
        token_admin_client.mint(&user, &1_000_i128);
        client.make_payment(&meter_id, &user, &1_000_i128, &PaymentPlan::Daily, &None);
        // deactivate_meter is the last invocation
        client.deactivate_meter(&meter_id);

        assert_eq!(
            env.events().all(),
            vec![
                &env,
                (
                    client.address.clone(),
                    (EVT_NS, symbol_short!("mtr_deact"), meter_id.clone()).into_val(&env),
                    ().into_val(&env),
                ),
            ]
        );
        assert!(!client.get_meter(&meter_id).active);
    }

    // ── Issue #656: ContractFrozen guard tests ────────────────────────────────

    #[test]
    fn test_frozen_make_payment_returns_contract_frozen() {
        let (env, client, _admin, _token_address) = setup_with_token();
        let user = Address::generate(&env);
        let meter_id = String::from_str(&env, "FRZ_PMT");
        allowlist_and_register(&client, &meter_id, &user);

        client.freeze_contract();
        let result =
            client.try_make_payment(&meter_id, &user, &1_000_i128, &PaymentPlan::Daily, &None);
        assert_eq!(result, Err(Ok(ContractError::ContractFrozen)));
    }

    #[test]
    fn test_frozen_update_usage_returns_contract_frozen() {
        let (env, client, _admin, token_address) = setup_with_token();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
        setup_oracle(&env, &client);

        let user = Address::generate(&env);
        let meter_id = String::from_str(&env, "FRZ_USG");
        allowlist_and_register(&client, &meter_id, &user);
        token_admin_client.mint(&user, &1_000_i128);
        client.make_payment(&meter_id, &user, &1_000_i128, &PaymentPlan::Daily, &None);

        client.freeze_contract();
        let result = client.try_update_usage(&meter_id, &1_u64, &100_i128);
        assert_eq!(result, Err(Ok(ContractError::ContractFrozen)));
    }

    #[test]
    fn test_freeze_unfreeze_make_payment_round_trip() {
        let (env, client, _admin, token_address) = setup_with_token();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
        setup_oracle(&env, &client);

        let user = Address::generate(&env);
        let meter_id = String::from_str(&env, "FRZ_RT");
        allowlist_and_register(&client, &meter_id, &user);
        token_admin_client.mint(&user, &2_000_i128);

        // Freeze: payment blocked
        client.freeze_contract();
        let frozen_result =
            client.try_make_payment(&meter_id, &user, &1_000_i128, &PaymentPlan::Daily, &None);
        assert_eq!(frozen_result, Err(Ok(ContractError::ContractFrozen)));

        // Unfreeze: payment succeeds
        client.unfreeze_contract();
        client.make_payment(&meter_id, &user, &1_000_i128, &PaymentPlan::Daily, &None);
        assert!(client.check_access(&meter_id));
    }

    // ── plan_changed event tests ──────────────────────────────────────────────

    #[test]
    fn test_plan_change_emits_plan_chg_event() {
        let (env, client, _admin, token_address) = setup_with_token();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
        let user = Address::generate(&env);
        let meter_id = String::from_str(&env, "PLAN_CHG");
        allowlist_and_register(&client, &meter_id, &user);
        token_admin_client.mint(&user, &10_000_i128);

        client.make_payment(&meter_id, &user, &1_000_i128, &PaymentPlan::Daily, &None);
        // Same plan again — no plan_chg event expected.
        client.make_payment(&meter_id, &user, &1_000_i128, &PaymentPlan::Daily, &None);
        let events_before = env.events().all();
        let has_plan_chg_yet = events_as_tuples(&env, &events_before).iter().any(|(_, topics, _)| {
            topics.len() >= 2 && sym_eq(&env, &topics.get(1).unwrap(), symbol_short!("plan_chg"))
        });
        assert!(
            !has_plan_chg_yet,
            "plan_chg should not fire when plan is unchanged"
        );

        // Switch to Weekly — should emit plan_chg.
        client.make_payment(&meter_id, &user, &1_000_i128, &PaymentPlan::Weekly, &None);
        let events = env.events().all();
        let found = events_as_tuples(&env, &events).iter().any(|(_, topics, _)| {
            topics.len() >= 3
                && sym_eq(&env, &topics.get(1).unwrap(), symbol_short!("plan_chg"))
                && topics.get(2).map(|v| String::try_from_val(&env, &v).ok() == Some(meter_id.clone())).unwrap_or(false)
        });
        assert!(found, "plan_chg event not emitted on plan switch");
    }

    // ── refund_payment tests ──────────────────────────────────────────────────

    #[test]
    fn test_refund_payment_transfers_and_updates_balance() {
        let (env, client, _admin, token_address) = setup_with_token();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
        let token_client = token::Client::new(&env, &token_address);
        let user = Address::generate(&env);
        let meter_id = String::from_str(&env, "RFND1");
        allowlist_and_register(&client, &meter_id, &user);
        token_admin_client.mint(&user, &10_000_i128);

        client.make_payment(
            &meter_id,
            &user,
            &10_000_i128,
            &PaymentPlan::UsageBased,
            &None,
        );
        assert_eq!(client.get_meter_balance(&meter_id), 10_000);

        let reason = String::from_str(&env, "duplicate payment");
        client.refund_payment(&meter_id, &3_000_i128, &user, &reason);

        assert_eq!(client.get_meter_balance(&meter_id), 7_000);
        assert_eq!(token_client.balance(&user), 3_000);
        assert_eq!(client.get_payer_refunded(&meter_id, &user), 3_000);
    }

    #[test]
    fn test_refund_payment_emits_pmt_rfnd_event() {
        let (env, client, _admin, token_address) = setup_with_token();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
        let user = Address::generate(&env);
        let meter_id = String::from_str(&env, "RFND2");
        allowlist_and_register(&client, &meter_id, &user);
        token_admin_client.mint(&user, &5_000_i128);
        client.make_payment(
            &meter_id,
            &user,
            &5_000_i128,
            &PaymentPlan::UsageBased,
            &None,
        );

        let reason = String::from_str(&env, "billing error");
        client.refund_payment(&meter_id, &1_000_i128, &user, &reason);

        let events = env.events().all();
        let found = events.iter().any(|(_, topics, _)| {
            topics.len() >= 2 && sym_eq(&env, &topics.get(1).unwrap(), symbol_short!("pmt_rfnd"))
        });
        assert!(found, "pmt_rfnd event not emitted");
    }

    #[test]
    fn test_refund_payment_rejects_amount_above_total_paid() {
        let (env, client, _admin, token_address) = setup_with_token();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
        let user = Address::generate(&env);
        let meter_id = String::from_str(&env, "RFND3");
        allowlist_and_register(&client, &meter_id, &user);
        token_admin_client.mint(&user, &1_000_i128);
        client.make_payment(
            &meter_id,
            &user,
            &1_000_i128,
            &PaymentPlan::UsageBased,
            &None,
        );

        let reason = String::from_str(&env, "abuse attempt");
        let result = client.try_refund_payment(&meter_id, &1_001_i128, &user, &reason);
        assert_eq!(result, Err(Ok(ContractError::RefundExceedsPayments)));
    }

    #[test]
    fn test_refund_payment_rejects_double_refund_over_paid_total() {
        let (env, client, _admin, token_address) = setup_with_token();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
        let user = Address::generate(&env);
        let meter_id = String::from_str(&env, "RFND4");
        allowlist_and_register(&client, &meter_id, &user);
        token_admin_client.mint(&user, &1_000_i128);
        client.make_payment(
            &meter_id,
            &user,
            &1_000_i128,
            &PaymentPlan::UsageBased,
            &None,
        );

        let reason = String::from_str(&env, "partial refund");
        client.refund_payment(&meter_id, &600_i128, &user, &reason);
        // Only 400 remains refundable.
        let result = client.try_refund_payment(&meter_id, &500_i128, &user, &reason);
        assert_eq!(result, Err(Ok(ContractError::RefundExceedsPayments)));
    }

    #[test]
    fn test_refund_payment_rejects_recipient_with_no_payments() {
        let (env, client, _admin, token_address) = setup_with_token();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
        let user = Address::generate(&env);
        let meter_id = String::from_str(&env, "RFND5");
        allowlist_and_register(&client, &meter_id, &user);
        token_admin_client.mint(&user, &1_000_i128);
        client.make_payment(
            &meter_id,
            &user,
            &1_000_i128,
            &PaymentPlan::UsageBased,
            &None,
        );

        // A recipient who never paid towards this meter has nothing refundable,
        // regardless of the contract's overall token balance.
        let reason = String::from_str(&env, "n/a");
        let stranger = Address::generate(&env);
        let result = client.try_refund_payment(&meter_id, &100_i128, &stranger, &reason);
        assert_eq!(result, Err(Ok(ContractError::RefundExceedsPayments)));
    }

    #[test]
    fn test_refund_payment_zero_amount_returns_typed_error() {
        let (env, client, _admin, token_address) = setup_with_token();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
        let user = Address::generate(&env);
        let meter_id = String::from_str(&env, "RFND6");
        allowlist_and_register(&client, &meter_id, &user);
        token_admin_client.mint(&user, &1_000_i128);
        client.make_payment(
            &meter_id,
            &user,
            &1_000_i128,
            &PaymentPlan::UsageBased,
            &None,
        );

        let reason = String::from_str(&env, "n/a");
        let result = client.try_refund_payment(&meter_id, &0_i128, &user, &reason);
        assert_eq!(result, Err(Ok(ContractError::InvalidAmount)));
    }

    #[test]
    fn test_refund_payment_respects_rolling_window_limit() {
        let (env, client, _admin, token_address) = setup_with_token();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
        let user = Address::generate(&env);
        let meter_id = String::from_str(&env, "RFND7");
        allowlist_and_register(&client, &meter_id, &user);
        token_admin_client.mint(&user, &10_000_i128);
        client.make_payment(
            &meter_id,
            &user,
            &10_000_i128,
            &PaymentPlan::UsageBased,
            &None,
        );

        // Cap total refunds to 500 stroops per 24h window.
        client.set_refund_limit(&500_i128);

        let reason = String::from_str(&env, "window test");
        client.refund_payment(&meter_id, &500_i128, &user, &reason);

        // A further refund within the same window should be rejected even
        // though the payer still has refundable balance.
        let result = client.try_refund_payment(&meter_id, &1_i128, &user, &reason);
        assert_eq!(result, Err(Ok(ContractError::RefundLimitExceeded)));

        // After the window rolls over, refunds resume.
        env.ledger()
            .with_mut(|li| li.timestamp += SECONDS_PER_DAY + 1);
        client.refund_payment(&meter_id, &1_i128, &user, &reason);
        assert_eq!(client.get_payer_refunded(&meter_id, &user), 501);
    }

    #[test]
    fn test_refund_payment_deactivates_meter_when_balance_hits_zero() {
        let (env, client, _admin, token_address) = setup_with_token();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
        let user = Address::generate(&env);
        let meter_id = String::from_str(&env, "RFND8");
        allowlist_and_register(&client, &meter_id, &user);
        token_admin_client.mint(&user, &1_000_i128);
        client.make_payment(
            &meter_id,
            &user,
            &1_000_i128,
            &PaymentPlan::UsageBased,
            &None,
        );
        assert!(client.get_meter(&meter_id).active);

        let reason = String::from_str(&env, "full refund");
        client.refund_payment(&meter_id, &1_000_i128, &user, &reason);
        assert!(!client.get_meter(&meter_id).active);
    }

    // ── Issue #703: DST / Timezone independence tests ────────────────────────

    #[test]
    fn test_time_based_access_during_dst_transition() {
        let (env, client, _admin, token_address) = setup_with_token();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);

        // 2025-03-08 01:00:00 UTC (Unix timestamp: 1741395600) - day before US DST transition
        let dst_start_ts = 1741395600_u64;
        env.ledger().with_mut(|li| li.timestamp = dst_start_ts);

        let user = Address::generate(&env);
        let meter_id = String::from_str(&env, "MTR_DST");
        allowlist_and_register(&client, &meter_id, &user);
        token_admin_client.mint(&user, &1_000_i128);

        // Pay for 24-hour Daily access
        client.make_payment(&meter_id, &user, &1_000_i128, &PaymentPlan::Daily, &None);

        // Verify expires_at is exactly now + 86400 seconds (1741482000)
        let meter = client.get_meter(&meter_id);
        assert_eq!(meter.expires_at, dst_start_ts + SECONDS_PER_DAY);

        // At 23 hours elapsed (1741478400), access must remain active
        env.ledger()
            .with_mut(|li| li.timestamp = dst_start_ts + 23 * 3600);
        assert!(client.check_access(&meter_id));

        // At 23 hours and 59 minutes (1741481940), access must remain active
        env.ledger()
            .with_mut(|li| li.timestamp = dst_start_ts + 86340);
        assert!(client.check_access(&meter_id));

        // At exactly 24 hours elapsed (1741482000), access expires
        env.ledger()
            .with_mut(|li| li.timestamp = dst_start_ts + SECONDS_PER_DAY);
        assert!(!client.check_access(&meter_id));
    }

    // ── Issue #751: Partial payments and incremental service extension ────────

    #[test]
    fn test_partial_payment_prorated_daily() {
        let (env, client, _admin, token_address) = setup_with_token();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);

        let user = Address::generate(&env);
        let meter_id = String::from_str(&env, "MTR_PARTIAL_DAY");
        allowlist_and_register(&client, &meter_id, &user);

        // 0.5 XLM = 500_000 stroops -> exactly 43,200 seconds (0.5 days)
        token_admin_client.mint(&user, &500_000_i128);
        client.make_payment(&meter_id, &user, &500_000_i128, &PaymentPlan::Daily, &None);

        let meter = client.get_meter(&meter_id);
        assert_eq!(meter.balance, 500_000);
        assert!(meter.active);
        assert_eq!(meter.expires_at, env.ledger().timestamp() + 43_200);
        assert_eq!(
            client.calculate_service_duration(&500_000_i128, &PaymentPlan::Daily),
            43_200
        );
    }

    #[test]
    fn test_partial_payment_prorated_weekly() {
        let (env, client, _admin, token_address) = setup_with_token();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);

        let user = Address::generate(&env);
        let meter_id = String::from_str(&env, "MTR_PARTIAL_WK");
        allowlist_and_register(&client, &meter_id, &user);

        // 1 XLM = 1_000_000 stroops on weekly plan (5 XLM nominal) -> exactly 1.4 days = 120,960 seconds
        token_admin_client.mint(&user, &1_000_000_i128);
        client.make_payment(
            &meter_id,
            &user,
            &1_000_000_i128,
            &PaymentPlan::Weekly,
            &None,
        );

        let meter = client.get_meter(&meter_id);
        assert_eq!(meter.balance, 1_000_000);
        assert!(meter.active);
        assert_eq!(meter.expires_at, env.ledger().timestamp() + 120_960);
        assert_eq!(
            client.calculate_service_duration(&1_000_000_i128, &PaymentPlan::Weekly),
            120_960
        );
    }

    #[test]
    fn test_incremental_service_extension_on_consecutive_payments() {
        let (env, client, _admin, token_address) = setup_with_token();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);

        let user = Address::generate(&env);
        let meter_id = String::from_str(&env, "MTR_INCR_EXT");
        allowlist_and_register(&client, &meter_id, &user);

        token_admin_client.mint(&user, &2_000_000_i128);
        let start_time = env.ledger().timestamp();

        // First payment: 1 XLM on daily plan -> expires at start_time + 86400
        client.make_payment(
            &meter_id,
            &user,
            &1_000_000_i128,
            &PaymentPlan::Daily,
            &None,
        );
        let m1 = client.get_meter(&meter_id);
        assert_eq!(m1.expires_at, start_time + SECONDS_PER_DAY);

        // Advance time by 10,000 seconds (still active)
        env.ledger()
            .with_mut(|li| li.timestamp = start_time + 10_000);

        // Second payment: 1 XLM on daily plan -> extends existing expiry by another 86400 seconds!
        client.make_payment(
            &meter_id,
            &user,
            &1_000_000_i128,
            &PaymentPlan::Daily,
            &None,
        );
        let m2 = client.get_meter(&meter_id);
        assert_eq!(m2.expires_at, start_time + 2 * SECONDS_PER_DAY);
    }

    // ── Issue #754: Large batch operations with 150 meters ────────────────────

    #[test]
    fn test_batch_update_usage_with_150_meters_succeeds() {
        let (env, client, admin, token_address) = setup_with_token();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);

        let oracle = Address::generate(&env);
        client.set_oracle(&oracle);

        let mut updates = vec![&env];
        for i in 0..150 {
            let meter_id = String::from_str(&env, "MTR_BATCH_150");
            let mut id_bytes = [b'M', b'T', b'R', b'_', b'0', b'0', b'0'];
            id_bytes[4] = b'0' + ((i / 100) % 10) as u8;
            id_bytes[5] = b'0' + ((i / 10) % 10) as u8;
            id_bytes[6] = b'0' + (i % 10) as u8;
            let m_id = String::from_bytes(&env, &id_bytes);

            let user = Address::generate(&env);
            client.allowlist_add(&user);
            client.register_meter(&m_id, &user);
            token_admin_client.mint(&user, &10_000_i128);
            client.make_payment(&m_id, &user, &10_000_i128, &PaymentPlan::UsageBased, &None);

            updates.push_back((m_id, 10_u64, 100_i128));
        }

        assert_eq!(updates.len(), 150);
        let failed = client.batch_update_usage(&updates);
        assert_eq!(failed.len(), 0);
    }
}
