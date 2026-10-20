//! Priority-based load shedding for multi-circuit smart meters (Issue #977).
//!
//! Smart meters can control multiple independent sub-circuits categorized by priority:
//! - Priority 1 (Essential): Refrigerator, medical equipment, security. Never automatically shed.
//! - Priority 2 (High): Lighting, essential electronics.
//! - Priority 3 (Medium): Washing machine, dishwashers.
//! - Priority 4 (Low): EV charging, pool pumps, water heaters.
//!
//! When a meter's balance falls below a configured threshold, low-priority circuits are
//! automatically shed. When balance is restored (e.g. after payment), shed circuits are restored.

use crate::{ContractError, SolarGridContract, SolarGridContractArgs, SolarGridContractClient, EVT_NS};
use soroban_sdk::{contractimpl, contracttype, Env, String, Symbol, Vec};

#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum CircuitPriority {
    Essential = 1,
    High = 2,
    Medium = 3,
    Low = 4,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CircuitLoad {
    pub circuit_id: u32,
    pub name: String,
    pub priority: u32, // 1 = Essential, 2 = High, 3 = Medium, 4 = Low
    pub is_shed: bool,
}

#[contracttype]
#[derive(Clone)]
pub enum LoadSheddingKey {
    Circuits(String),
}

#[contractimpl]
impl SolarGridContract {
    /// Configure priority settings for multiple circuits on a meter.
    /// Only the meter owner can configure priorities.
    pub fn set_load_priorities(
        env: Env,
        meter_id: String,
        circuits: Vec<CircuitLoad>,
    ) -> Result<(), ContractError> {
        let meter = Self::get_meter(env.clone(), meter_id.clone())?;
        meter.owner.require_auth();
        Self::require_not_paused(&env)?;

        for i in 0..circuits.len() {
            let c = circuits.get(i).unwrap();
            if c.priority == 0 || c.priority > 4 {
                return Err(ContractError::InvalidCircuitPriority);
            }
        }

        env.storage()
            .persistent()
            .set(&LoadSheddingKey::Circuits(meter_id), &circuits);
        Ok(())
    }

    /// Retrieve the circuit priority configuration for a meter.
    pub fn get_load_priorities(env: Env, meter_id: String) -> Vec<CircuitLoad> {
        env.storage()
            .persistent()
            .get(&LoadSheddingKey::Circuits(meter_id))
            .unwrap_or_else(|| Vec::new(&env))
    }

    /// Evaluates circuit state based on current balance and threshold.
    /// Sheds low-priority loads (priorities 2, 3, 4) if balance < threshold.
    /// Restores shed loads if balance >= threshold.
    /// Emits `LoadShed` and `LoadRestored` events.
    pub fn evaluate_load_shedding(
        env: Env,
        meter_id: String,
        current_balance: i128,
        threshold: i128,
    ) -> Result<Vec<CircuitLoad>, ContractError> {
        Self::require_not_paused(&env)?;
        let circuits = Self::get_load_priorities(env.clone(), meter_id.clone());
        if circuits.is_empty() {
            return Ok(circuits);
        }

        let mut updated = Vec::new(&env);

        if current_balance < threshold {
            // Under threshold: shed non-essential circuits (priority > 1)
            for i in 0..circuits.len() {
                let mut circuit = circuits.get(i).unwrap();
                if circuit.priority > 1 && !circuit.is_shed {
                    circuit.is_shed = true;
                    env.events().publish(
                        (EVT_NS, Symbol::new(&env, "load_shed"), meter_id.clone()),
                        circuit.circuit_id,
                    );
                }
                updated.push_back(circuit);
            }
        } else {
            // Normal operation: restore all shed circuits
            for i in 0..circuits.len() {
                let mut circuit = circuits.get(i).unwrap();
                if circuit.is_shed {
                    circuit.is_shed = false;
                    env.events().publish(
                        (EVT_NS, Symbol::new(&env, "load_restored"), meter_id.clone()),
                        circuit.circuit_id,
                    );
                }
                updated.push_back(circuit);
            }
        }

        env.storage()
            .persistent()
            .set(&LoadSheddingKey::Circuits(meter_id), &updated);
        Ok(updated)
    }

    /// Manually or remotely toggle a single circuit (e.g. via IoT MQTT command).
    /// Emits `LoadShed` or `LoadRestored`.
    pub fn set_circuit_state(
        env: Env,
        meter_id: String,
        circuit_id: u32,
        is_shed: bool,
    ) -> Result<CircuitLoad, ContractError> {
        let meter = Self::get_meter(env.clone(), meter_id.clone())?;
        meter.owner.require_auth();
        Self::require_not_paused(&env)?;

        let circuits = Self::get_load_priorities(env.clone(), meter_id.clone());
        let mut updated = Vec::new(&env);
        let mut target_circuit: Option<CircuitLoad> = None;

        for i in 0..circuits.len() {
            let mut c = circuits.get(i).unwrap();
            if c.circuit_id == circuit_id {
                c.is_shed = is_shed;
                target_circuit = Some(c.clone());
                if is_shed {
                    env.events().publish(
                        (EVT_NS, Symbol::new(&env, "load_shed"), meter_id.clone()),
                        circuit_id,
                    );
                } else {
                    env.events().publish(
                        (EVT_NS, Symbol::new(&env, "load_restored"), meter_id.clone()),
                        circuit_id,
                    );
                }
            }
            updated.push_back(c);
        }

        if let Some(target) = target_circuit {
            env.storage()
                .persistent()
                .set(&LoadSheddingKey::Circuits(meter_id), &updated);
            Ok(target)
        } else {
            Err(ContractError::ScheduleNotFound)
        }
    }
}
