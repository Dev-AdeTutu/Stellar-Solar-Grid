//! Scheduled energy usage for circuits (Issue #1001).
//!
//! A meter owner can define a weekly on/off `Schedule` per circuit (a
//! sub-load of a meter, identified by an arbitrary `circuit_id` string the
//! IoT firmware/backend already uses to address it). The IoT layer polls
//! `execute_scheduled_action` (or the read-only `circuit_should_be_on`) on a
//! timer and relays the result to the physical circuit.
//!
//! An `override_circuit` call lets the owner force a circuit ON or OFF until
//! a given timestamp — e.g. for an emergency — which supersedes whatever the
//! weekly schedule says until it expires, at which point the schedule
//! resumes automatically (no action needed to "end" an override).

use crate::{ContractError, Meter, SolarGridContract, SolarGridContractArgs, SolarGridContractClient};
use soroban_sdk::{contractimpl, contracttype, symbol_short, Address, Env, String};

/// Seconds in a day, used to derive day-of-week/minute-of-day from the ledger
/// timestamp (Unix epoch seconds).
const SECS_PER_DAY: u64 = 86_400;
/// Minutes in a day — the valid range for `Schedule::start_time`/`end_time`.
const MINUTES_PER_DAY: u32 = 1_440;
/// Only the low 7 bits (one per day of week) of `Schedule::days` are valid.
const VALID_DAY_BITS: u32 = 0x7F;

#[contracttype]
#[derive(Clone)]
enum ScheduleKey {
    /// A circuit's weekly schedule, keyed by (meter_id, circuit_id).
    Schedule(String, String),
    /// An active emergency override, keyed by (meter_id, circuit_id).
    Override(String, String),
}

/// A weekly on/off schedule for one circuit on one meter.
///
/// `days` is a bitmask of days of week the schedule applies on; bit 0 is
/// Sunday through bit 6 Saturday (`1 << day`), matching the convention used
/// by `chrono`/JavaScript's `Date.getUTCDay()`. `start_time`/`end_time` are
/// minute-of-day (0..1440, UTC) the circuit should be ON; `start_time >
/// end_time` is treated as a window spanning midnight (e.g. 22:00 -> 06:00).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Schedule {
    pub circuit_id: String,
    pub days: u32,
    pub start_time: u32,
    pub end_time: u32,
    /// Lets the owner disable a schedule without deleting it.
    pub enabled: bool,
}

/// A temporary forced state for a circuit that supersedes its `Schedule`
/// until `until` (a ledger timestamp), e.g. for emergencies.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CircuitOverride {
    pub forced_state: bool,
    pub until: u64,
    pub set_by: Address,
}

fn validate_schedule(schedule: &Schedule) -> Result<(), ContractError> {
    if schedule.days & !VALID_DAY_BITS != 0 {
        return Err(ContractError::InvalidSchedule);
    }
    if schedule.start_time >= MINUTES_PER_DAY || schedule.end_time >= MINUTES_PER_DAY {
        return Err(ContractError::InvalidSchedule);
    }
    Ok(())
}

/// Day of week for a Unix timestamp: 0 = Sunday .. 6 = Saturday.
/// Jan 1 1970 (epoch day 0) was a Thursday (4), so `(epoch_day + 4) % 7`.
fn weekday_of(ts: u64) -> u32 {
    (((ts / SECS_PER_DAY) + 4) % 7) as u32
}

fn minute_of_day(ts: u64) -> u32 {
    ((ts % SECS_PER_DAY) / 60) as u32
}

/// Whether `schedule` calls for the circuit to be ON at `now`.
fn schedule_matches(schedule: &Schedule, now: u64) -> bool {
    if !schedule.enabled {
        return false;
    }
    let minute = minute_of_day(now);
    let today = weekday_of(now);

    if schedule.start_time <= schedule.end_time {
        (schedule.days >> today) & 1 == 1
            && minute >= schedule.start_time
            && minute < schedule.end_time
    } else {
        // Overnight window: the portion after midnight belongs to the
        // previous day's scheduled start.
        if minute >= schedule.start_time {
            (schedule.days >> today) & 1 == 1
        } else if minute < schedule.end_time {
            let yesterday = (today + 6) % 7;
            (schedule.days >> yesterday) & 1 == 1
        } else {
            false
        }
    }
}

fn load_meter(env: &Env, meter_id: &String) -> Result<Meter, ContractError> {
    SolarGridContract::get_meter(env.clone(), meter_id.clone())
}

