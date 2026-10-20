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
    /// A commons rule proposal identified by its id.
    RuleProposal(u64),
    /// Monotonic counter for commons rule proposal ids.
    NextRuleProposalId,
    /// Voting weight recorded for (rule_proposal_id, voter).
    RuleVote(u64, Address),
    /// A monitoring report identified by its id.
    MonitoringReport(u64),
    /// Monotonic counter for monitoring report ids.
    NextMonitoringReportId,
    /// Graduated sanction state for a member.
    SanctionState(Address),
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

/// A commons rule proposal, allowing members to define or amend usage rules.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuleProposal {
    pub id: u64,
    pub proposer: Address,
    /// Identifier of the rule being proposed or amended.
    pub rule: Symbol,
    /// New rule value (e.g. a limit or threshold).
    pub new_value: i128,
    pub created_at: u64,
    pub voting_ends_at: u64,
    pub expires_at: u64,
    pub votes_for: i128,
    pub votes_against: i128,
    pub quorum: i128,
    pub executed: bool,
}

/// A monitoring report filed against a member for a rule violation.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MonitoringReport {
    pub id: u64,
    pub reporter: Address,
    pub subject: Address,
    /// The rule that was allegedly violated.
    pub rule: Symbol,
    /// Ledger timestamp when the report was filed.
    pub reported_at: u64,
    /// Whether the report has been upheld by governance.
    pub upheld: bool,
}

/// Graduated sanction state for a member.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SanctionState {
    pub member: Address,
    /// Number of upheld violations recorded against the member.
    pub violation_count: u32,
    /// Current escalation level (0 = none, increasing with repeat offences).
    pub level: u32,
    /// Ledger timestamp of the most recent sanction.
    pub last_sanction_at: u64,
}

/// Emitted when a commons rule proposal is created.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuleProposed {
    pub id: u64,
    pub proposer: Address,
    pub rule: Symbol,
    pub new_value: i128,
    pub voting_ends_at: u64,
}

/// Emitted when a monitoring report is filed.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MonitoringReportFiled {
    pub id: u64,
    pub reporter: Address,
    pub subject: Address,
    pub rule: Symbol,
}

/// Emitted when a sanction is escalated against a member.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SanctionEscalated {
    pub member: Address,
    pub violation_count: u32,
    pub level: u32,
}

/// Errors raised by the commons governance primitives.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum CommonsError {
    RuleProposalNotFound = 1,
    ReportNotFound = 2,
    VotingStillOpen = 3,
    VotingClosed = 4,
    ProposalExpired = 5,
    QuorumNotMet = 6,
    AlreadyExecuted = 7,
    AlreadyVoted = 8,
    NoVotingWeight = 9,
    InvalidPeriod = 10,
    AlreadyUpheld = 11,
    SelfReport = 12,
}

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

