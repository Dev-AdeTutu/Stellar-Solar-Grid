use soroban_sdk::{contracttype, contractimpl, contracterror, Address, Env, Symbol, Vec, Map, symbol_short};

// ============================================================================
// Error Definitions
// ============================================================================

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum DrError {
    EventNotFound = 1,
    EventNotActive = 2,
    EventAlreadyTriggered = 3,
    OptInNotFound = 4,
    AlreadyOptedIn = 5,
    NotOptedIn = 6,
    InvalidCurtailmentTarget = 7,
    InvalidIncentiveRate = 8,
    PerformanceNotFound = 9,
    Unauthorized = 10,
    InvalidTimeWindow = 11,
    NoParticipants = 12,
    AlreadyDistributed = 13,
    InvalidLoadPreference = 14,
}

// ============================================================================
// Data Structures
// ============================================================================

/// A demand response event defining a curtailment target over a time window.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DemandResponseEvent {
    pub event_id: u64,
    /// Total curtailment target in watts.
    pub curtailment_target_watts: u64,
    /// Unix timestamp when the DR event starts.
    pub start_time: u64,
    /// Unix timestamp when the DR event ends.
    pub end_time: u64,
    /// Incentive rate in stroops per watt curtailed.
    pub incentive_rate_per_watt: u64,
    /// Whether the event has been triggered (curtailment enforced).
    pub triggered: bool,
    /// Whether incentives have been distributed.
    pub incentives_distributed: bool,
    /// Address that created the event.
    pub creator: Address,
    /// Total watts curtailed across all participants (filled after performance).
    pub total_curtailed_watts: u64,
}

/// A user's opt-in record with per-circuit load preferences.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DrOptIn {
    pub user: Address,
    /// Whether the user is currently opted in.
    pub active: bool,
    /// Maximum watts the user is willing to curtail.
    pub max_curtailment_watts: u64,
    /// Per-circuit curtailment preferences: circuit id -> max watts to curtail.
    pub circuit_preferences: Map<Symbol, u64>,
    /// Priority level (higher = curtailed first). 0-100.
    pub priority: u32,
    /// Timestamp of opt-in.
    pub opted_in_at: u64,
}

/// Performance verification record for a user during a DR event.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DrPerformance {
    pub event_id: u64,
    pub user: Address,
    /// Baseline load in watts before the event.
    pub baseline_watts: u64,
    /// Actual load in watts during the event.
    pub actual_watts: u64,
    /// Watts curtailed (baseline - actual, floored at 0).
    pub curtailed_watts: u64,
    /// Whether the performance has been verified.
    pub verified: bool,
    /// Timestamp of the record.
    pub recorded_at: u64,
}

/// Incentive distribution record for a user.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DrIncentive {
    pub event_id: u64,
    pub user: Address,
    pub curtailed_watts: u64,
    pub incentive_amount: u64,
    pub distributed: bool,
    pub distributed_at: u64,
}

// ============================================================================
// Storage Keys
// ============================================================================

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DrDataKey {
    /// Counter for generating event ids.
    EventCounter,
    /// DemandResponseEvent by event id.
    Event(u64),
    /// DrOptIn by user address.
    OptIn(Address),
    /// List of opted-in users (Vec<Address>).
    OptInList,
    /// DrPerformance by (event id, user).
    Performance(u64, Address),
    /// List of participants for an event (Vec<Address>).
    EventParticipants(u64),
    /// DrIncentive by (event id, user).
    Incentive(u64, Address),
    /// Admin address authorized to create/trigger events.
    Admin,
}

// ============================================================================
// Event Topics
// ============================================================================

const TOPIC_EVENT_CREATED: Symbol = symbol_short!("dr_created");
const TOPIC_OPT_IN: Symbol = symbol_short!("dr_optin");
const TOPIC_OPT_OUT: Symbol = symbol_short!("dr_optout");
const TOPIC_TRIGGERED: Symbol = symbol_short!("dr_trigger");
const TOPIC_PERFORMANCE: Symbol = symbol_short!("dr_perf");
const TOPIC_INCENTIVE: Symbol = symbol_short!("dr_incent");

// ============================================================================
// Contract Implementation
// ============================================================================

pub struct DemandResponseContract;

