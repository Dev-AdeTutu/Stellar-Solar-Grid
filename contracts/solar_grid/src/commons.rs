//! # Energy Commons Management
//!
//! Implements Ostrom's commons governance principles for shared community
//! energy resources. Provides resource boundary definition, member-defined
//! usage rules with voting, usage monitoring, graduated sanctions for repeat
//! offenders, and conflict resolution via arbitration.

use soroban_sdk::{contracttype, Address, Env, Map, String, Vec};

/// Boundary definition for a shared energy resource.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResourceBoundary {
    /// Unique identifier for the resource.
    pub resource_id: u64,
    /// Human-readable name of the resource.
    pub name: String,
    /// Total capacity in watt-hours available to the commons.
    pub capacity_wh: i128,
    /// Maximum draw per member per period in watt-hours.
    pub max_draw_per_member_wh: i128,
    /// Whether the resource is currently active.
    pub active: bool,
}

/// A member-defined usage rule proposal.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuleProposal {
    /// Unique proposal identifier.
    pub proposal_id: u64,
    /// Member who proposed the rule.
    pub proposer: Address,
    /// Description of the proposed rule.
    pub description: String,
    /// Votes in favor.
    pub votes_for: u32,
    /// Votes against.
    pub votes_against: u32,
    /// Whether the proposal has been finalized.
    pub finalized: bool,
    /// Whether the proposal passed.
    pub passed: bool,
}

/// A record of a member's energy usage for monitoring.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UsageRecord {
    /// Member whose usage is recorded.
    pub member: Address,
    /// Resource used.
    pub resource_id: u64,
    /// Amount drawn in watt-hours.
    pub amount_wh: i128,
    /// Ledger timestamp of the record.
    pub timestamp: u64,
}

/// Graduated sanction levels for repeat offenders.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SanctionLevel {
    /// No sanction.
    None = 0,
    /// First-level warning.
    Warning = 1,
    /// Usage restriction.
    Restriction = 2,
    /// Expulsion from the commons.
    Expulsion = 3,
}

/// A sanction applied to a member.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Sanction {
    /// Member sanctioned.
    pub member: Address,
    /// Current sanction level.
    pub level: SanctionLevel,
    /// Number of violations recorded.
    pub violation_count: u32,
    /// Reason for the sanction.
    pub reason: String,
}

/// A conflict resolution case resolved via arbitration.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConflictCase {
    /// Unique case identifier.
    pub case_id: u64,
    /// Member who raised the conflict.
    pub complainant: Address,
    /// Member being complained about.
    pub respondent: Address,
    /// Description of the conflict.
    pub description: String,
    /// Votes in favor of the complainant.
    pub votes_for_complainant: u32,
    /// Votes in favor of the respondent.
    pub votes_for_respondent: u32,
    /// Whether the case has been resolved.
    pub resolved: bool,
    /// Whether the complainant prevailed.
    pub complainant_won: bool,
}

/// Storage keys for the commons module.
#[contracttype]
pub enum CommonsKey {
    /// Resource boundary by resource id.
    Boundary(u64),
    /// List of resource ids.
    ResourceIds,
    /// Rule proposal by id.
    Proposal(u64),
    /// Next proposal id.
    NextProposalId,
    /// Usage records per member.
    Usage(Address),
    /// Sanction per member.
    Sanction(Address),
    /// Conflict case by id.
    Conflict(u64),
    /// Next conflict id.
    NextConflictId,
    /// Set of members.
    Members,
    /// Vote tracking: (proposal_id, voter) -> bool.
    ProposalVote(u64, Address),
    /// Arbitration vote tracking: (case_id, voter) -> bool (true = complainant).
    ConflictVote(u64, Address),
}

/// Number of violations before escalation to restriction.
const VIOLATIONS_TO_RESTRICTION: u32 = 2;
/// Number of violations before escalation to expulsion.
const VIOLATIONS_TO_EXPULSION: u32 = 4;

/// Register a new member of the commons.
pub fn add_member(env: &Env, member: Address) {
    let mut members: Vec<Address> = env
        .storage()
        .instance()
        .get(&CommonsKey::Members)
        .unwrap_or(Vec::new(env));
    if !members.contains(&member) {
        members.push_back(member.clone());
        env.storage().instance().set(&CommonsKey::Members, &members);
    }
}

