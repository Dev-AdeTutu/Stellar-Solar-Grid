//! Multi-signature admin transaction batching (see contracts/BATCHING.md).

use soroban_sdk::{contracttype, Address, String};

/// A single admin operation that can be bundled into a batch.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum AdminAction {
    SetActive(String, bool),
    SetDailyLimit(String, i128),
    AllowlistAdd(Address),
    AllowlistRemove(Address),
    SetOracle(Address),
}

/// Upper bound on actions per batch, keeps the tx within Soroban resource limits.
pub const MAX_BATCH_ACTIONS: u32 = 25;