#[contractimpl]
impl DemandResponseContract {
    /// Initialize the admin for the DR module.
    pub fn init_dr_admin(env: Env, admin: Address) -> Result<(), DrError> {
        if env.storage().instance().has(&DrDataKey::Admin) {
            return Err(DrError::Unauthorized);
        }
        admin.require_auth();
        env.storage().instance().set(&DrDataKey::Admin, &admin);
        env.storage().instance().set(&DrDataKey::EventCounter, &0u64);
        Ok(())
    }

    /// Create a new demand response event with a curtailment target.
    pub fn create_dr_event(
        env: Env,
        creator: Address,
        curtailment_target_watts: u64,
        start_time: u64,
        end_time: u64,
        incentive_rate_per_watt: u64,
    ) -> Result<u64, DrError> {
        creator.require_auth();

        // Only admin may create events.
        let admin: Address = env
            .storage()
            .instance()
            .get(&DrDataKey::Admin)
            .ok_or(DrError::Unauthorized)?;
        if creator != admin {
            return Err(DrError::Unauthorized);
        }

        if curtailment_target_watts == 0 {
            return Err(DrError::InvalidCurtailmentTarget);
        }
        if end_time <= start_time {
            return Err(DrError::InvalidTimeWindow);
        }
        if incentive_rate_per_watt == 0 {
            return Err(DrError::InvalidIncentiveRate);
        }

        let mut counter: u64 = env
            .storage()
            .instance()
            .get(&DrDataKey::EventCounter)
            .unwrap_or(0);
        counter += 1;
        let event_id = counter;
        env.storage()
            .instance()
            .set(&DrDataKey::EventCounter, &counter);

        let event = DemandResponseEvent {
            event_id,
            curtailment_target_watts,
            start_time,
            end_time,
            incentive_rate_per_watt,
            triggered: false,
            incentives_distributed: false,
            creator: creator.clone(),
            total_curtailed_watts: 0,
        };

        env.storage()
            .persistent()
            .set(&DrDataKey::Event(event_id), &event);

        env.events().publish(
            (TOPIC_EVENT_CREATED, event_id),
            (creator, curtailment_target_watts, start_time, end_time),
        );

        Ok(event_id)
    }

    /// Opt a user into demand response with load preferences.
    pub fn opt_in_dr(
        env: Env,
        user: Address,
        max_curtailment_watts: u64,
        circuit_preferences: Map<Symbol, u64>,
        priority: u32,
    ) -> Result<(), DrError> {
        user.require_auth();

        if max_curtailment_watts == 0 {
            return Err(DrError::InvalidLoadPreference);
        }
        if priority > 100 {
            return Err(DrError::InvalidLoadPreference);
        }

        // Validate circuit preferences do not exceed max curtailment.
        let mut circuit_total: u64 = 0;
        for (_k, v) in circuit_preferences.iter() {
            circuit_total = circuit_total.saturating_add(v);
        }
        if circuit_total > max_curtailment_watts {
            return Err(DrError::InvalidLoadPreference);
        }

        let key = DrDataKey::OptIn(user.clone());
        if let Some(existing) = env.storage().persistent().get::<_, DrOptIn>(&key) {
            if existing.active {
                return Err(DrError::AlreadyOptedIn);
            }
        }

        let now = env.ledger().timestamp();
        let opt_in = DrOptIn {
            user: user.clone(),
            active: true,
            max_curtailment_watts,
            circuit_preferences,
            priority,
            opted_in_at: now,
        };
        env.storage().persistent().set(&key, &opt_in);

        // Maintain opt-in list.
        let mut list: Vec<Address> = env
            .storage()
            .persistent()
            .get(&DrDataKey::OptInList)
            .unwrap_or(Vec::new(&env));
        let mut found = false;
        for a in list.iter() {
            if a == user {
                found = true;
                break;
            }
        }
        if !found {
            list.push_back(user.clone());
            env.storage().persistent().set(&DrDataKey::OptInList, &list);
        }

        env.events().publish(
            (TOPIC_OPT_IN, user.clone()),
            (max_curtailment_watts, priority, now),
        );

        Ok(())
    }

    /// Opt a user out of demand response.
    pub fn opt_out_dr(env: Env, user: Address) -> Result<(), DrError> {
        user.require_auth();

        let key = DrDataKey::OptIn(user.clone());
        let mut opt_in: DrOptIn = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(DrError::OptInNotFound)?;

        if !opt_in.active {
            return Err(DrError::NotOptedIn);
        }

        opt_in.active = false;
        env.storage().persistent().set(&key, &opt_in);

        env.events()
            .publish((TOPIC_OPT_OUT, user.clone()), env.ledger().timestamp());

        Ok(())
    }