/// Check whether an address is a member.
pub fn is_member(env: &Env, member: &Address) -> bool {
    let members: Vec<Address> = env
        .storage()
        .instance()
        .get(&CommonsKey::Members)
        .unwrap_or(Vec::new(env));
    members.contains(member)
}

/// Define a resource boundary for the commons.
pub fn define_boundary(env: &Env, boundary: ResourceBoundary) {
    env.storage()
        .instance()
        .set(&CommonsKey::Boundary(boundary.resource_id), &boundary);
    let mut ids: Vec<u64> = env
        .storage()
        .instance()
        .get(&CommonsKey::ResourceIds)
        .unwrap_or(Vec::new(env));
    if !ids.contains(&boundary.resource_id) {
        ids.push_back(boundary.resource_id);
        env.storage().instance().set(&CommonsKey::ResourceIds, &ids);
    }
}

/// Retrieve a resource boundary.
pub fn get_boundary(env: &Env, resource_id: u64) -> Option<ResourceBoundary> {
    env.storage()
        .instance()
        .get(&CommonsKey::Boundary(resource_id))
}

/// Propose a new usage rule.
pub fn propose_rule(env: &Env, proposer: Address, description: String) -> u64 {
    proposer.require_auth();
    let mut next_id: u64 = env
        .storage()
        .instance()
        .get(&CommonsKey::NextProposalId)
        .unwrap_or(0);
    let proposal = RuleProposal {
        proposal_id: next_id,
        proposer,
        description,
        votes_for: 0,
        votes_against: 0,
        finalized: false,
        passed: false,
    };
    env.storage()
        .instance()
        .set(&CommonsKey::Proposal(next_id), &proposal);
    next_id += 1;
    env.storage()
        .instance()
        .set(&CommonsKey::NextProposalId, &next_id);
    proposal.proposal_id
}

/// Vote on a rule proposal.
pub fn vote_rule(env: &Env, voter: Address, proposal_id: u64, in_favor: bool) {
    voter.require_auth();
    let vote_key = CommonsKey::ProposalVote(proposal_id, voter.clone());
    if env.storage().instance().has(&vote_key) {
        panic!("already voted");
    }
    let mut proposal: RuleProposal = env
        .storage()
        .instance()
        .get(&CommonsKey::Proposal(proposal_id))
        .expect("proposal not found");
    if proposal.finalized {
        panic!("proposal finalized");
    }
    if in_favor {
        proposal.votes_for += 1;
    } else {
        proposal.votes_against += 1;
    }
    env.storage()
        .instance()
        .set(&CommonsKey::Proposal(proposal_id), &proposal);
    env.storage().instance().set(&vote_key, &true);
}

/// Finalize a rule proposal based on votes.
pub fn finalize_rule(env: &Env, proposal_id: u64) -> bool {
    let mut proposal: RuleProposal = env
        .storage()
        .instance()
        .get(&CommonsKey::Proposal(proposal_id))
        .expect("proposal not found");
    if proposal.finalized {
        return proposal.passed;
    }
    proposal.finalized = true;
    proposal.passed = proposal.votes_for > proposal.votes_against;
    env.storage()
        .instance()
        .set(&CommonsKey::Proposal(proposal_id), &proposal);
    proposal.passed
}

/// Record a member's energy usage and check against the boundary limit.
pub fn record_usage(
    env: &Env,
    member: Address,
    resource_id: u64,
    amount_wh: i128,
    timestamp: u64,
) {
    member.require_auth();
    let boundary = get_boundary(env, resource_id).expect("resource not found");
    if !boundary.active {
        panic!("resource inactive");
    }
    let record = UsageRecord {
        member: member.clone(),
        resource_id,
        amount_wh,
        timestamp,
    };
    let mut records: Vec<UsageRecord> = env
        .storage()
        .instance()
        .get(&CommonsKey::Usage(member.clone()))
        .unwrap_or(Vec::new(env));
    records.push_back(record);
    env.storage()
        .instance()
        .set(&CommonsKey::Usage(member.clone()), &records);

    if amount_wh > boundary.max_draw_per_member_wh {
        apply_sanction(env, member, String::from_str(env, "exceeded draw limit"));
    }
}

