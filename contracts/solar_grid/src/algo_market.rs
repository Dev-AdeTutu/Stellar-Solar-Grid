//! Energy trading algorithm marketplace (see contracts/ALGO_MARKETPLACE.md).

use soroban_sdk::{contracttype, Address, String};

/// Basis points of each subscription fee paid to the algorithm creator;
/// the remainder accrues to the platform (admin).
pub const CREATOR_SHARE_BPS: i128 = 9_000;

#[contracttype]
#[derive(Clone, Debug)]
pub struct Algorithm {
    pub id: u32,
    pub creator: Address,
    pub name: String,
    /// Subscription fee per period, in stroops.
    pub fee: i128,
    pub active: bool,
    pub subscribers: u32,
    pub trades: u32,
    /// Cumulative realised PnL reported by the executor, in stroops.
    pub total_pnl: i128,
    pub creator_earnings: i128,
}

#[contracttype]
pub enum AlgoKey {
    Count,
    Algo(u32),
    Sub(u32, Address),
}

/// Split a fee into (creator, platform) parts. Never loses or creates value.
pub fn split_fee(fee: i128) -> (i128, i128) {
    let creator = fee * CREATOR_SHARE_BPS / 10_000;
    (creator, fee - creator)
}
