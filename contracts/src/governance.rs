//! Contract parameter governance.
//!
//! Allows any user to propose changes to contract parameters, with voting
//! weighted by stake / meter ownership. Proposals must reach quorum before
//! they can be executed, and can only be executed after the voting period
//! has ended and before they expire.

use soroban_sdk::{contracterror, contracttype, symbol_short, Address, Env, Map, Symbol, Vec};

/// Storage keys used by the governance module.
#[contracttype]
#[derive(Clone)]
pub enum GovKey {
    /// Current value of a named parameter.
    Param(Symbol),
    /// A proposal identified by its id.
    Proposal(u64),
    /// Monotonic counter for proposal ids.
    NextProposalId,
    /// Voting weight recorded for (proposal_id, voter).
    Vote(u64, Address),
    /// Meter whose ownership shares govern a proposal (proposal_id -> meter_id).
    ProposalMeter(u64),
    /// Ownership share in basis points for (meter_id, owner).
    OwnershipShare(u64, Address),
}

/// A parameter change proposal.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Proposal {
    pub id: u64,
    pub proposer: Address,
    pub param: Symbol,
    pub new_value: i128,
    /// Ledger timestamp when the proposal was created.
    pub created_at: u64,
    /// Ledger timestamp when voting closes.
    pub voting_ends_at: u64,
    /// Ledger timestamp after which the proposal can no longer be executed.
    pub expires_at: u64,
    /// Total voting weight cast in favour of the proposal.
    pub votes_for: i128,
    /// Total voting weight cast against the proposal.
    pub votes_against: i128,
    /// Minimum total weight required for the proposal to be valid.
    pub quorum: i128,
    pub executed: bool,
    /// Meter whose co-owners vote on this proposal, if any. When set, voting
    /// weight is derived from ownership share rather than caller-supplied stake.
    pub meter_id: Option<u64>,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum GovError {
    ProposalNotFound = 1,
    VotingStillOpen = 2,
    VotingClosed = 3,
    ProposalExpired = 4,
    QuorumNotMet = 5,
    AlreadyExecuted = 6,
    AlreadyVoted = 7,
    NoVotingWeight = 8,
    InvalidPeriod = 9,
    NotMeterOwner = 10,
}

/// Emitted when a new proposal is created.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProposalCreated {
    pub id: u64,
    pub proposer: Address,
    pub param: Symbol,
    pub new_value: i128,
    pub voting_ends_at: u64,
    pub expires_at: u64,
}

/// Emitted when a vote is cast on a proposal.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VoteCast {
    pub id: u64,
    pub voter: Address,
    pub weight: i128,
    pub support: bool,
}

/// Emitted when a proposal is executed.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProposalExecuted {
    pub id: u64,
    pub param: Symbol,
    pub new_value: i128,
}

/// Default voting period in seconds (3 days).
const DEFAULT_VOTING_PERIOD: u64 = 3 * 24 * 60 * 60;
/// Default proposal expiry in seconds after creation (7 days).
const DEFAULT_EXPIRY: u64 = 7 * 24 * 60 * 60;

fn next_id(env: &Env) -> u64 {
    let key = GovKey::NextProposalId;
    let id: u64 = env.storage().instance().get(&key).unwrap_or(0);
    env.storage().instance().set(&key, &(id + 1));
    id
}

fn load_proposal(env: &Env, id: u64) -> Result<Proposal, GovError> {
    env.storage()
        .persistent()
        .get(&GovKey::Proposal(id))
        .ok_or(GovError::ProposalNotFound)
}

fn save_proposal(env: &Env, proposal: &Proposal) {
    env.storage()
        .persistent()
        .set(&GovKey::Proposal(proposal.id), proposal);
}

/// Returns the current value of a parameter, or `None` if unset.
pub fn get_parameter(env: &Env, param: Symbol) -> Option<i128> {
    env.storage().instance().get(&GovKey::Param(param))
}

/// Create a parameter change proposal. Any user may propose.
///
/// `voting_period` and `expiry` are in seconds; pass `0` to use defaults.
/// `quorum` is the minimum total voting weight required for the proposal to
/// be executable.
pub fn propose_parameter_change(
    env: &Env,
    proposer: Address,
    param: Symbol,
    new_value: i128,
    quorum: i128,
    voting_period: u64,
    expiry: u64,
) -> Result<u64, GovError> {
    proposer.require_auth();

    let voting_period = if voting_period == 0 {
        DEFAULT_VOTING_PERIOD
    } else {
        voting_period
    };
    let expiry = if expiry == 0 { DEFAULT_EXPIRY } else { expiry };
    if expiry <= voting_period {
        return Err(GovError::InvalidPeriod);
    }

    let now = env.ledger().timestamp();
    let id = next_id(env);
    let proposal = Proposal {
        id,
        proposer: proposer.clone(),
        param: param.clone(),
        new_value,
        created_at: now,
        voting_ends_at: now + voting_period,
        expires_at: now + expiry,
        votes_for: 0,
        votes_against: 0,
        quorum,
        executed: false,
        meter_id: None,
    };
    save_proposal(env, &proposal);

    env.events().publish(
        (symbol_short!("ProposalCreated"), id),
        ProposalCreated {
            id,
            proposer,
            param,
            new_value,
            voting_ends_at: proposal.voting_ends_at,
            expires_at: proposal.expires_at,
        },
    );

    Ok(id)
}