#[contractimpl]
impl SolarGridContract {
    /// Owner: create or replace the schedule for `schedule.circuit_id` on
    /// `meter_id`.
    pub fn set_circuit_schedule(
        env: Env,
        meter_id: String,
        schedule: Schedule,
    ) -> Result<(), ContractError> {
        let meter = load_meter(&env, &meter_id)?;
        meter.owner.require_auth();
        validate_schedule(&schedule)?;

        env.storage().persistent().set(
            &ScheduleKey::Schedule(meter_id.clone(), schedule.circuit_id.clone()),
            &schedule,
        );
        env.events().publish(
            (symbol_short!("solar"), symbol_short!("sch_set"), meter_id),
            schedule.circuit_id,
        );
        Ok(())
    }

    /// The schedule for `circuit_id` on `meter_id`, if one has been set.
    pub fn get_circuit_schedule(
        env: Env,
        meter_id: String,
        circuit_id: String,
    ) -> Result<Schedule, ContractError> {
        env.storage()
            .persistent()
            .get(&ScheduleKey::Schedule(meter_id, circuit_id))
            .ok_or(ContractError::ScheduleNotFound)
    }

    /// Owner: remove the schedule for `circuit_id` on `meter_id`, if any.
    pub fn clear_circuit_schedule(
        env: Env,
        meter_id: String,
        circuit_id: String,
    ) -> Result<(), ContractError> {
        let meter = load_meter(&env, &meter_id)?;
        meter.owner.require_auth();
        env.storage()
            .persistent()
            .remove(&ScheduleKey::Schedule(meter_id, circuit_id));
        Ok(())
    }

    /// Owner: force `circuit_id` on `meter_id` to `forced_state` until
    /// `until` (a ledger timestamp in the future), superseding its schedule
    /// — e.g. for an emergency. The override lapses automatically once `now`
    /// reaches `until`; no call is needed to end it.
    pub fn override_circuit(
        env: Env,
        meter_id: String,
        circuit_id: String,
        forced_state: bool,
        until: u64,
    ) -> Result<(), ContractError> {
        let meter = load_meter(&env, &meter_id)?;
        meter.owner.require_auth();
        if until <= env.ledger().timestamp() {
            return Err(ContractError::InvalidOverrideWindow);
        }

        let ov = CircuitOverride {
            forced_state,
            until,
            set_by: meter.owner,
        };
        env.storage().persistent().set(
            &ScheduleKey::Override(meter_id.clone(), circuit_id.clone()),
            &ov,
        );
        env.events().publish(
            (symbol_short!("solar"), symbol_short!("sch_ovr"), meter_id),
            (circuit_id, forced_state, until),
        );
        Ok(())
    }

    /// Owner: end an active override early, letting the schedule resume
    /// immediately instead of waiting for `until`.
    pub fn clear_circuit_override(
        env: Env,
        meter_id: String,
        circuit_id: String,
    ) -> Result<(), ContractError> {
        let meter = load_meter(&env, &meter_id)?;
        meter.owner.require_auth();
        env.storage()
            .persistent()
            .remove(&ScheduleKey::Override(meter_id, circuit_id));
        Ok(())
    }

    /// The active override for `circuit_id` on `meter_id`, if any (expired
    /// overrides are not pruned automatically, so callers should check
    /// `until` against the current time).
    pub fn get_circuit_override(
        env: Env,
        meter_id: String,
        circuit_id: String,
    ) -> Option<CircuitOverride> {
        env.storage()
            .persistent()
            .get(&ScheduleKey::Override(meter_id, circuit_id))
    }

    /// Whether `circuit_id` on `meter_id` should be ON at `now`: an
    /// unexpired override wins, otherwise the weekly `Schedule` decides.
    /// Read-only — callers (e.g. the IoT bridge) use this to decide what
    /// relay command to send without mutating state.
    pub fn circuit_should_be_on(
        env: Env,
        meter_id: String,
        circuit_id: String,
        now: u64,
    ) -> Result<bool, ContractError> {
        if let Some(ov) =
            Self::get_circuit_override(env.clone(), meter_id.clone(), circuit_id.clone())
        {
            if now < ov.until {
                return Ok(ov.forced_state);
            }
        }
        let schedule = Self::get_circuit_schedule(env, meter_id, circuit_id)?;
        Ok(schedule_matches(&schedule, now))
    }

    /// IoT entrypoint: evaluate the due action for `circuit_id` on
    /// `meter_id` at `now` and, if it differs from `last_state` (the
    /// relay's last known state), publish a `ScheduledActionExecuted` event
    /// so the backend can send the corresponding relay command. Always
    /// returns the desired state, whether or not an event was published.
    pub fn execute_scheduled_action(
        env: Env,
        meter_id: String,
        circuit_id: String,
        now: u64,
        last_state: bool,
    ) -> Result<bool, ContractError> {
        let desired =
            Self::circuit_should_be_on(env.clone(), meter_id.clone(), circuit_id.clone(), now)?;
        if desired != last_state {
            env.events().publish(
                (symbol_short!("solar"), symbol_short!("sch_exec"), meter_id),
                (circuit_id, desired, now),
            );
        }
        Ok(desired)
    }
}
