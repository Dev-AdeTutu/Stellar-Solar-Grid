#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, String, Symbol};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TargetChain {
    Stellar,
    Ethereum,
    Polygon,
    Arbitrum,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BridgeReceipt {
    pub nonce: u64,
    pub sender: Address,
    pub target_chain: TargetChain,
    pub target_address: String,
    pub amount: i128,
    pub meter_id: Option<String>,
    pub is_wrapped: bool,
}

#[contracttype]
pub enum DataKey {
    Admin,
    Paused,
    Nonce,
    LockedLiquidity,
    WrappedBalance(Address, TargetChain),
    ProcessedNonce(u64),
    Receipt(u64),
}

#[contract]
pub struct CrossChainBridgeContract;

#[contractimpl]
impl CrossChainBridgeContract {
    pub fn initialize(env: Env, admin: Address) {
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Paused, &false);
        env.storage().instance().set(&DataKey::Nonce, &0u64);
        env.storage()
            .instance()
            .set(&DataKey::LockedLiquidity, &0i128);
    }

    /// Emergency circuit breaker for bridge security
    pub fn set_paused(env: Env, caller: Address, paused: bool) {
        caller.require_auth();
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Not initialized");
        assert!(caller == admin, "Unauthorized caller");
        env.storage().instance().set(&DataKey::Paused, &paused);
    }

    /// Lock native Stellar SOLAR tokens and mint wrapped representation for a target chain (Ethereum, Polygon, etc.)
    pub fn wrap_to_chain(
        env: Env,
        sender: Address,
        target_chain: TargetChain,
        target_address: String,
        amount: i128,
    ) -> BridgeReceipt {
        sender.require_auth();
        Self::require_not_paused(&env);
        assert!(amount > 0, "Amount must be positive");

        let nonce = Self::next_nonce(&env);
        let locked: i128 = env
            .storage()
            .instance()
            .get(&DataKey::LockedLiquidity)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::LockedLiquidity, &(locked + amount));

        let cur_wrapped: i128 = env
            .storage()
            .instance()
            .get(&DataKey::WrappedBalance(sender.clone(), target_chain.clone()))
            .unwrap_or(0);
        env.storage().instance().set(
            &DataKey::WrappedBalance(sender.clone(), target_chain.clone()),
            &(cur_wrapped + amount),
        );

        let receipt = BridgeReceipt {
            nonce,
            sender,
            target_chain,
            target_address,
            amount,
            meter_id: None,
            is_wrapped: true,
        };
        env.storage()
            .instance()
            .set(&DataKey::Receipt(nonce), &receipt);
        receipt
    }

    /// Burn wrapped cross-chain tokens and unwrap back to native Stellar tokens with replay protection
    pub fn unwrap_from_chain(
        env: Env,
        recipient: Address,
        source_chain: TargetChain,
        external_nonce: u64,
        amount: i128,
    ) -> i128 {
        recipient.require_auth();
        Self::require_not_paused(&env);
        assert!(amount > 0, "Amount must be positive");

        let already_processed: bool = env
            .storage()
            .instance()
            .get(&DataKey::ProcessedNonce(external_nonce))
            .unwrap_or(false);
        assert!(!already_processed, "Nonce already processed");

        let cur_wrapped: i128 = env
            .storage()
            .instance()
            .get(&DataKey::WrappedBalance(recipient.clone(), source_chain.clone()))
            .unwrap_or(0);
        assert!(cur_wrapped >= amount, "Insufficient wrapped balance");

        let locked: i128 = env
            .storage()
            .instance()
            .get(&DataKey::LockedLiquidity)
            .unwrap_or(0);
        assert!(locked >= amount, "Insufficient bridge liquidity");

        env.storage()
            .instance()
            .set(&DataKey::ProcessedNonce(external_nonce), &true);
        env.storage().instance().set(
            &DataKey::WrappedBalance(recipient, source_chain),
            &(cur_wrapped - amount),
        );
        env.storage()
            .instance()
            .set(&DataKey::LockedLiquidity, &(locked - amount));

        amount
    }

    /// Execute a cross-chain solar meter bill payment originating from Ethereum, Polygon, or Arbitrum
    pub fn cross_chain_payment(
        env: Env,
        payer: Address,
        source_chain: TargetChain,
        meter_id: String,
        amount: i128,
    ) -> BridgeReceipt {
        payer.require_auth();
        Self::require_not_paused(&env);
        assert!(amount > 0, "Payment amount must be positive");

        let nonce = Self::next_nonce(&env);
        let receipt = BridgeReceipt {
            nonce,
            sender: payer,
            target_chain: source_chain,
            target_address: meter_id.clone(),
            amount,
            meter_id: Some(meter_id),
            is_wrapped: false,
        };
        env.storage()
            .instance()
            .set(&DataKey::Receipt(nonce), &receipt);
        receipt
    }

    /// Calculate unified token balance across Stellar, Ethereum, Polygon, and Arbitrum
    pub fn unified_balance(env: Env, account: Address, native_stellar_balance: i128) -> i128 {
        let eth: i128 = env
            .storage()
            .instance()
            .get(&DataKey::WrappedBalance(account.clone(), TargetChain::Ethereum))
            .unwrap_or(0);
        let poly: i128 = env
            .storage()
            .instance()
            .get(&DataKey::WrappedBalance(account.clone(), TargetChain::Polygon))
            .unwrap_or(0);
        let arb: i128 = env
            .storage()
            .instance()
            .get(&DataKey::WrappedBalance(account, TargetChain::Arbitrum))
            .unwrap_or(0);
        native_stellar_balance + eth + poly + arb
    }

    fn require_not_paused(env: &Env) {
        let paused: bool = env
            .storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false);
        assert!(!paused, "Bridge is currently paused");
    }

    fn next_nonce(env: &Env) -> u64 {
        let n: u64 = env.storage().instance().get(&DataKey::Nonce).unwrap_or(0) + 1;
        env.storage().instance().set(&DataKey::Nonce, &n);
        n
    }
}
