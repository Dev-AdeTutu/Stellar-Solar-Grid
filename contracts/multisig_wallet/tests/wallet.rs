//! Multi-signature wallet tests (Issue #872).
//!
//! `__check_auth` is exercised directly with real ed25519 signatures, and end
//! to end through the SolarGrid contract with signed authorization entries
//! (no auth mocking) to show that a wallet-owned meter only moves with N-of-M
//! approval.
use ed25519_dalek::{Signer, SigningKey};
use multisig_wallet::{MultisigWallet, MultisigWalletClient, Signature, WalletError, MAX_SIGNERS};
use solar_grid::{SolarGridContract, SolarGridContractClient};
use soroban_sdk::{
    auth::Context,
    testutils::{Address as _, BytesN as _, Ledger},
    vec,
    xdr::{
        HashIdPreimage, HashIdPreimageSorobanAuthorization, InvokeContractArgs, Limits, ScAddress,
        ScSymbol, ScVal, SorobanAddressCredentials, SorobanAuthorizationEntry,
        SorobanAuthorizedFunction, SorobanAuthorizedInvocation, SorobanCredentials, VecM, WriteXdr,
    },
    Address, Bytes, BytesN, Env, IntoVal, String, TryFromVal, Val, Vec,
};

fn key(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}

fn public(env: &Env, k: &SigningKey) -> BytesN<32> {
    BytesN::from_array(env, &k.verifying_key().to_bytes())
}

/// Signatures from `keys` over `payload`, sorted by public key as required.
fn sign(env: &Env, payload: &[u8; 32], keys: &[&SigningKey]) -> Vec<Signature> {
    let mut sigs: std::vec::Vec<Signature> = keys
        .iter()
        .map(|k| Signature {
            public_key: public(env, k),
            signature: BytesN::from_array(env, &k.sign(payload).to_bytes()),
        })
        .collect();
    sigs.sort_by(|a, b| a.public_key.cmp(&b.public_key));
    Vec::from_iter(env, sigs)
}

fn deploy(
    env: &Env,
    keys: &[&SigningKey],
    threshold: u32,
) -> (Address, MultisigWalletClient<'static>) {
    let signers = Vec::from_iter(env, keys.iter().map(|k| public(env, k)));
    let id = env.register(MultisigWallet, (signers, threshold));
    (id.clone(), MultisigWalletClient::new(env, &id))
}

fn check(
    env: &Env,
    wallet: &Address,
    payload: &BytesN<32>,
    sigs: Vec<Signature>,
) -> Result<(), Result<WalletError, soroban_sdk::InvokeError>> {
    env.try_invoke_contract_check_auth::<WalletError>(
        wallet,
        payload,
        sigs.into_val(env),
        &Vec::<Context>::new(env),
    )
}

// ── Construction and configuration ───────────────────────────────────────────