/// Cast a vote on an open proposal.
///
/// `weight` is the caller's voting power, derived from stake or meter
/// ownership by the caller (or an oracle). It must be positive.
pub fn vote_on_proposal(
    env: &Env,
    voter: Address,
    id: u64,
    support: bool,
    weight: i128,
) -> Result<(), GovError> {
    voter.require_auth();

    if weight <= 0 {
        return Err(GovError::NoVotingWeight);
    }

    let mut proposal = load_proposal(env, id)?;
    let now = env.ledger().timestamp();

    if now >= proposal.voting_ends_at {
        return Err(GovError::VotingClosed);
    }
    if now >= proposal.expires_at {
        return Err(GovError::ProposalExpired);
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

fn next_rule_id(env: &Env) -> u64 {
    let key = GovKey::NextRuleProposalId;
    let id: u64 = env.storage().instance().get(&key).unwrap_or(0);
    env.storage().instance().set(&key, &(id + 1));
    id
}

fn load_rule_proposal(env: &Env, id: u64) -> Result<RuleProposal, CommonsError> {
    env.storage()
        .persistent()
        .get(&GovKey::RuleProposal(id))
        .ok_or(CommonsError::RuleProposalNotFound)
}

fn save_rule_proposal(env: &Env, proposal: &RuleProposal) {
    env.storage()
        .persistent()
        .set(&GovKey::RuleProposal(proposal.id), proposal);
}

/// Propose a member-defined commons usage rule.
///
/// `voting_period` and `expiry` are in seconds; pass `0` to use defaults.
pub fn propose_rule(
    env: &Env,
    proposer: Address,
    rule: Symbol,
    new_value: i128,
    quorum: i128,
    voting_period: u64,
    expiry: u64,
) -> Result<u64, CommonsError> {
    proposer.require_auth();

    let voting_period = if voting_period == 0 {
        DEFAULT_VOTING_PERIOD
    } else {
        voting_period
    };
    let expiry = if expiry == 0 { DEFAULT_EXPIRY } else { expiry };
    if expiry <= voting_period {
        return Err(CommonsError::InvalidPeriod);
    }

    let now = env.ledger().timestamp();
    let id = next_rule_id(env);
    let proposal = RuleProposal {
        id,
        proposer: proposer.clone(),
        rule: rule.clone(),
        new_value,
        created_at: now,
        voting_ends_at: now + voting_period,
        expires_at: now + expiry,
        votes_for: 0,
        votes_against: 0,
        quorum,
        executed: false,
    };
    save_rule_proposal(env, &proposal);

    env.events().publish(
        (symbol_short!("RuleProp"), id),
        RuleProposed {
            id,
            proposer,
            rule,
            new_value,
            voting_ends_at: proposal.voting_ends_at,
        },
    );

    Ok(id)
}

/// Cast a vote on an open commons rule proposal.
pub fn vote_on_rule(
    env: &Env,
    voter: Address,
    id: u64,
    support: bool,
    weight: i128,
) -> Result<(), CommonsError> {
    voter.require_auth();

    if weight <= 0 {
        return Err(CommonsError::NoVotingWeight);
    }

    let mut proposal = load_rule_proposal(env, id)?;
    let now = env.ledger().timestamp();

    if now >= proposal.voting_ends_at {
        return Err(CommonsError::VotingClosed);
    }
    if now >= proposal.expires_at {
        return Err(CommonsError::ProposalExpired);
    }

    let vote_key = GovKey::RuleVote(id, voter.clone());
    if env.storage().persistent().has(&vote_key) {
        return Err(CommonsError::AlreadyVoted);
    }
    env.storage().persistent().set(&vote_key, &weight);

    if support {
        proposal.votes_for += weight;
    } else {
        proposal.votes_against += weight;
    }
    save_rule_proposal(env, &proposal);

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

/// Execute a commons rule proposal once voting has closed and quorum met.
pub fn execute_rule(env: &Env, id: u64) -> Result<(), CommonsError> {
    let mut proposal = load_rule_proposal(env, id)?;
    let now = env.ledger().timestamp();

    if proposal.executed {
        return Err(CommonsError::AlreadyExecuted);
    }
    if now < proposal.voting_ends_at {
        return Err(CommonsError::VotingStillOpen);
    }
    if now >= proposal.expires_at {
        return Err(CommonsError::ProposalExpired);
    }

    let total = proposal.votes_for + proposal.votes_against;
    if total < proposal.quorum || proposal.votes_for <= proposal.votes_against {
        return Err(CommonsError::QuorumNotMet);
    }

    env.storage()
        .instance()
        .set(&GovKey::Param(proposal.rule.clone()), &proposal.new_value);
    proposal.executed = true;
    save_rule_proposal(env, &proposal);

    env.events().publish(
        (symbol_short!("ProposalExecuted"), id),
        ProposalExecuted {
            id,
            param: proposal.rule,
            new_value: proposal.new_value,
        },
    );

    Ok(())
}

/// Read a commons rule proposal by id.
pub fn get_rule_proposal(env: &Env, id: u64) -> Result<RuleProposal, CommonsError> {
    load_rule_proposal(env, id)
}

/// File a monitoring report against a member for a rule violation.
pub fn file_monitoring_report(
    env: &Env,
    reporter: Address,
    subject: Address,
    rule: Symbol,
) -> Result<u64, CommonsError> {
    reporter.require_auth();

    if reporter == subject {
        return Err(CommonsError::SelfReport);
    }

    let key = GovKey::NextMonitoringReportId;
    let id: u64 = env.storage().instance().get(&key).unwrap_or(0);
    env.storage().instance().set(&key, &(id + 1));

    let report = MonitoringReport {
        id,
        reporter: reporter.clone(),
        subject: subject.clone(),
        rule: rule.clone(),
        reported_at: env.ledger().timestamp(),
        upheld: false,
    };
    env.storage()
        .persistent()
        .set(&GovKey::MonitoringReport(id), &report);

    env.events().publish(
        (symbol_short!("ReportFiled"), id),
        MonitoringReportFiled {
            id,
            reporter,
            subject,
            rule,
        },
    );

    Ok(id)
}

/// Read a monitoring report by id.
pub fn get_monitoring_report(env: &Env, id: u64) -> Result<MonitoringReport, CommonsError> {
    env.storage()
        .persistent()
        .get(&GovKey::MonitoringReport(id))
        .ok_or(CommonsError::ReportNotFound)
}

/// Read the current graduated sanction state for a member, if any.
pub fn get_sanction_state(env: &Env, member: Address) -> Option<SanctionState> {
    env.storage()
        .persistent()
        .get(&GovKey::SanctionState(member))
}

/// Uphold a monitoring report and escalate the graduated sanction level for
/// the subject. Repeated upheld violations increase the escalation level.
pub fn uphold_report(env: &Env, id: u64) -> Result<SanctionState, CommonsError> {
    let mut report = get_monitoring_report(env, id)?;
    if report.upheld {
        return Err(CommonsError::AlreadyUpheld);
    }
    report.upheld = true;
    env.storage()
        .persistent()
        .set(&GovKey::MonitoringReport(id), &report);

    let key = GovKey::SanctionState(report.subject.clone());
    let mut state: SanctionState = env
        .storage()
        .persistent()
        .get(&key)
        .unwrap_or(SanctionState {
            member: report.subject.clone(),
            violation_count: 0,
            level: 0,
            last_sanction_at: 0,
        });

    state.violation_count += 1;
    // Graduated escalation: level grows with each repeat offence.
    state.level = state.violation_count;
    state.last_sanction_at = env.ledger().timestamp();
    env.storage().persistent().set(&key, &state);

    env.events().publish(
        (symbol_short!("Sanction"), report.subject.clone()),
        SanctionEscalated {
            member: report.subject,
            violation_count: state.violation_count,
            level: state.level,
        },
    );

    Ok(state)
}