/// Retrieve usage records for a member.
pub fn get_usage(env: &Env, member: Address) -> Vec<UsageRecord> {
    env.storage()
        .instance()
        .get(&CommonsKey::Usage(member))
        .unwrap_or(Vec::new(env))
}

/// Apply a graduated sanction to a member for a violation.
pub fn apply_sanction(env: &Env, member: Address, reason: String) -> Sanction {
    let mut sanction: Sanction = env
        .storage()
        .instance()
        .get(&CommonsKey::Sanction(member.clone()))
        .unwrap_or(Sanction {
            member: member.clone(),
            level: SanctionLevel::None,
            violation_count: 0,
            reason: String::from_str(env, ""),
        });
    sanction.violation_count += 1;
    sanction.reason = reason;
    sanction.level = if sanction.violation_count >= VIOLATIONS_TO_EXPULSION {
        SanctionLevel::Expulsion
    } else if sanction.violation_count >= VIOLATIONS_TO_RESTRICTION {
        SanctionLevel::Restriction
    } else {
        SanctionLevel::Warning
    };
    env.storage()
        .instance()
        .set(&CommonsKey::Sanction(member), &sanction);
    sanction
}

/// Retrieve the sanction for a member.
pub fn get_sanction(env: &Env, member: Address) -> Option<Sanction> {
    env.storage().instance().get(&CommonsKey::Sanction(member))
}

/// Raise a conflict for arbitration.
pub fn raise_conflict(
    env: &Env,
    complainant: Address,
    respondent: Address,
    description: String,
) -> u64 {
    complainant.require_auth();
    let mut next_id: u64 = env
        .storage()
        .instance()
        .get(&CommonsKey::NextConflictId)
        .unwrap_or(0);
    let case = ConflictCase {
        case_id: next_id,
        complainant,
        respondent,
        description,
        votes_for_complainant: 0,
        votes_for_respondent: 0,
        resolved: false,
        complainant_won: false,
    };
    env.storage()
        .instance()
        .set(&CommonsKey::Conflict(next_id), &case);
    next_id += 1;
    env.storage()
        .instance()
        .set(&CommonsKey::NextConflictId, &next_id);
    case.case_id
}

/// Vote on a conflict case. `support_complainant` true votes for complainant.
pub fn vote_conflict(env: &Env, voter: Address, case_id: u64, support_complainant: bool) {
    voter.require_auth();
    let vote_key = CommonsKey::ConflictVote(case_id, voter.clone());
    if env.storage().instance().has(&vote_key) {
        panic!("already voted");
    }
    let mut case: ConflictCase = env
        .storage()
        .instance()
        .get(&CommonsKey::Conflict(case_id))
        .expect("case not found");
    if case.resolved {
        panic!("case resolved");
    }
    if support_complainant {
        case.votes_for_complainant += 1;
    } else {
        case.votes_for_respondent += 1;
    }
    env.storage()
        .instance()
        .set(&CommonsKey::Conflict(case_id), &case);
    env.storage().instance().set(&vote_key, &true);
}

/// Resolve a conflict case via arbitration votes.
pub fn resolve_conflict(env: &Env, case_id: u64) -> bool {
    let mut case: ConflictCase = env
        .storage()
        .instance()
        .get(&CommonsKey::Conflict(case_id))
        .expect("case not found");
    if case.resolved {
        return case.complainant_won;
    }
    case.resolved = true;
    case.complainant_won = case.votes_for_complainant > case.votes_for_respondent;
    env.storage()
        .instance()
        .set(&CommonsKey::Conflict(case_id), &case);
    case.complainant_won
}

/// Retrieve a conflict case.
pub fn get_conflict(env: &Env, case_id: u64) -> Option<ConflictCase> {
    env.storage().instance().get(&CommonsKey::Conflict(case_id))
}

/// Retrieve a rule proposal.
pub fn get_proposal(env: &Env, proposal_id: u64) -> Option<RuleProposal> {
    env.storage()
        .instance()
        .get(&CommonsKey::Proposal(proposal_id))
}