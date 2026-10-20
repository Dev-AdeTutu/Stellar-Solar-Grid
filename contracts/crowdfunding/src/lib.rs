#![no_std]
//! Community solar crowdfunding with milestone-based escrow and contributor governance.

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, token, Address, Env, Map, String, Vec};

#[contracttype]
#[derive(Clone)]
pub struct Milestone {
    pub description: String,
    pub amount: i128,
    pub votes_for: i128,
    pub votes_against: i128,
    pub released: bool,
}

#[contracttype]
#[derive(Clone)]
pub struct Campaign {
    pub creator: Address,
    pub token: Address,
    pub goal: i128,
    pub raised: i128,
    pub deadline: u64,
    pub milestones: Vec<Milestone>,
    pub contributions: Map<Address, i128>,
    pub returns_deposited: i128,
}

#[contracttype]
pub enum DataKey {
    Campaign(u32),
    Count,
    Voted(u32, u32, Address),
    Claimed(u32, Address),
}

#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq)]
pub enum Error {
    NotFound = 1,
    Ended = 2,
    GoalNotMet = 3,
    AlreadyVoted = 4,
    NotContributor = 5,
    AlreadyReleased = 6,
    NotApproved = 7,
    InvalidAmount = 8,
    StillActive = 9,
}

#[contract]
pub struct Crowdfunding;

fn load(env: &Env, id: u32) -> Result<Campaign, Error> {
    env.storage().persistent().get(&DataKey::Campaign(id)).ok_or(Error::NotFound)
}

fn save(env: &Env, id: u32, c: &Campaign) {
    env.storage().persistent().set(&DataKey::Campaign(id), c);
}

#[contractimpl]
impl Crowdfunding {
    /// Create a campaign. Milestone amounts must sum to `goal`.
    pub fn create_campaign(env: Env, creator: Address, token: Address, goal: i128, deadline: u64, milestones: Vec<(String, i128)>) -> Result<u32, Error> {
        creator.require_auth();
        let mut ms = Vec::new(&env);
        let mut total = 0i128;
        for (description, amount) in milestones.iter() {
            total += amount;
            ms.push_back(Milestone { description, amount, votes_for: 0, votes_against: 0, released: false });
        }
        if goal <= 0 || total != goal {
            return Err(Error::InvalidAmount);
        }
        let id: u32 = env.storage().instance().get(&DataKey::Count).unwrap_or(0);
        save(&env, id, &Campaign { creator, token, goal, raised: 0, deadline, milestones: ms, contributions: Map::new(&env), returns_deposited: 0 });
        env.storage().instance().set(&DataKey::Count, &(id + 1));
        Ok(id)
    }

    /// Contribute tokens (XLM / USDC / fiat-anchored stablecoin) into escrow.
    pub fn contribute(env: Env, id: u32, contributor: Address, amount: i128) -> Result<(), Error> {
        contributor.require_auth();
        let mut c = load(&env, id)?;
        if env.ledger().timestamp() > c.deadline { return Err(Error::Ended); }
        if amount <= 0 { return Err(Error::InvalidAmount); }
        token::Client::new(&env, &c.token).transfer(&contributor, &env.current_contract_address(), &amount);
        c.raised += amount;
        let prev = c.contributions.get(contributor.clone()).unwrap_or(0);
        c.contributions.set(contributor, prev + amount);
        save(&env, id, &c);
        Ok(())
    }

    /// Contributors vote on milestone completion, weighted by contribution.
    pub fn vote(env: Env, id: u32, milestone: u32, voter: Address, approve: bool) -> Result<(), Error> {
        voter.require_auth();
        let mut c = load(&env, id)?;
        let weight = c.contributions.get(voter.clone()).ok_or(Error::NotContributor)?;
        let key = DataKey::Voted(id, milestone, voter);
        if env.storage().persistent().has(&key) { return Err(Error::AlreadyVoted); }
        let mut m = c.milestones.get(milestone).ok_or(Error::NotFound)?;
        if approve { m.votes_for += weight } else { m.votes_against += weight }
        c.milestones.set(milestone, m);
        env.storage().persistent().set(&key, &true);
        save(&env, id, &c);
        Ok(())
    }

    /// Release milestone funds to the creator once >50% of raised weight approves.
    pub fn release_milestone(env: Env, id: u32, milestone: u32) -> Result<(), Error> {
        let mut c = load(&env, id)?;
        if c.raised < c.goal { return Err(Error::GoalNotMet); }
        let mut m = c.milestones.get(milestone).ok_or(Error::NotFound)?;
        if m.released { return Err(Error::AlreadyReleased); }
        if m.votes_for * 2 <= c.raised { return Err(Error::NotApproved); }
        token::Client::new(&env, &c.token).transfer(&env.current_contract_address(), &c.creator, &m.amount);
        m.released = true;
        c.milestones.set(milestone, m);
        save(&env, id, &c);
        Ok(())
    }

    /// Refund a contributor if the deadline passed without reaching the goal.
    pub fn refund(env: Env, id: u32, contributor: Address) -> Result<i128, Error> {
        contributor.require_auth();
        let mut c = load(&env, id)?;
        if env.ledger().timestamp() <= c.deadline { return Err(Error::StillActive); }
        if c.raised >= c.goal { return Err(Error::InvalidAmount); }
        let amt = c.contributions.get(contributor.clone()).ok_or(Error::NotContributor)?;
        token::Client::new(&env, &c.token).transfer(&env.current_contract_address(), &contributor, &amt);
        c.contributions.remove(contributor);
        c.raised -= amt;
        save(&env, id, &c);
        Ok(amt)
    }

    /// Creator deposits project revenue for ROI distribution.
    pub fn deposit_returns(env: Env, id: u32, amount: i128) -> Result<(), Error> {
        let mut c = load(&env, id)?;
        c.creator.require_auth();
        if amount <= 0 { return Err(Error::InvalidAmount); }
        token::Client::new(&env, &c.token).transfer(&c.creator, &env.current_contract_address(), &amount);
        c.returns_deposited += amount;
        save(&env, id, &c);
        Ok(())
    }

    /// Contributor claims their pro-rata share of deposited returns.
    pub fn claim_returns(env: Env, id: u32, contributor: Address) -> Result<i128, Error> {
        contributor.require_auth();
        let c = load(&env, id)?;
        let stake = c.contributions.get(contributor.clone()).ok_or(Error::NotContributor)?;
        let key = DataKey::Claimed(id, contributor.clone());
        let claimed: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        let owed = c.returns_deposited * stake / c.raised - claimed;
        if owed > 0 {
            token::Client::new(&env, &c.token).transfer(&env.current_contract_address(), &contributor, &owed);
            env.storage().persistent().set(&key, &(claimed + owed));
        }
        Ok(owed)
    }

    pub fn get_campaign(env: Env, id: u32) -> Result<Campaign, Error> {
        load(&env, id)
    }

    pub fn campaign_count(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::Count).unwrap_or(0)
    }
}
