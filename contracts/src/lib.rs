use soroban_sdk::{contract, contractimpl, contracttype, symbol_short, Address, Env, Symbol};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Meter {
    pub id: u64,
    pub owner: Address,
    pub balance: i128,
    pub active: bool,
    pub decommissioned: bool,
}

const METER_KEY: Symbol = symbol_short!("METER");
const ADMIN_KEY: Symbol = symbol_short!("ADMIN");

#[contract]
pub struct MeterContract;

#[contractimpl]
impl MeterContract {
    pub fn init(env: Env, admin: Address) {
        env.storage().instance().set(&ADMIN_KEY, &admin);
    }

    fn admin(env: &Env) -> Address {
        env.storage().instance().get(&ADMIN_KEY).unwrap()
    }

    fn load_meter(env: &Env, id: u64) -> Meter {
        env.storage().persistent().get(&(METER_KEY, id)).unwrap()
    }

    fn save_meter(env: &Env, meter: &Meter) {
        env.storage().persistent().set(&(METER_KEY, meter.id), meter);
    }

    fn require_not_decommissioned(meter: &Meter) {
        if meter.decommissioned {
            panic!("meter decommissioned");
        }
    }

    pub fn register_meter(env: Env, id: u64, owner: Address) {
        let meter = Meter {
            id,
            owner,
            balance: 0,
            active: true,
            decommissioned: false,
        };
        Self::save_meter(&env, &meter);
    }

    pub fn top_up(env: Env, id: u64, amount: i128) {
        let mut meter = Self::load_meter(&env, id);
        Self::require_not_decommissioned(&meter);
        meter.balance += amount;
        Self::save_meter(&env, &meter);
    }

    pub fn consume(env: Env, id: u64, amount: i128) {
        let mut meter = Self::load_meter(&env, id);
        Self::require_not_decommissioned(&meter);
        meter.balance -= amount;
        Self::save_meter(&env, &meter);
    }

    pub fn decommission_meter(env: Env, id: u64) {
        let admin = Self::admin(&env);
        admin.require_auth();

        let mut meter = Self::load_meter(&env, id);
        Self::require_not_decommissioned(&meter);

        let refund = meter.balance;
        meter.balance = 0;
        meter.active = false;
        meter.decommissioned = true;
        Self::save_meter(&env, &meter);

        env.events()
            .publish((symbol_short!("MeterDecommissioned"), id), (meter.owner.clone(), refund));
    }

    pub fn get_meter(env: Env, id: u64) -> Meter {
        Self::load_meter(&env, id)
    }
}
