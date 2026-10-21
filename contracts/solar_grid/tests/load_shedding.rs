mod common;

use common::TestSetup;
use solar_grid::{CircuitLoad, ContractError};
use soroban_sdk::{String, Vec};

#[test]
fn test_set_and_get_circuit_priorities() {
    let s = TestSetup::new();
    let owner = s.allowlisted_user();
    let meter = s.register_meter(&owner, "MTR-SHED-1");

    let mut circuits = Vec::new(&s.env);
    circuits.push_back(CircuitLoad {
        circuit_id: 1,
        name: String::from_str(&s.env, "Refrigerator"),
        priority: 1, // Essential
        is_shed: false,
    });
    circuits.push_back(CircuitLoad {
        circuit_id: 2,
        name: String::from_str(&s.env, "Lighting"),
        priority: 2, // High
        is_shed: false,
    });
    circuits.push_back(CircuitLoad {
        circuit_id: 3,
        name: String::from_str(&s.env, "Water Heater"),
        priority: 4, // Low
        is_shed: false,
    });

    s.client.set_load_priorities(&meter, &circuits);

    let fetched = s.client.get_load_priorities(&meter);
    assert_eq!(fetched.len(), 3);
    assert_eq!(fetched.get(0).unwrap().circuit_id, 1);
    assert_eq!(fetched.get(1).unwrap().circuit_id, 2);
    assert_eq!(fetched.get(2).unwrap().circuit_id, 3);
}

#[test]
fn test_auto_load_shedding_under_threshold() {
    let s = TestSetup::new();
    let owner = s.allowlisted_user();
    let meter = s.register_meter(&owner, "MTR-SHED-2");

    let mut circuits = Vec::new(&s.env);
    circuits.push_back(CircuitLoad {
        circuit_id: 1,
        name: String::from_str(&s.env, "Medical Eq"),
        priority: 1, // Essential - never shed
        is_shed: false,
    });
    circuits.push_back(CircuitLoad {
        circuit_id: 2,
        name: String::from_str(&s.env, "HVAC"),
        priority: 3, // Medium
        is_shed: false,
    });
    circuits.push_back(CircuitLoad {
        circuit_id: 3,
        name: String::from_str(&s.env, "EV Charger"),
        priority: 4, // Low
        is_shed: false,
    });
    s.client.set_load_priorities(&meter, &circuits);

    // Balance (100) < threshold (500) -> shed non-essential circuits (priority > 1)
    let evaluated = s.client.evaluate_load_shedding(&meter, &100, &500);
    assert_eq!(evaluated.len(), 3);
    assert_eq!(evaluated.get(0).unwrap().is_shed, false); // Essential preserved
    assert_eq!(evaluated.get(1).unwrap().is_shed, true);  // HVAC shed
    assert_eq!(evaluated.get(2).unwrap().is_shed, true);  // EV Charger shed

    // Balance restored (1000) >= threshold (500) -> restore all circuits
    let restored = s.client.evaluate_load_shedding(&meter, &1000, &500);
    assert_eq!(restored.get(0).unwrap().is_shed, false);
    assert_eq!(restored.get(1).unwrap().is_shed, false);
    assert_eq!(restored.get(2).unwrap().is_shed, false);
}

#[test]
fn test_manual_circuit_control() {
    let s = TestSetup::new();
    let owner = s.allowlisted_user();
    let meter = s.register_meter(&owner, "MTR-SHED-3");

    let mut circuits = Vec::new(&s.env);
    circuits.push_back(CircuitLoad {
        circuit_id: 10,
        name: String::from_str(&s.env, "Pool Pump"),
        priority: 4,
        is_shed: false,
    });
    s.client.set_load_priorities(&meter, &circuits);

    // Toggle shed ON
    let toggled = s.client.set_circuit_state(&meter, &10, &true);
    assert_eq!(toggled.is_shed, true);

    // Toggle shed OFF
    let restored = s.client.set_circuit_state(&meter, &10, &false);
    assert_eq!(restored.is_shed, false);

    // Non-existent circuit returns error
    let err = s.client.try_set_circuit_state(&meter, &99, &true).unwrap_err().unwrap();
    assert_eq!(err, ContractError::ScheduleNotFound);
}