    /// Trigger automated curtailment for a DR event.
    /// Returns the list of users whose loads should be curtailed and by how much.
    pub fn trigger_dr_curtailment(
        env: Env,
        caller: Address,
        event_id: u64,
    ) -> Result<Vec<(Address, u64)>, DrError> {
        caller.require_auth();

        let admin: Address = env
            .storage()
            .instance()
            .get(&DrDataKey::Admin)
            .ok_or(DrError::Unauthorized)?;
        if caller != admin {
            return Err(DrError::Unauthorized);
        }

        let mut event: DemandResponseEvent = env
            .storage()
            .persistent()
            .get(&DrDataKey::Event(event_id))
            .ok_or(DrError::EventNotFound)?;

        if event.triggered {
            return Err(DrError::EventAlreadyTriggered);
        }

        let now = env.ledger().timestamp();
        if now < event.start_time || now > event.end_time {
            return Err(DrError::EventNotActive);
        }

        // Gather opted-in users, sort by priority (higher first), and allocate
        // curtailment until the target is met.
        let list: Vec<Address> = env
            .storage()
            .persistent()
            .get(&DrDataKey::OptInList)
            .unwrap_or(Vec::new(&env));

        // Collect active opt-ins.
        let mut active: Vec<DrOptIn> = Vec::new(&env);
        for a in list.iter() {
            if let Some(o) = env
                .storage()
                .persistent()
                .get::<_, DrOptIn>(&DrDataKey::OptIn(a.clone()))
            {
                if o.active {
                    active.push_back(o);
                }
            }
        }

        if active.is_empty() {
            return Err(DrError::NoParticipants);
        }

        // Simple selection sort by priority descending (stable enough for small lists).
        let n = active.len();
        let mut sorted: Vec<DrOptIn> = Vec::new(&env);
        let mut used: Vec<bool> = Vec::new(&env);
        for _ in 0..n {
            used.push_back(false);
        }
        for _ in 0..n {
            let mut best_idx: u32 = 0;
            let mut best_prio: u32 = 0;
            let mut first = true;
            for i in 0..n {
                if used.get(i).unwrap_or(false) {
                    continue;
                }
                let o = active.get(i).unwrap();
                if first || o.priority > best_prio {
                    best_prio = o.priority;
                    best_idx = i;
                    first = false;
                }
            }
            used.set(best_idx, true);
            sorted.push_back(active.get(best_idx).unwrap());
        }

        let mut remaining = event.curtailment_target_watts;
        let mut allocations: Vec<(Address, u64)> = Vec::new(&env);
        let mut participants: Vec<Address> = Vec::new(&env);

        for o in sorted.iter() {
            if remaining == 0 {
                break;
            }
            let take = if o.max_curtailment_watts < remaining {
                o.max_curtailment_watts
            } else {
                remaining
            };
            if take > 0 {
                allocations.push_back((o.user.clone(), take));
                participants.push_back(o.user.clone());
                remaining -= take;
            }
        }

        event.triggered = true;
        env.storage()
            .persistent()
            .set(&DrDataKey::Event(event_id), &event);
        env.storage()
            .persistent()
            .set(&DrDataKey::EventParticipants(event_id), &participants);

        env.events().publish(
            (TOPIC_TRIGGERED, event_id),
            (allocations.clone(), event.curtailment_target_watts),
        );

        Ok(allocations)
    }

