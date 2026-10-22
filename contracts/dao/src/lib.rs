#![no_std]
use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, Address, Env, Map, String, Symbol, Vec,
};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum VotingMode {
    TokenWeighted,
    Quadratic,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProposalStatus {
    Active,
    Approved,
    Rejected,
    Queued,
    Executed,
    Cancelled,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Proposal {
    pub id: u64,
    pub proposer: Address,
    pub title: String,
    pub description: String,
    pub parameter_key: Symbol,
    pub parameter_value: i128,
    pub treasury_recipient: Option<Address>,
    pub treasury_amount: i128,
    pub votes_for: i128,
    pub votes_against: i128,
    pub voting_mode: VotingMode,
    pub created_at: u64,
    pub voting_ends_at: u64,
    pub execution_eta: u64,
    pub status: ProposalStatus,
}

#[contracttype]
pub enum DataKey {
    GovTokenBalance(Address),
    TotalSupply,
    Proposal(u64),
    ProposalCount,
    HasVoted(u64, Address),
    TimelockDelay,
    VotingPeriod,
    QuorumVotes,
    TreasuryBalance,
    PlatformParam(Symbol),
}

#[contract]
pub struct GovernanceDaoContract;

#[contractimpl]
impl GovernanceDaoContract {
    /// Initialize DAO parameters, timelock delay, voting period, and initial quorum
    pub fn initialize(
        env: Env,
        initial_member: Address,
        initial_supply: i128,
        voting_period: u64,
        timelock_delay: u64,
        quorum_votes: i128,
    ) {
        env.storage()
            .instance()
            .set(&DataKey::GovTokenBalance(initial_member), &initial_supply);
        env.storage()
            .instance()
            .set(&DataKey::TotalSupply, &initial_supply);
        env.storage()
            .instance()
            .set(&DataKey::VotingPeriod, &voting_period);
        env.storage()
            .instance()
            .set(&DataKey::TimelockDelay, &timelock_delay);
        env.storage()
            .instance()
            .set(&DataKey::QuorumVotes, &quorum_votes);
        env.storage()
            .instance()
            .set(&DataKey::ProposalCount, &0u64);
        env.storage()
            .instance()
            .set(&DataKey::TreasuryBalance, &0i128);
    }

    /// Mint or distribute governance tokens for voting rights
    pub fn mint_governance_tokens(env: Env, recipient: Address, amount: i128) {
        let current: i128 = env
            .storage()
            .instance()
            .get(&DataKey::GovTokenBalance(recipient.clone()))
            .unwrap_or(0);
        let total: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalSupply)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::GovTokenBalance(recipient), &(current + amount));
        env.storage()
            .instance()
            .set(&DataKey::TotalSupply, &(total + amount));
    }

    /// Query governance token balance of a member
    pub fn token_balance(env: Env, voter: Address) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::GovTokenBalance(voter))
            .unwrap_or(0)
    }

    /// Deposit funds into the DAO Treasury
    pub fn deposit_treasury(env: Env, depositor: Address, amount: i128) -> i128 {
        depositor.require_auth();
        let balance: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TreasuryBalance)
            .unwrap_or(0);
        let updated = balance + amount;
        env.storage()
            .instance()
            .set(&DataKey::TreasuryBalance, &updated);
        updated
    }

    /// Get current DAO Treasury balance
    pub fn treasury_balance(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::TreasuryBalance)
            .unwrap_or(0)
    }

    /// Create a governance proposal for platform parameters, upgrades, or treasury disbursement
    pub fn create_proposal(
        env: Env,
        proposer: Address,
        title: String,
        description: String,
        parameter_key: Symbol,
        parameter_value: i128,
        treasury_recipient: Option<Address>,
        treasury_amount: i128,
        voting_mode: VotingMode,
    ) -> u64 {
        proposer.require_auth();
        let balance = Self::token_balance(env.clone(), proposer.clone());
        assert!(balance > 0, "Proposer must hold governance tokens");

        let count: u64 = env
            .storage()
            .instance()
            .get(&DataKey::ProposalCount)
            .unwrap_or(0);
        let id = count + 1;
        let now = env.ledger().timestamp();
        let voting_period: u64 = env
            .storage()
            .instance()
            .get(&DataKey::VotingPeriod)
            .unwrap_or(86400);

        let proposal = Proposal {
            id,
            proposer,
            title,
            description,
            parameter_key,
            parameter_value,
            treasury_recipient,
            treasury_amount,
            votes_for: 0,
            votes_against: 0,
            voting_mode,
            created_at: now,
            voting_ends_at: now + voting_period,
            execution_eta: 0,
            status: ProposalStatus::Active,
        };

        env.storage()
            .instance()
            .set(&DataKey::Proposal(id), &proposal);
        env.storage()
            .instance()
            .set(&DataKey::ProposalCount, &id);
        id
    }

    /// Cast a vote using either TokenWeighted or Quadratic voting
    pub fn cast_vote(env: Env, proposal_id: u64, voter: Address, support: bool, token_amount: i128) {
        voter.require_auth();
        let mut proposal: Proposal = env
            .storage()
            .instance()
            .get(&DataKey::Proposal(proposal_id))
            .expect("Proposal not found");

        assert!(
            proposal.status == ProposalStatus::Active,
            "Proposal is not active"
        );
        assert!(
            env.ledger().timestamp() <= proposal.voting_ends_at,
            "Voting period has ended"
        );

        let already_voted: bool = env
            .storage()
            .instance()
            .get(&DataKey::HasVoted(proposal_id, voter.clone()))
            .unwrap_or(false);
        assert!(!already_voted, "Voter has already voted on this proposal");

        let balance = Self::token_balance(env.clone(), voter.clone());
        assert!(
            balance >= token_amount && token_amount > 0,
            "Insufficient governance tokens"
        );

        let weight = match proposal.voting_mode {
            VotingMode::TokenWeighted => token_amount,
            VotingMode::Quadratic => Self::integer_sqrt(token_amount),
        };

        if support {
            proposal.votes_for += weight;
        } else {
            proposal.votes_against += weight;
        }

        env.storage()
            .instance()
            .set(&DataKey::HasVoted(proposal_id, voter), &true);
        env.storage()
            .instance()
            .set(&DataKey::Proposal(proposal_id), &proposal);
    }

    /// Finalize voting and queue approved proposal into time-lock
    pub fn queue_proposal(env: Env, proposal_id: u64) -> ProposalStatus {
        let mut proposal: Proposal = env
            .storage()
            .instance()
            .get(&DataKey::Proposal(proposal_id))
            .expect("Proposal not found");

        assert!(
            proposal.status == ProposalStatus::Active,
            "Proposal cannot be queued"
        );
        assert!(
            env.ledger().timestamp() >= proposal.voting_ends_at,
            "Voting still in progress"
        );

        let quorum: i128 = env
            .storage()
            .instance()
            .get(&DataKey::QuorumVotes)
            .unwrap_or(1);
        let total_votes = proposal.votes_for + proposal.votes_against;

        if total_votes >= quorum && proposal.votes_for > proposal.votes_against {
            let timelock: u64 = env
                .storage()
                .instance()
                .get(&DataKey::TimelockDelay)
                .unwrap_or(3600);
            proposal.status = ProposalStatus::Queued;
            proposal.execution_eta = env.ledger().timestamp() + timelock;
        } else {
            proposal.status = ProposalStatus::Rejected;
        }

        let status = proposal.status.clone();
        env.storage()
            .instance()
            .set(&DataKey::Proposal(proposal_id), &proposal);
        status
    }

    /// Execute a queued proposal after its time-lock delay has elapsed
    pub fn execute_proposal(env: Env, proposal_id: u64) {
        let mut proposal: Proposal = env
            .storage()
            .instance()
            .get(&DataKey::Proposal(proposal_id))
            .expect("Proposal not found");

        assert!(
            proposal.status == ProposalStatus::Queued,
            "Proposal is not queued for execution"
        );
        assert!(
            env.ledger().timestamp() >= proposal.execution_eta,
            "Timelock period has not elapsed"
        );

        // Update platform parameter
        env.storage().instance().set(
            &DataKey::PlatformParam(proposal.parameter_key.clone()),
            &proposal.parameter_value,
        );

        // Process DAO treasury disbursement if specified
        if proposal.treasury_amount > 0 {
            let current_treasury = Self::treasury_balance(env.clone());
            assert!(
                current_treasury >= proposal.treasury_amount,
                "Insufficient treasury funds"
            );
            env.storage().instance().set(
                &DataKey::TreasuryBalance,
                &(current_treasury - proposal.treasury_amount),
            );
        }

        proposal.status = ProposalStatus::Executed;
        env.storage()
            .instance()
            .set(&DataKey::Proposal(proposal_id), &proposal);
    }

    /// Read proposal details
    pub fn get_proposal(env: Env, proposal_id: u64) -> Proposal {
        env.storage()
            .instance()
            .get(&DataKey::Proposal(proposal_id))
            .expect("Proposal not found")
    }

    /// Read governed platform parameter
    pub fn get_parameter(env: Env, key: Symbol) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::PlatformParam(key))
            .unwrap_or(0)
    }

    fn integer_sqrt(n: i128) -> i128 {
        if n <= 0 {
            return 0;
        }
        let mut x = n;
        let mut y = (x + 1) / 2;
        while y < x {
            x = y;
            y = (x + n / x) / 2;
        }
        x
    }
}
