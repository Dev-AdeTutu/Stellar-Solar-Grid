//! N-of-M multi-signature wallet for organizational accounts (Issue #872).
//!
//! This is a Soroban *custom account*: once deployed, its contract address can
//! own meters, pay for energy and hold certificates in the SolarGrid contract
//! exactly like a regular Stellar account. Whenever another contract calls
//! `require_auth()` on the wallet's address, the Soroban host invokes
//! [`MultisigWallet::__check_auth`], which only succeeds when at least
//! `threshold` distinct registered signers have signed the authorization
//! payload.
//!
//! Signers are ed25519 public keys, i.e. the raw keys behind ordinary Stellar
//! `G...` accounts, so each member signs with their existing wallet via
//! SEP-43 `signAuthEntry` (which signs exactly the Soroban authorization
//! payload).
//!
//! Signer-set management (`add_signer`, `remove_signer`, `set_threshold`)
//! authorizes against the wallet itself, so changing the set requires the same
//! N-of-M approval as spending from it.

#![no_std]

use soroban_sdk::{
    auth::{Context, CustomAccountInterface},
    contract, contracterror, contractevent, contractimpl, contracttype,
    crypto::Hash,
    BytesN, Env, Vec,
};

/// Upper bound on the signer set, which bounds the cost of `__check_auth`.
pub const MAX_SIGNERS: u32 = 20;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum WalletError {
    /// Threshold is zero or larger than the number of signers.
    InvalidThreshold = 1,
    /// A public key appears more than once in the signer set.
    DuplicateSigner = 2,
    /// The signer set would exceed [`MAX_SIGNERS`] or become empty.
    InvalidSignerCount = 3,
    /// Fewer valid signatures than the threshold were provided.
    NotEnoughSignatures = 4,
    /// A signature was made by a key that is not a registered signer.
    UnknownSigner = 5,
    /// Signatures must be ordered by strictly increasing public key, which
    /// also rules out counting one signer twice.
    SignaturesNotSorted = 6,
    /// `remove_signer` was called for a key that is not a signer.
    SignerNotFound = 7,
    /// `add_signer` was called for a key that is already a signer.
    SignerAlreadyExists = 8,
}

/// One member's signature over the Soroban authorization payload.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Signature {
    pub public_key: BytesN<32>,
    pub signature: BytesN<64>,
}

/// Emitted whenever the signer set or threshold is configured or changed.
#[contractevent(topics = ["msig_cfg"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SignersUpdated {
    pub signer_count: u32,
    pub threshold: u32,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Signers,
    Threshold,
}

#[contract]
pub struct MultisigWallet;

fn signers(env: &Env) -> Vec<BytesN<32>> {
    env.storage()
        .instance()
        .get(&DataKey::Signers)
        .unwrap_or_else(|| Vec::new(env))
}

fn threshold(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&DataKey::Threshold)
        .unwrap_or(0)
}

fn validate(signers: &Vec<BytesN<32>>, threshold: u32) -> Result<(), WalletError> {
    if signers.is_empty() || signers.len() > MAX_SIGNERS {
        return Err(WalletError::InvalidSignerCount);
    }
    if threshold == 0 || threshold > signers.len() {
        return Err(WalletError::InvalidThreshold);
    }
    for i in 0..signers.len() {
        for j in (i + 1)..signers.len() {
            if signers.get_unchecked(i) == signers.get_unchecked(j) {
                return Err(WalletError::DuplicateSigner);
            }
        }
    }
    Ok(())
}

fn store(env: &Env, signers: &Vec<BytesN<32>>, threshold: u32) {
    env.storage().instance().set(&DataKey::Signers, signers);
    env.storage()
        .instance()
        .set(&DataKey::Threshold, &threshold);
    SignersUpdated {
        signer_count: signers.len(),
        threshold,
    }
    .publish(env);
}

#[contractimpl]
impl MultisigWallet {
    /// Deploy the wallet with its initial signer set and approval threshold.
    pub fn __constructor(
        env: Env,
        signers: Vec<BytesN<32>>,
        threshold: u32,
    ) -> Result<(), WalletError> {
        validate(&signers, threshold)?;
        store(&env, &signers, threshold);
        Ok(())
    }

    pub fn get_signers(env: Env) -> Vec<BytesN<32>> {
        signers(&env)
    }

    pub fn get_threshold(env: Env) -> u32 {
        threshold(&env)
    }

    /// Add a signer. Requires N-of-M approval from the current signers.
    pub fn add_signer(env: Env, signer: BytesN<32>) -> Result<(), WalletError> {
        env.current_contract_address().require_auth();
        let mut set = signers(&env);
        if set.contains(&signer) {
            return Err(WalletError::SignerAlreadyExists);
        }
        set.push_back(signer);
        let t = threshold(&env);
        validate(&set, t)?;
        store(&env, &set, t);
        Ok(())
    }

    /// Remove a signer. Requires N-of-M approval; fails if the remaining set
    /// could no longer reach the threshold.
    pub fn remove_signer(env: Env, signer: BytesN<32>) -> Result<(), WalletError> {
        env.current_contract_address().require_auth();
        let set = signers(&env);
        let mut kept = Vec::new(&env);
        for s in set.iter() {
            if s != signer {
                kept.push_back(s);
            }
        }
        if kept.len() == set.len() {
            return Err(WalletError::SignerNotFound);
        }
        let t = threshold(&env);
        validate(&kept, t)?;
        store(&env, &kept, t);
        Ok(())
    }

    /// Change the approval threshold. Requires N-of-M approval under the
    /// current threshold.
    pub fn set_threshold(env: Env, new_threshold: u32) -> Result<(), WalletError> {
        env.current_contract_address().require_auth();
        let set = signers(&env);
        validate(&set, new_threshold)?;
        store(&env, &set, new_threshold);
        Ok(())
    }
}

#[contractimpl]
impl CustomAccountInterface for MultisigWallet {
    type Signature = Vec<Signature>;
    type Error = WalletError;

    /// Accept the authorization only if at least `threshold` registered
    /// signers produced valid ed25519 signatures over `signature_payload`.
    ///
    /// Signatures must be sorted by strictly increasing public key so the same
    /// signer can never be counted twice. Any invalid signature aborts the
    /// check (the host traps in `ed25519_verify`), so a partially valid set is
    /// never accepted.
    #[allow(non_snake_case)]
    fn __check_auth(
        env: Env,
        signature_payload: Hash<32>,
        signatures: Vec<Signature>,
        _auth_contexts: Vec<Context>,
    ) -> Result<(), WalletError> {
        let required = threshold(&env);
        if signatures.len() < required {
            return Err(WalletError::NotEnoughSignatures);
        }
        let set = signers(&env);
        let payload = signature_payload.to_bytes().into();
        let mut previous: Option<BytesN<32>> = None;
        for sig in signatures.iter() {
            if let Some(prev) = &previous {
                if sig.public_key <= *prev {
                    return Err(WalletError::SignaturesNotSorted);
                }
            }
            if !set.contains(&sig.public_key) {
                return Err(WalletError::UnknownSigner);
            }
            env.crypto()
                .ed25519_verify(&sig.public_key, &payload, &sig.signature);
            previous = Some(sig.public_key);
        }
        Ok(())
    }
}
