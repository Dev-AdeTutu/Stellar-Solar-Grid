//! Scheduled energy usage tests (Issue #1001).
mod common;

use common::Fixture;
use solar_grid::{ContractError, Schedule};
use soroban_sdk::{symbol_short, testutils::Events, IntoVal, String, TryFromVal, Val};

fn schedule(f: &Fixture, circuit: &str, days: u32, start: u32, end: u32) -> Schedule {
    Schedule {
        circuit_id: f.id(circuit),
        days,
        start_time: start,
        end_time: end,
        enabled: true,
    }
}

// Monday 2024-01-01 00:00:00 UTC == 1704067200. Jan 1 2024 is a Monday (day 1).
const MONDAY_MIDNIGHT: u64 = 1_704_067_200;
const MINUTE: u64 = 60;
const HOUR: u64 = 3_600;

#[test]
fn set_and_get_schedule_round_trips() {
    let f = Fixture::new();
    let (meter_id, _owner) = f.register("M1");
    let sched = schedule(&f, "C1", 0b0111110, 18 * 60, 22 * 60); // Mon-Fri 18:00-22:00

    f.client.set_circuit_schedule(&meter_id, &sched);
    let fetched = f.client.get_circuit_schedule(&meter_id, &f.id("C1"));
    assert_eq!(fetched, sched);
}

#[test]
fn only_owner_can_set_schedule() {
    let f = Fixture::new();
    let (meter_id, _owner) = f.register("M1");
    let sched = schedule(&f, "C1", 0x7F, 0, 60);

    // Drop blanket auth mocking so require_auth actually checks the signer.
    f.env.set_auths(&[]);
    assert!(f.client.try_set_circuit_schedule(&meter_id, &sched).is_err());
}

#[test]
fn unknown_meter_is_rejected() {
    let f = Fixture::new();
    let unknown = f.id("NOPE");
    let sched = schedule(&f, "C1", 0x7F, 0, 60);
    assert_eq!(
        f.client.try_set_circuit_schedule(&unknown, &sched).err(),
        Some(Ok(ContractError::MeterNotFound))
    );
}

#[test]
fn invalid_schedule_is_rejected() {
    let f = Fixture::new();
    let (meter_id, _owner) = f.register("M1");

    let bad_days = schedule(&f, "C1", 1 << 10, 0, 60);
    assert_eq!(
        f.client.try_set_circuit_schedule(&meter_id, &bad_days).err(),
        Some(Ok(ContractError::InvalidSchedule))
    );

    let bad_start = schedule(&f, "C1", 0x7F, 1_440, 60);
    assert_eq!(
        f.client.try_set_circuit_schedule(&meter_id, &bad_start).err(),
        Some(Ok(ContractError::InvalidSchedule))
    );
}

#[test]
fn due_schedule_actions_match_days_and_window() {
    let f = Fixture::new();
    let (meter_id, _owner) = f.register("M1");
    let circuit = f.id("C1");
    // Monday(1)-Friday(5) only, 18:00-22:00.
    let sched = schedule(&f, "C1", 0b0111110, 18 * 60, 22 * 60);
    f.client.set_circuit_schedule(&meter_id, &sched);

    // Monday 18:00 — inside window, scheduled day: ON.
    let on_time = MONDAY_MIDNIGHT + 18 * HOUR;
    assert!(f.client.circuit_should_be_on(&meter_id, &circuit, &on_time));

    // Monday 17:59 — just before window: OFF.
    let before = MONDAY_MIDNIGHT + 18 * HOUR - MINUTE;
    assert!(!f.client.circuit_should_be_on(&meter_id, &circuit, &before));

    // Monday 22:00 — window end is exclusive: OFF.
    let at_end = MONDAY_MIDNIGHT + 22 * HOUR;
    assert!(!f.client.circuit_should_be_on(&meter_id, &circuit, &at_end));

    // Saturday 18:00 (+5 days) — not a scheduled day: OFF.
    let saturday = MONDAY_MIDNIGHT + 5 * 24 * HOUR + 18 * HOUR;
    assert!(!f.client.circuit_should_be_on(&meter_id, &circuit, &saturday));
}

#[test]
fn overnight_window_spans_midnight() {
    let f = Fixture::new();
    let (meter_id, _owner) = f.register("M1");
    let circuit = f.id("C1");
    // Every day, 22:00 -> 06:00 (spans midnight).
    let sched = schedule(&f, "C1", 0x7F, 22 * 60, 6 * 60);
    f.client.set_circuit_schedule(&meter_id, &sched);

    // Monday 23:00 — after start, same day: ON.
    let late_monday = MONDAY_MIDNIGHT + 23 * HOUR;
    assert!(f.client.circuit_should_be_on(&meter_id, &circuit, &late_monday));

    // Tuesday 03:00 — before end, belongs to Monday's start: ON.
    let early_tuesday = MONDAY_MIDNIGHT + 24 * HOUR + 3 * HOUR;
    assert!(f.client.circuit_should_be_on(&meter_id, &circuit, &early_tuesday));

    // Tuesday 12:00 — well outside the overnight window: OFF.
    let midday_tuesday = MONDAY_MIDNIGHT + 24 * HOUR + 12 * HOUR;
    assert!(!f.client.circuit_should_be_on(&meter_id, &circuit, &midday_tuesday));
}