    /// Record performance verification for a user during a DR event.
    pub fn record_dr_performance(
        env: Env,
        caller: Address,
        event_id: u64,
        user: Address,
        baseline_watts: u64,
        actual_watts: u64,
    ) -> Result<DrPerformance, DrError> {
        caller.require_auth();

        let admin: Address = env
            .storage()
            .instance()
            .get(&DrDataKey::Admin)
            .ok_or(DrError::Unauthorized)?;
        if caller != admin {
            return Err(DrError::Unauthorized);
        }

        let mut event: DemandResponseEvent = env
            .storage()
            .persistent()
            .get(&DrDataKey::Event(event_id))
            .ok_or(DrError::EventNotFound)?;

        if !event.triggered {
            return Err(DrError::EventNotActive);
        }

        let curtailed = if baseline_watts > actual_watts {
            baseline_watts - actual_watts
        } else {
            0
        };

        let now = env.ledger().timestamp();
        let perf = DrPerformance {
            event_id,
            user: user.clone(),
            baseline_watts,
            actual_watts,
            curtailed_watts: curtailed,
            verified: true,
            recorded_at: now,
        };

        env.storage()
            .persistent()
            .set(&DrDataKey::Performance(event_id, user.clone()), &perf);

        // Accumulate total curtailed watts on the event.
        event.total_curtailed_watts = event
            .total_curtailed_watts
            .saturating_add(curtailed);
        env.storage()
            .persistent()
            .set(&DrDataKey::Event(event_id), &event);

        env.events().publish(
            (TOPIC_PERFORMANCE, event_id),
            (user, baseline_watts, actual_watts, curtailed),
        );

        Ok(perf)
    }

    /// Calculate and distribute incentive payments for a DR event.
    pub fn calculate_and_distribute_incentives(
        env: Env,
        caller: Address,
        event_id: u64,
    ) -> Result<Vec<DrIncentive>, DrError> {
        caller.require_auth();

        let admin: Address = env
            .storage()
            .instance()
            .get(&DrDataKey::Admin)
            .ok_or(DrError::Unauthorized)?;
        if caller != admin {
            return Err(DrError::Unauthorized);
        }

        let mut event: DemandResponseEvent = env
            .storage()
            .persistent()
            .get(&DrDataKey::Event(event_id))
            .ok_or(DrError::EventNotFound)?;

        if !event.triggered {
            return Err(DrError::EventNotActive);
        }
        if event.incentives_distributed {
            return Err(DrError::AlreadyDistributed);
        }

        let participants: Vec<Address> = env
            .storage()
            .persistent()
            .get(&DrDataKey::EventParticipants(event_id))
            .unwrap_or(Vec::new(&env));

        if participants.is_empty() {
            return Err(DrError::NoParticipants);
        }

        let now = env.ledger().timestamp();
        let mut results: Vec<DrIncentive> = Vec::new(&env);

        for user in participants.iter() {
            let perf_key = DrDataKey::Performance(event_id, user.clone());
            let perf: DrPerformance = match env.storage().persistent().get(&perf_key) {
                Some(p) => p,
                None => continue,
            };

            let amount = perf
                .curtailed_watts
                .saturating_mul(event.incentive_rate_per_watt);

            let incentive = DrIncentive {
                event_id,
                user: user.clone(),
                curtailed_watts: perf.curtailed_watts,
                incentive_amount: amount,
                distributed: true,
                distributed_at: now,
            };

            env.storage().persistent().set(
                &DrDataKey::Incentive(event_id, user.clone()),
                &incentive,
            );

            env.events().publish(
                (TOPIC_INCENTIVE, event_id),
                (user.clone(), perf.curtailed_watts, amount),
            );

            results.push_back(incentive);
        }

        event.incentives_distributed = true;
        env.storage()
            .persistent()
            .set(&DrDataKey::Event(event_id), &event);

        Ok(results)
    }

    /// Retrieve a DR event by id.
    pub fn get_dr_event(env: Env, event_id: u64) -> Result<DemandResponseEvent, DrError> {
        env.storage()
            .persistent()
            .get(&DrDataKey::Event(event_id))
            .ok_or(DrError::EventNotFound)
    }

    /// Retrieve a user's opt-in record.
    pub fn get_dr_opt_in(env: Env, user: Address) -> Result<DrOptIn, DrError> {
        env.storage()
            .persistent()
            .get(&DrDataKey::OptIn(user))
            .ok_or(DrError::OptInNotFound)
    }

    /// Retrieve a user's performance record for an event.
    pub fn get_dr_performance(
        env: Env,
        event_id: u64,
        user: Address,
    ) -> Result<DrPerformance, DrError> {
        env.storage()
            .persistent()
            .get(&DrDataKey::Performance(event_id, user))
            .ok_or(DrError::PerformanceNotFound)
    }

    /// Retrieve a user's incentive record for an event.
    pub fn get_dr_incentive(
        env: Env,
        event_id: u64,
        user: Address,
    ) -> Result<DrIncentive, DrError> {
        env.storage()
            .persistent()
            .get(&DrDataKey::Incentive(event_id, user))
            .ok_or(DrError::PerformanceNotFound)
    }
}