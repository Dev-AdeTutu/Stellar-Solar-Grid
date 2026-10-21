//! Decentralized oracle network (#1052). See contracts/ORACLES.md.
//!
//! Pure aggregation/consensus logic: registered oracle nodes submit values for
//! a feed round, the round finalizes on the median of submissions, nodes whose
//! value deviates beyond the tolerance are slashed and lose reputation, honest
//! nodes earn a reward and gain reputation.

use soroban_sdk::{contracttype, Address, Env, Vec};

/// Minimum distinct submissions before a round can finalize.
pub const MIN_SUBMISSIONS: u32 = 3;
/// Max deviation from the median, in basis points, before a node is slashed.
pub const DEVIATION_TOLERANCE_BPS: i128 = 500;
/// Stake slashed from a dishonest node, in basis points of its stake.
pub const SLASH_BPS: i128 = 1_000;
/// Reputation bounds and deltas.
pub const MAX_REPUTATION: u32 = 1_000;
pub const REPUTATION_GAIN: u32 = 5;
pub const REPUTATION_LOSS: u32 = 100;

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum FeedKind {
    Price,
    Weather,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct OracleNode {
    pub operator: Address,
    pub stake: i128,
    pub reputation: u32,
    pub rewards: i128,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct Submission {
    pub operator: Address,
    pub value: i128,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct RoundOutcome {
    pub median: i128,
    pub honest: Vec<Address>,
    pub slashed: Vec<Address>,
    pub total_slashed: i128,
}

/// Median of the values; for an even count, the floor-average of the two middle values.
pub fn median(env: &Env, values: &Vec<i128>) -> Option<i128> {
    let n = values.len();
    if n == 0 {
        return None;
    }
    let mut sorted = Vec::new(env);
    for v in values.iter() {
        let mut i = 0;
        while i < sorted.len() && sorted.get_unchecked(i) <= v {
            i += 1;
        }
        sorted.insert(i, v);
    }
    let mid = n / 2;
    if n % 2 == 1 {
        Some(sorted.get_unchecked(mid))
    } else {
        Some((sorted.get_unchecked(mid - 1) + sorted.get_unchecked(mid)) / 2)
    }
}

/// True when `value` is within `DEVIATION_TOLERANCE_BPS` of `reference`.
pub fn within_tolerance(value: i128, reference: i128) -> bool {
    let diff = (value - reference).abs();
    let base = reference.abs().max(1);
    diff * 10_000 <= base * DEVIATION_TOLERANCE_BPS
}

/// Weight used when choosing among nodes; nodes with zero reputation are ignored.
pub fn voting_weight(node: &OracleNode) -> u32 {
    node.reputation
}

/// Finalize a round: compute the median, slash outliers and reward honest nodes.
/// `reward_pool` (plus slashed stake) is split equally among honest nodes.
pub fn finalize_round(
    env: &Env,
    nodes: &mut Vec<OracleNode>,
    submissions: &Vec<Submission>,
    reward_pool: i128,
) -> Option<RoundOutcome> {
    if submissions.len() < MIN_SUBMISSIONS {
        return None;
    }
    let mut values = Vec::new(env);
    for s in submissions.iter() {
        if let Some(node) = find(nodes, &s.operator) {
            if voting_weight(&node) > 0 {
                values.push_back(s.value);
            }
        }
    }
    if values.len() < MIN_SUBMISSIONS {
        return None;
    }
    let med = median(env, &values)?;

    let mut honest = Vec::new(env);
    let mut slashed = Vec::new(env);
    let mut total_slashed = 0i128;
    for s in submissions.iter() {
        let Some(idx) = index_of(nodes, &s.operator) else { continue };
        let mut node = nodes.get_unchecked(idx);
        if within_tolerance(s.value, med) {
            node.reputation = (node.reputation + REPUTATION_GAIN).min(MAX_REPUTATION);
            honest.push_back(node.operator.clone());
        } else {
            let penalty = node.stake * SLASH_BPS / 10_000;
            node.stake -= penalty;
            total_slashed += penalty;
            node.reputation = node.reputation.saturating_sub(REPUTATION_LOSS);
            slashed.push_back(node.operator.clone());
        }
        nodes.set(idx, node);
    }

    if !honest.is_empty() {
        let share = (reward_pool + total_slashed) / honest.len() as i128;
        for op in honest.iter() {
            let idx = index_of(nodes, &op).unwrap();
            let mut node = nodes.get_unchecked(idx);
            node.rewards += share;
            nodes.set(idx, node);
        }
    }

    Some(RoundOutcome { median: med, honest, slashed, total_slashed })
}

fn index_of(nodes: &Vec<OracleNode>, op: &Address) -> Option<u32> {
    nodes.iter().position(|n| &n.operator == op).map(|i| i as u32)
}

fn find(nodes: &Vec<OracleNode>, op: &Address) -> Option<OracleNode> {
    index_of(nodes, op).map(|i| nodes.get_unchecked(i))
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{testutils::Address as _, vec};

    fn node(env: &Env) -> OracleNode {
        OracleNode { operator: Address::generate(env), stake: 10_000, reputation: 500, rewards: 0 }
    }

    #[test]
    fn median_odd_and_even() {
        let env = Env::default();
        assert_eq!(median(&env, &vec![&env, 5, 1, 3]), Some(3));
        assert_eq!(median(&env, &vec![&env, 4, 1, 3, 2]), Some(2));
        assert_eq!(median(&env, &Vec::new(&env)), None);
    }

    #[test]
    fn tolerance() {
        assert!(within_tolerance(105, 100));
        assert!(!within_tolerance(106, 100));
    }

    #[test]
    fn consensus_slashes_outlier_and_rewards_honest() {
        let env = Env::default();
        let (a, b, c, d) = (node(&env), node(&env), node(&env), node(&env));
        let mut nodes = vec![&env, a.clone(), b.clone(), c.clone(), d.clone()];
        let subs = vec![
            &env,
            Submission { operator: a.operator.clone(), value: 100 },
            Submission { operator: b.operator.clone(), value: 101 },
            Submission { operator: c.operator.clone(), value: 99 },
            Submission { operator: d.operator.clone(), value: 200 },
        ];
        let out = finalize_round(&env, &mut nodes, &subs, 300).unwrap();
        assert_eq!(out.median, 100);
        assert_eq!(out.slashed, vec![&env, d.operator.clone()]);
        assert_eq!(out.total_slashed, 1_000);
        let liar = nodes.get_unchecked(3);
        assert_eq!(liar.stake, 9_000);
        assert_eq!(liar.reputation, 400);
        let honest = nodes.get_unchecked(0);
        assert_eq!(honest.reputation, 505);
        assert_eq!(honest.rewards, (300 + 1_000) / 3);
    }

    #[test]
    fn requires_quorum() {
        let env = Env::default();
        let (a, b) = (node(&env), node(&env));
        let mut nodes = vec![&env, a.clone(), b.clone()];
        let subs = vec![
            &env,
            Submission { operator: a.operator.clone(), value: 1 },
            Submission { operator: b.operator.clone(), value: 1 },
        ];
        assert!(finalize_round(&env, &mut nodes, &subs, 0).is_none());
    }

    #[test]
    fn zero_reputation_nodes_excluded_from_quorum() {
        let env = Env::default();
        let (a, b, mut c) = (node(&env), node(&env), node(&env));
        c.reputation = 0;
        let mut nodes = vec![&env, a.clone(), b.clone(), c.clone()];
        let subs = vec![
            &env,
            Submission { operator: a.operator.clone(), value: 10 },
            Submission { operator: b.operator.clone(), value: 10 },
            Submission { operator: c.operator.clone(), value: 10 },
        ];
        assert!(finalize_round(&env, &mut nodes, &subs, 0).is_none());
    }
}