#[test]
fn disabled_schedule_never_fires() {
    let f = Fixture::new();
    let (meter_id, _owner) = f.register("M1");
    let circuit = f.id("C1");
    let mut sched = schedule(&f, "C1", 0x7F, 0, 23 * 60 + 59);
    sched.enabled = false;
    f.client.set_circuit_schedule(&meter_id, &sched);

    assert!(!f
        .client
        .circuit_should_be_on(&meter_id, &circuit, &(MONDAY_MIDNIGHT + HOUR)));
}

#[test]
fn override_supersedes_active_schedule() {
    let f = Fixture::new();
    let (meter_id, _owner) = f.register("M1");
    let circuit = f.id("C1");
    // Scheduled ON every day 18:00-22:00.
    let sched = schedule(&f, "C1", 0x7F, 18 * 60, 22 * 60);
    f.client.set_circuit_schedule(&meter_id, &sched);

    let now = MONDAY_MIDNIGHT + 19 * HOUR; // inside the ON window
    assert!(f.client.circuit_should_be_on(&meter_id, &circuit, &now));

    // Force OFF for the next hour despite the schedule saying ON.
    let until = now + HOUR;
    f.client.override_circuit(&meter_id, &circuit, &false, &until);
    assert!(!f.client.circuit_should_be_on(&meter_id, &circuit, &now));

    // Once the override window has elapsed, the schedule resumes.
    assert!(f.client.circuit_should_be_on(&meter_id, &circuit, &until));

    // Clearing the override early also lets the schedule resume immediately.
    f.client.override_circuit(&meter_id, &circuit, &false, &(now + 10 * HOUR));
    assert!(!f.client.circuit_should_be_on(&meter_id, &circuit, &now));
    f.client.clear_circuit_override(&meter_id, &circuit);
    assert!(f.client.circuit_should_be_on(&meter_id, &circuit, &now));
}

#[test]
fn override_rejects_non_future_window() {
    let f = Fixture::new();
    let (meter_id, _owner) = f.register("M1");
    let circuit = f.id("C1");
    f.set_time(MONDAY_MIDNIGHT);
    assert_eq!(
        f.client
            .try_override_circuit(&meter_id, &circuit, &true, &MONDAY_MIDNIGHT)
            .err(),
        Some(Ok(ContractError::InvalidOverrideWindow))
    );
}

#[test]
fn execute_scheduled_action_emits_event_only_on_transition() {
    let f = Fixture::new();
    let (meter_id, _owner) = f.register("M1");
    let circuit = f.id("C1");
    let sched = schedule(&f, "C1", 0x7F, 18 * 60, 22 * 60);
    f.client.set_circuit_schedule(&meter_id, &sched);

    let now = MONDAY_MIDNIGHT + 19 * HOUR; // desired = ON

    // last_state already ON -> no transition, no event.
    let desired = f.client.execute_scheduled_action(&meter_id, &circuit, &now, &true);
    assert!(desired);
    assert!(!emitted_sch_exec(&f, &meter_id));

    // last_state OFF -> transition to ON, event published.
    let desired = f.client.execute_scheduled_action(&meter_id, &circuit, &now, &false);
    assert!(desired);
    assert!(emitted_sch_exec(&f, &meter_id));
}

fn emitted_sch_exec(f: &Fixture, meter_id: &String) -> bool {
    let expected_topics: soroban_sdk::Vec<Val> =
        (symbol_short!("solar"), symbol_short!("sch_exec"), meter_id.clone()).into_val(&f.env);
    let events = f.env.events().all();
    events.events().iter().any(|e| {
        let soroban_sdk::xdr::ContractEventBody::V0(v0) = &e.body;
        let topics: soroban_sdk::Vec<Val> = soroban_sdk::Vec::from_iter(
            &f.env,
            v0.topics.iter().map(|t| Val::try_from_val(&f.env, t).unwrap()),
        );
        topics == expected_topics
    })
}

#[test]
fn get_circuit_schedule_errors_when_unset() {
    let f = Fixture::new();
    let (meter_id, _owner) = f.register("M1");
    let circuit = f.id("C1");
    assert_eq!(
        f.client.try_get_circuit_schedule(&meter_id, &circuit).err(),
        Some(Ok(ContractError::ScheduleNotFound))
    );
}
