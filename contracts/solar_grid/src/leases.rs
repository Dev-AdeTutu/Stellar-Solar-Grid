//! Meter rental and lease-to-own agreements (#1020).
use crate::{ContractError, SolarGridContract, SolarGridContractArgs, SolarGridContractClient};
use soroban_sdk::{contractimpl, contracttype, symbol_short, Address, Env, String, Symbol};
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LeaseStatus { Active, Completed, BoughtOut }
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LeaseAgreement {
    pub lease_id: u32,
    pub meter_id: String,
    pub owner: Address,
    pub lessee: Address,
    pub monthly_payment: i128,
    pub payments_made: u32,
    pub total_payments: u32,
    pub buyout_amount: i128,
    pub status: LeaseStatus,
    pub started_at: u64,
    pub completed_at: u64,
}
#[contracttype]
enum LeaseKey { Count, Agreement(u32) }
fn load(env: &Env, id: u32) -> Result<LeaseAgreement, ContractError> { env.storage().persistent().get(&LeaseKey::Agreement(id)).ok_or(ContractError::LeaseNotFound) }
#[contractimpl]
impl SolarGridContract {
    /// Start a lease. The current meter owner authorizes the agreement.
    pub fn start_lease(env: Env, meter_id: String, owner: Address, lessee: Address, monthly_payment: i128, total_payments: u32, buyout_amount: i128) -> Result<u32, ContractError> {
        owner.require_auth();
        if meter_id.is_empty() || monthly_payment <= 0 || total_payments == 0 || total_payments > 120 || buyout_amount <= 0 { return Err(ContractError::InvalidConfiguration); }
        let id: u32 = env.storage().instance().get(&LeaseKey::Count).unwrap_or(0) + 1;
        let agreement = LeaseAgreement { lease_id: id, meter_id, owner: owner.clone(), lessee, monthly_payment, payments_made: 0, total_payments, buyout_amount, status: LeaseStatus::Active, started_at: env.ledger().timestamp(), completed_at: 0 };
        env.storage().persistent().set(&LeaseKey::Agreement(id), &agreement); env.storage().instance().set(&LeaseKey::Count, &id);
        env.events().publish((symbol_short!("solar"), symbol_short!("lease_new"), id), (owner, agreement.monthly_payment, agreement.total_payments)); Ok(id)
    }
    /// Record a monthly payment. The lessee authorizes the payment and ownership completes at the final instalment.
    pub fn make_lease_payment(env: Env, lease_id: u32, lessee: Address, amount: i128) -> Result<LeaseAgreement, ContractError> {
        lessee.require_auth(); let mut agreement = load(&env, lease_id)?;
        if agreement.status != LeaseStatus::Active || agreement.lessee != lessee || amount < agreement.monthly_payment { return Err(ContractError::InvalidAmount); }
        agreement.payments_made += 1; env.events().publish((symbol_short!("solar"), symbol_short!("lease_pmt"), lease_id), (lessee.clone(), amount, agreement.payments_made));
        if agreement.payments_made >= agreement.total_payments { let previous_owner = agreement.owner.clone(); agreement.status = LeaseStatus::Completed; agreement.completed_at = env.ledger().timestamp(); agreement.owner = agreement.lessee.clone(); env.events().publish((symbol_short!("solar"), Symbol::new(&env, "lease_done"), lease_id), (previous_owner, agreement.owner.clone(), agreement.meter_id.clone())); }
        env.storage().persistent().set(&LeaseKey::Agreement(lease_id), &agreement); Ok(agreement)
    }
    /// Complete a lease early at the agreed buyout amount.
    pub fn buyout_lease(env: Env, lease_id: u32, lessee: Address, amount: i128) -> Result<LeaseAgreement, ContractError> {
        lessee.require_auth(); let mut agreement = load(&env, lease_id)?;
        if agreement.status != LeaseStatus::Active || agreement.lessee != lessee || amount < agreement.buyout_amount { return Err(ContractError::InvalidAmount); }
        let previous_owner = agreement.owner.clone(); agreement.status = LeaseStatus::BoughtOut; agreement.completed_at = env.ledger().timestamp(); agreement.owner = agreement.lessee.clone(); env.storage().persistent().set(&LeaseKey::Agreement(lease_id), &agreement); env.events().publish((symbol_short!("solar"), Symbol::new(&env, "lease_done"), lease_id), (previous_owner, agreement.owner.clone(), agreement.meter_id.clone())); Ok(agreement)
    }
    pub fn get_lease(env: Env, lease_id: u32) -> Result<LeaseAgreement, ContractError> { load(&env, lease_id) }
}
