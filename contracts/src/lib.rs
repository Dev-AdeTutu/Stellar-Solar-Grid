use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, Map, Symbol, Vec};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MeterShareholder {
    pub address: Address,
    pub share_percentage: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Meter {
    pub owner: Address,
    pub balance: i128,
    pub shareholders: Vec<MeterShareholder>,
}

#[contract]
pub struct MeterContract;

#[contractimpl]
impl MeterContract {
    /// Register a new meter owned by `owner`.
    pub fn create_meter(env: Env, owner: Address) -> u64 {
        owner.require_auth();
        let mut meters: Map<u64, Meter> = env
            .storage()
            .instance()
            .get(&Symbol::new(&env, "meters"))
            .unwrap_or(Map::new(&env));
        let id = meters.len() as u64 + 1;
        meters.set(
            id,
            Meter {
                owner,
                balance: 0,
                shareholders: Vec::new(&env),
            },
        );
        env.storage().instance().set(&Symbol::new(&env, "meters"), &meters);
        id
    }

    /// Owner adds a co-payer with a given share percentage (basis points, 0-10000).
    pub fn add_meter_share_holder(
        env: Env,
        meter_id: u64,
        shareholder: Address,
        share_percentage: u32,
    ) {
        let mut meters: Map<u64, Meter> = env
            .storage()
            .instance()
            .get(&Symbol::new(&env, "meters"))
            .expect("meter not found");
        let mut meter = meters.get(meter_id).expect("meter not found");
        meter.owner.require_auth();
        assert!(share_percentage <= 10000, "share percentage exceeds 100%");

        let mut total: u32 = share_percentage;
        for s in meter.shareholders.iter() {
            total += s.share_percentage;
        }
        assert!(total <= 10000, "total share percentage exceeds 100%");

        meter.shareholders.push_back(MeterShareholder {
            address: shareholder,
            share_percentage,
        });
        meters.set(meter_id, meter);
        env.storage().instance().set(&Symbol::new(&env, "meters"), &meters);
    }

    /// Query the shareholders of a meter.
    pub fn get_meter_shareholders(env: Env, meter_id: u64) -> Vec<MeterShareholder> {
        let meters: Map<u64, Meter> = env
            .storage()
            .instance()
            .get(&Symbol::new(&env, "meters"))
            .expect("meter not found");
        let meter = meters.get(meter_id).expect("meter not found");
        meter.shareholders
    }

    /// Deduct a usage cost proportionally from each co-payer balance.
    pub fn deduct_usage_cost(env: Env, meter_id: u64, cost: i128) {
        let mut meters: Map<u64, Meter> = env
            .storage()
            .instance()
            .get(&Symbol::new(&env, "meters"))
            .expect("meter not found");
        let mut meter = meters.get(meter_id).expect("meter not found");
        meter.owner.require_auth();
        assert!(cost >= 0, "cost must be non-negative");

        let mut balances: Map<Address, i128> = env
            .storage()
            .instance()
            .get(&Symbol::new(&env, "balances"))
            .unwrap_or(Map::new(&env));

        for s in meter.shareholders.iter() {
            let share = (cost * s.share_percentage as i128) / 10000;
            let current = balances.get(s.address.clone()).unwrap_or(0);
            balances.set(s.address.clone(), current - share);
        }

        meter.balance -= cost;
        meters.set(meter_id, meter);
        env.storage().instance().set(&Symbol::new(&env, "meters"), &meters);
        env.storage().instance().set(&Symbol::new(&env, "balances"), &balances);
    }

    /// Query a co-payer's balance.
    pub fn get_balance(env: Env, address: Address) -> i128 {
        let balances: Map<Address, i128> = env
            .storage()
            .instance()
            .get(&Symbol::new(&env, "balances"))
            .unwrap_or(Map::new(&env));
        balances.get(address).unwrap_or(0)
    }
}