#[test]
fn constructor_stores_signers_and_threshold() {
    let env = Env::default();
    let (a, b, c) = (key(1), key(2), key(3));
    let (_, wallet) = deploy(&env, &[&a, &b, &c], 2);
    assert_eq!(wallet.get_threshold(), 2);
    assert_eq!(
        wallet.get_signers(),
        vec![&env, public(&env, &a), public(&env, &b), public(&env, &c)]
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn constructor_rejects_threshold_above_signer_count() {
    let env = Env::default();
    deploy(&env, &[&key(1), &key(2)], 3);
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn constructor_rejects_zero_threshold() {
    let env = Env::default();
    deploy(&env, &[&key(1)], 0);
}

#[test]
#[should_panic(expected = "Error(Contract, #2)")]
fn constructor_rejects_duplicate_signers() {
    let env = Env::default();
    deploy(&env, &[&key(1), &key(1)], 1);
}

#[test]
#[should_panic(expected = "Error(Contract, #3)")]
fn constructor_rejects_oversized_signer_set() {
    let env = Env::default();
    let keys: std::vec::Vec<SigningKey> = (1..=(MAX_SIGNERS as u8 + 1)).map(key).collect();
    let refs: std::vec::Vec<&SigningKey> = keys.iter().collect();
    deploy(&env, &refs, 1);
}

// ── __check_auth ─────────────────────────────────────────────────────────────

#[test]
fn threshold_signatures_are_accepted() {
    let env = Env::default();
    let (a, b, c) = (key(1), key(2), key(3));
    let (wallet, _) = deploy(&env, &[&a, &b, &c], 2);
    let payload = BytesN::<32>::random(&env);
    let raw = payload.to_array();

    assert_eq!(
        check(&env, &wallet, &payload, sign(&env, &raw, &[&a, &b])),
        Ok(())
    );
    assert_eq!(
        check(&env, &wallet, &payload, sign(&env, &raw, &[&b, &c])),
        Ok(())
    );
    assert_eq!(
        check(&env, &wallet, &payload, sign(&env, &raw, &[&a, &b, &c])),
        Ok(())
    );
}

#[test]
fn fewer_than_threshold_signatures_are_rejected() {
    let env = Env::default();
    let (a, b, c) = (key(1), key(2), key(3));
    let (wallet, _) = deploy(&env, &[&a, &b, &c], 2);
    let payload = BytesN::<32>::random(&env);
    assert_eq!(
        check(
            &env,
            &wallet,
            &payload,
            sign(&env, &payload.to_array(), &[&a])
        ),
        Err(Ok(WalletError::NotEnoughSignatures))
    );
    assert_eq!(
        check(&env, &wallet, &payload, Vec::new(&env)),
        Err(Ok(WalletError::NotEnoughSignatures))
    );
}

#[test]
fn the_same_signer_cannot_be_counted_twice() {
    let env = Env::default();
    let (a, b) = (key(1), key(2));
    let (wallet, _) = deploy(&env, &[&a, &b], 2);
    let payload = BytesN::<32>::random(&env);
    let one = sign(&env, &payload.to_array(), &[&a]).get(0).unwrap();
    assert_eq!(
        check(&env, &wallet, &payload, vec![&env, one.clone(), one]),
        Err(Ok(WalletError::SignaturesNotSorted))
    );
}

#[test]
fn unsorted_signatures_are_rejected() {
    let env = Env::default();
    let (a, b) = (key(1), key(2));
    let (wallet, _) = deploy(&env, &[&a, &b], 2);
    let payload = BytesN::<32>::random(&env);
    let sorted = sign(&env, &payload.to_array(), &[&a, &b]);
    let reversed = vec![&env, sorted.get(1).unwrap(), sorted.get(0).unwrap()];
    assert_eq!(
        check(&env, &wallet, &payload, reversed),
        Err(Ok(WalletError::SignaturesNotSorted))
    );
}

#[test]
fn signatures_from_outsiders_are_rejected() {
    let env = Env::default();
    let (a, b, outsider) = (key(1), key(2), key(9));
    let (wallet, _) = deploy(&env, &[&a, &b], 2);
    let payload = BytesN::<32>::random(&env);
    assert_eq!(
        check(
            &env,
            &wallet,
            &payload,
            sign(&env, &payload.to_array(), &[&a, &outsider])
        ),
        Err(Ok(WalletError::UnknownSigner))
    );
}

#[test]
fn a_signature_over_a_different_payload_is_rejected() {
    let env = Env::default();
    let (a, b) = (key(1), key(2));
    let (wallet, _) = deploy(&env, &[&a, &b], 2);
    let payload = BytesN::<32>::random(&env);
    let other = BytesN::<32>::random(&env);
    // `a` signs the real payload, `b` signed something else: the host's
    // ed25519 check traps, so the whole authorization fails.
    let mut sigs = std::vec![
        sign(&env, &payload.to_array(), &[&a]).get(0).unwrap(),
        sign(&env, &other.to_array(), &[&b]).get(0).unwrap(),
    ];
    sigs.sort_by(|x, y| x.public_key.cmp(&y.public_key));
    assert!(check(&env, &wallet, &payload, Vec::from_iter(&env, sigs)).is_err());
}

// ── Signer management requires the wallet's own N-of-M auth ──────────────────

#[test]
fn signer_management_requires_wallet_authorization() {
    let env = Env::default();
    let (a, b) = (key(1), key(2));
    let (_, wallet) = deploy(&env, &[&a, &b], 2);
    // No authorization provided at all.
    assert!(wallet.try_set_threshold(&1).is_err());
    assert!(wallet.try_add_signer(&public(&env, &key(3))).is_err());
    assert_eq!(wallet.get_threshold(), 2);
}

#[test]
fn signer_management_rules() {
    let env = Env::default();
    env.mock_all_auths();
    let (a, b, c) = (key(1), key(2), key(3));
    let (_, wallet) = deploy(&env, &[&a, &b], 2);

    wallet.add_signer(&public(&env, &c));
    assert_eq!(wallet.get_signers().len(), 3);
    assert_eq!(
        wallet.try_add_signer(&public(&env, &c)),
        Err(Ok(WalletError::SignerAlreadyExists))
    );

    wallet.set_threshold(&3);
    assert_eq!(wallet.get_threshold(), 3);
    // Removing a signer would leave 2 signers under a threshold of 3.
    assert_eq!(
        wallet.try_remove_signer(&public(&env, &c)),
        Err(Ok(WalletError::InvalidThreshold))
    );
    wallet.set_threshold(&2);
    wallet.remove_signer(&public(&env, &c));
    assert_eq!(
        wallet.get_signers(),
        vec![&env, public(&env, &a), public(&env, &b)]
    );
    assert_eq!(
        wallet.try_remove_signer(&public(&env, &c)),
        Err(Ok(WalletError::SignerNotFound))
    );
    assert_eq!(
        wallet.try_set_threshold(&0),
        Err(Ok(WalletError::InvalidThreshold))
    );
}

// ── End to end with the SolarGrid contract ───────────────────────────────────

struct Grid {
    env: Env,
    grid: SolarGridContractClient<'static>,
    wallet: Address,
    meter: String,
}

/// A 2-of-3 organizational wallet registered as a meter owner.
fn grid_with_wallet(keys: &[&SigningKey]) -> Grid {
    let env = Env::default();
    env.ledger().with_mut(|l| l.sequence_number = 100);
    let admin = Address::generate(&env);
    let token = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    let grid_id = env.register(SolarGridContract, (&admin, &token));
    let grid = SolarGridContractClient::new(&env, &grid_id);
    let (wallet, _) = deploy(&env, keys, 2);
    let meter = String::from_str(&env, "ORG-METER");

    // Admin setup is mocked; only the wallet-authorized call below is real.
    env.mock_all_auths();
    grid.allowlist_add(&wallet);
    grid.register_meter(&meter, &wallet);
    Grid {
        env,
        grid,
        wallet,
        meter,
    }
}

/// Build a signed authorization entry for `wallet` invoking `function(args)`
/// on the grid contract, signed by `keys`.
fn signed_entry(
    g: &Grid,
    nonce: i64,
    function: &str,
    args: std::vec::Vec<Val>,
    keys: &[&SigningKey],
) -> SorobanAuthorizationEntry {
    let env = &g.env;
    let expiration = env.ledger().sequence() + 100;
    let xdr_args: std::vec::Vec<ScVal> = args
        .iter()
        .map(|v| ScVal::try_from_val(env, v).unwrap())
        .collect();
    let invocation = SorobanAuthorizedInvocation {
        function: SorobanAuthorizedFunction::ContractFn(InvokeContractArgs {
            contract_address: ScAddress::from(&g.grid.address),
            function_name: ScSymbol(function.try_into().unwrap()),
            args: xdr_args.try_into().unwrap(),
        }),
        sub_invocations: VecM::default(),
    };
    let preimage = HashIdPreimage::SorobanAuthorization(HashIdPreimageSorobanAuthorization {
        network_id: env.ledger().network_id().to_array().into(),
        nonce,
        signature_expiration_ledger: expiration,
        invocation: invocation.clone(),
    });
    let preimage_xdr = preimage.to_xdr(Limits::none()).unwrap();
    let payload = env
        .crypto()
        .sha256(&Bytes::from_slice(env, &preimage_xdr))
        .to_array();
    let signatures: Val = sign(env, &payload, keys).into_val(env);
    SorobanAuthorizationEntry {
        credentials: SorobanCredentials::Address(SorobanAddressCredentials {
            address: ScAddress::from(&g.wallet),
            nonce,
            signature_expiration_ledger: expiration,
            signature: ScVal::try_from_val(env, &signatures).unwrap(),
        }),
        root_invocation: invocation,
    }
}

#[test]
fn wallet_can_register_as_meter_owner() {
    let (a, b, c) = (key(1), key(2), key(3));
    let g = grid_with_wallet(&[&a, &b, &c]);
    assert_eq!(g.grid.get_meter(&g.meter).owner, g.wallet);
    assert_eq!(
        g.grid.get_meters_by_owner(&g.wallet),
        vec![&g.env, g.meter.clone()]
    );
}

#[test]
fn owner_action_succeeds_with_two_of_three_signatures() {
    let (a, b, c) = (key(1), key(2), key(3));
    let g = grid_with_wallet(&[&a, &b, &c]);
    let contact = Address::generate(&g.env);
    let args = std::vec![
        g.meter.clone().into_val(&g.env),
        Some(contact.clone()).into_val(&g.env)
    ];

    g.env.set_auths(&[signed_entry(
        &g,
        1,
        "set_emergency_contact",
        args,
        &[&a, &c],
    )]);
    g.grid
        .set_emergency_contact(&g.meter, &Some(contact.clone()));
    assert_eq!(g.grid.get_emergency_contact(&g.meter), Some(contact));
}

#[test]
fn owner_action_fails_with_one_of_three_signatures() {
    let (a, b, c) = (key(1), key(2), key(3));
    let g = grid_with_wallet(&[&a, &b, &c]);
    let contact = Address::generate(&g.env);
    let args = std::vec![
        g.meter.clone().into_val(&g.env),
        Some(contact.clone()).into_val(&g.env)
    ];

    g.env
        .set_auths(&[signed_entry(&g, 1, "set_emergency_contact", args, &[&b])]);
    assert!(g
        .grid
        .try_set_emergency_contact(&g.meter, &Some(contact))
        .is_err());
    assert_eq!(g.grid.get_emergency_contact(&g.meter), None);
}

#[test]
fn signatures_are_bound_to_the_exact_invocation() {
    let (a, b, c) = (key(1), key(2), key(3));
    let g = grid_with_wallet(&[&a, &b, &c]);
    let approved = Address::generate(&g.env);
    let attacker = Address::generate(&g.env);
    let args = std::vec![
        g.meter.clone().into_val(&g.env),
        Some(approved).into_val(&g.env)
    ];

    // Valid 2-of-3 approval for one contact cannot be replayed for another.
    g.env.set_auths(&[signed_entry(
        &g,
        1,
        "set_emergency_contact",
        args,
        &[&a, &b],
    )]);
    assert!(g
        .grid
        .try_set_emergency_contact(&g.meter, &Some(attacker))
        .is_err());
}

#[test]
fn outsiders_cannot_authorize_for_the_wallet() {
    let (a, b, c) = (key(1), key(2), key(3));
    let g = grid_with_wallet(&[&a, &b, &c]);
    let args = std::vec![
        g.meter.clone().into_val(&g.env),
        None::<Address>.into_val(&g.env)
    ];
    g.env.set_auths(&[signed_entry(
        &g,
        1,
        "set_emergency_contact",
        args,
        &[&a, &key(42)],
    )]);
    assert!(g.grid.try_set_emergency_contact(&g.meter, &None).is_err());
}