/// Create a parameter change proposal whose voting weight is derived from
/// co-ownership shares of `meter_id`.
///
/// Only addresses holding a non-zero ownership share of the meter may vote.
/// Each voter's weight equals their ownership share in basis points.
pub fn propose_meter_parameter_change(
    env: &Env,
    proposer: Address,
    meter_id: u64,
    param: Symbol,
    new_value: i128,
    quorum: i128,
    voting_period: u64,
    expiry: u64,
) -> Result<u64, GovError> {
    let id = propose_parameter_change(
        env,
        proposer,
        param,
        new_value,
        quorum,
        voting_period,
        expiry,
    )?;

    env.storage()
        .persistent()
        .set(&GovKey::ProposalMeter(id), &meter_id);

    let mut proposal = load_proposal(env, id)?;
    proposal.meter_id = Some(meter_id);
    save_proposal(env, &proposal);

    Ok(id)
}

/// Record an ownership share (in basis points) for `owner` on `meter_id`.
///
/// This is the source of truth used to derive voting weight for meter
/// proposals. Callers are responsible for ensuring shares sum to 10_000.
pub fn set_ownership_share(env: &Env, meter_id: u64, owner: Address, share_bps: i128) {
    env.storage()
        .persistent()
        .set(&GovKey::OwnershipShare(meter_id, owner), &share_bps);
}

/// Returns the ownership share in basis points for `owner` on `meter_id`,
/// or `0` if the address is not a co-owner.
pub fn get_ownership_share(env: &Env, meter_id: u64, owner: Address) -> i128 {
    env.storage()
        .persistent()
        .get(&GovKey::OwnershipShare(meter_id, owner))
        .unwrap_or(0)
}

/// Returns the voting weight for `voter` on proposal `id`.
///
/// For meter proposals the weight is the voter's ownership share in basis
/// points; for all other proposals the caller-supplied `stake_weight` is
/// returned unchanged.
pub fn voting_weight_for(
    env: &Env,
    id: u64,
    voter: Address,
    stake_weight: i128,
) -> Result<i128, GovError> {
    let proposal = load_proposal(env, id)?;
    match proposal.meter_id {
        Some(meter_id) => {
            let share = get_ownership_share(env, meter_id, voter);
            if share <= 0 {
                return Err(GovError::NotMeterOwner);
            }
            Ok(share)
        }
        None => Ok(stake_weight),
    }
}

/// Cast a vote on an open proposal.
///
/// For meter proposals `weight` is ignored and the voter's ownership share is
/// used instead. For all other proposals `weight` is the caller's voting
/// power, derived from stake by the caller (or an oracle). It must be
/// positive.
pub fn vote_on_proposal(
    env: &Env,
    voter: Address,
    id: u64,
    support: bool,
    weight: i128,
) -> Result<(), GovError> {
    voter.require_auth();

    let mut proposal = load_proposal(env, id)?;
    let now = env.ledger().timestamp();

    if now >= proposal.voting_ends_at {
        return Err(GovError::VotingClosed);
    }
    if now >= proposal.expires_at {
        return Err(GovError::ProposalExpired);
    }

    let weight = voting_weight_for(env, id, voter.clone(), weight)?;
    if weight <= 0 {
        return Err(GovError::NoVotingWeight);
    }

    let vote_key = GovKey::Vote(id, voter.clone());
    if env.storage().persistent().has(&vote_key) {
        return Err(GovError::AlreadyVoted);
    }
    env.storage().persistent().set(&vote_key, &weight);

    if support {
        proposal.votes_for += weight;
    } else {
        proposal.votes_against += weight;
    }
    save_proposal(env, &proposal);

    env.events().publish(
        (symbol_short!("VoteCast"), id),
        VoteCast {
            id,
            voter,
            weight,
            support,
        },
    );

    Ok(())
}

/// Execute a proposal after the voting period has ended.
///
/// Requires quorum to be met, more votes for than against, and the proposal
/// to not have expired.
pub fn execute_proposal(env: &Env, id: u64) -> Result<(), GovError> {
    let mut proposal = load_proposal(env, id)?;
    let now = env.ledger().timestamp();

    if proposal.executed {
        return Err(GovError::AlreadyExecuted);
    }
    if now < proposal.voting_ends_at {
        return Err(GovError::VotingStillOpen);
    }
    if now >= proposal.expires_at {
        return Err(GovError::ProposalExpired);
    }

    let total = proposal.votes_for + proposal.votes_against;
    if total < proposal.quorum || proposal.votes_for <= proposal.votes_against {
        return Err(GovError::QuorumNotMet);
    }

    env.storage()
        .instance()
        .set(&GovKey::Param(proposal.param.clone()), &proposal.new_value);
    proposal.executed = true;
    save_proposal(env, &proposal);

    env.events().publish(
        (symbol_short!("ProposalExecuted"), id),
        ProposalExecuted {
            id,
            param: proposal.param,
            new_value: proposal.new_value,
        },
    );

    Ok(())
}

/// Read a proposal by id.
pub fn get_proposal(env: &Env, id: u64) -> Result<Proposal, GovError> {
    load_proposal(env, id)
}

/// Read the recorded vote weight for a voter on a proposal.
pub fn get_vote(env: &Env, id: u64, voter: Address) -> Option<i128> {
    env.storage().persistent().get(&GovKey::Vote(id, voter))
}

/// Convenience helper returning all proposals as a map of id -> proposal.
pub fn list_proposals(env: &Env) -> Map<u64, Proposal> {
    let mut out: Map<u64, Proposal> = Map::new(env);
    let count: u64 = env
        .storage()
        .instance()
        .get(&GovKey::NextProposalId)
        .unwrap_or(0);
    let mut i: u64 = 0;
    while i < count {
        if let Some(p) = env.storage().persistent().get(&GovKey::Proposal(i)) {
            out.set(i, p);
        }
        i += 1;
    }
    out
}

/// Helper used by tests and callers to build a list of voter weights.
pub fn total_weight(weights: &Vec<i128>) -> i128 {
    let mut sum: i128 = 0;
    for w in weights.iter() {
        sum += w;
    }
    sum
}
