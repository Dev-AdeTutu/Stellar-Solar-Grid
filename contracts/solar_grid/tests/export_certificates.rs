//! Energy export certificates (Issue #871).
use solar_grid::{ContractError, SolarGridContract, SolarGridContractClient, MAX_CERTIFICATE_PAGE};
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, AuthorizedFunction, Events, Ledger},
    Address, BytesN, Env, IntoVal, String, Symbol, TryFromVal, Val,
};

struct Setup {
    env: Env,
    client: SolarGridContractClient<'static>,
    admin: Address,
    oracle: Address,
    producer: Address,
    meter: String,
}

fn setup() -> Setup {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|l| l.timestamp = 100_000);
    let admin = Address::generate(&env);
    let token = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    let id = env.register(SolarGridContract, (&admin, &token));
    let client = SolarGridContractClient::new(&env, &id);
    let oracle = Address::generate(&env);
    client.set_oracle(&oracle);
    let producer = Address::generate(&env);
    let meter = String::from_str(&env, "SOLAR-1");
    client.allowlist_add(&producer);
    client.register_meter(&meter, &producer);
    Setup {
        env,
        client,
        admin,
        oracle,
        producer,
        meter,
    }
}

fn hash(env: &Env, seed: u8) -> BytesN<32> {
    BytesN::from_array(env, &[seed; 32])
}

#[test]
fn oracle_mints_certificate_with_full_metadata() {
    let s = setup();
    let id = s.client.mint_export_certificate(
        &s.oracle,
        &s.meter,
        &12_500,
        &10_000,
        &20_000,
        &hash(&s.env, 7),
    );
    assert_eq!(id, 1);

    // Only the issuer's authorization was required.
    let auths = s.env.auths();
    assert_eq!(auths.len(), 1);
    assert_eq!(auths[0].0, s.oracle);
    match &auths[0].1.function {
        AuthorizedFunction::Contract((_, name, _)) => {
            assert_eq!(*name, Symbol::new(&s.env, "mint_export_certificate"))
        }
        other => panic!("unexpected auth {other:?}"),
    }

    let c = s.client.get_export_certificate(&id);
    assert_eq!(c.meter_id, s.meter);
    assert_eq!(c.producer, s.producer);
    assert_eq!(c.owner, s.producer);
    assert_eq!(c.energy_wh, 12_500);
    assert_eq!((c.period_start, c.period_end), (10_000, 20_000));
    assert_eq!(c.issued_at, 100_000);
    assert_eq!(c.issuer, s.oracle);
    assert_eq!(c.reading_hash, hash(&s.env, 7));
    assert_eq!(c.retired_at, None);
    assert_eq!(s.client.get_certificate_count(), 1);
    assert_eq!(s.client.get_last_certified_period_end(&s.meter), 20_000);
}

#[test]
fn mint_emits_event_with_metadata() {
    let s = setup();
    let id = s
        .client
        .mint_export_certificate(&s.admin, &s.meter, &5, &0, &50, &hash(&s.env, 1));
    let events = s.env.events().all();
    let expected_topics: soroban_sdk::Vec<Val> =
        (symbol_short!("solargrid"), symbol_short!("cert_mint"), id).into_val(&s.env);
    let found = events.events().iter().any(|e| {
        let soroban_sdk::xdr::ContractEventBody::V0(v0) = &e.body;
        let topics: soroban_sdk::Vec<Val> = soroban_sdk::Vec::from_iter(
            &s.env,
            v0.topics
                .iter()
                .map(|t| Val::try_from_val(&s.env, t).unwrap()),
        );
        topics == expected_topics
    });
    assert!(found, "cert_mint event not emitted");
}

#[test]
fn admin_can_mint_but_other_addresses_cannot() {
    let s = setup();
    s.client
        .mint_export_certificate(&s.admin, &s.meter, &1, &0, &10, &hash(&s.env, 1));
    let stranger = Address::generate(&s.env);
    assert_eq!(
        s.client
            .try_mint_export_certificate(&stranger, &s.meter, &1, &10, &20, &hash(&s.env, 1)),
        Err(Ok(ContractError::Unauthorized))
    );
    // The producer cannot self-certify either.
    assert_eq!(
        s.client
            .try_mint_export_certificate(&s.producer, &s.meter, &1, &10, &20, &hash(&s.env, 1)),
        Err(Ok(ContractError::Unauthorized))
    );
}

#[test]
fn mint_requires_issuer_signature() {
    let s = setup();
    // Drop the blanket mock: nobody has signed anything.
    s.env.set_auths(&[]);
    assert!(s
        .client
        .try_mint_export_certificate(&s.oracle, &s.meter, &1, &0, &10, &hash(&s.env, 1))
        .is_err());
    assert_eq!(s.client.get_certificate_count(), 0);
}

#[test]
fn rejects_invalid_amounts_periods_and_meters() {
    let s = setup();
    let h = hash(&s.env, 2);
    assert_eq!(
        s.client
            .try_mint_export_certificate(&s.oracle, &s.meter, &0, &0, &10, &h),
        Err(Ok(ContractError::InvalidAmount))
    );
    assert_eq!(
        s.client
            .try_mint_export_certificate(&s.oracle, &s.meter, &1, &10, &10, &h),
        Err(Ok(ContractError::InvalidCertificatePeriod))
    );
    assert_eq!(
        s.client
            .try_mint_export_certificate(&s.oracle, &s.meter, &1, &10, &100_001, &h),
        Err(Ok(ContractError::InvalidCertificatePeriod)),
        "periods cannot end in the future"
    );
    let unknown = String::from_str(&s.env, "NOPE");
    assert_eq!(
        s.client
            .try_mint_export_certificate(&s.oracle, &unknown, &1, &0, &10, &h),
        Err(Ok(ContractError::MeterNotFound))
    );
}

#[test]
fn overlapping_periods_cannot_be_certified_twice() {
    let s = setup();
    let h = hash(&s.env, 3);
    s.client
        .mint_export_certificate(&s.oracle, &s.meter, &100, &1_000, &2_000, &h);
    assert_eq!(
        s.client
            .try_mint_export_certificate(&s.oracle, &s.meter, &100, &1_999, &3_000, &h),
        Err(Ok(ContractError::CertificatePeriodOverlap))
    );
    assert_eq!(
        s.client
            .try_mint_export_certificate(&s.oracle, &s.meter, &100, &1_000, &2_000, &h),
        Err(Ok(ContractError::CertificatePeriodOverlap)),
        "the exact same period is a duplicate"
    );
    // Adjacent periods are fine, and other meters are independent.
    assert_eq!(
        s.client
            .mint_export_certificate(&s.oracle, &s.meter, &100, &2_000, &3_000, &h),
        2
    );
    let other = String::from_str(&s.env, "SOLAR-2");
    s.client.register_meter(&other, &s.producer);
    assert_eq!(
        s.client
            .mint_export_certificate(&s.oracle, &other, &100, &1_000, &2_000, &h),
        3
    );
}

#[test]
fn transfer_moves_ownership_and_indexes() {
    let s = setup();
    let h = hash(&s.env, 4);
    let first = s
        .client
        .mint_export_certificate(&s.oracle, &s.meter, &1, &0, &10, &h);
    let second = s
        .client
        .mint_export_certificate(&s.oracle, &s.meter, &1, &10, &20, &h);
    let buyer = Address::generate(&s.env);

    s.client.transfer_export_certificate(&first, &buyer);
    assert_eq!(
        s.env.auths()[0].0,
        s.producer,
        "holder must sign the transfer"
    );
    assert_eq!(s.client.get_export_certificate(&first).owner, buyer);
    assert_eq!(s.client.get_export_certificate(&first).producer, s.producer);
    assert_eq!(
        s.client.get_certificates_by_owner(&s.producer, &0, &10),
        soroban_sdk::vec![&s.env, second]
    );
    assert_eq!(
        s.client.get_certificates_by_owner(&buyer, &0, &10),
        soroban_sdk::vec![&s.env, first]
    );
    // Self-transfer is a no-op.
    s.client.transfer_export_certificate(&first, &buyer);
    assert_eq!(s.client.get_certificates_by_owner(&buyer, &0, &10).len(), 1);
}

#[test]
fn retired_certificates_are_final() {
    let s = setup();
    let id = s
        .client
        .mint_export_certificate(&s.oracle, &s.meter, &1, &0, &10, &hash(&s.env, 5));
    s.env.ledger().with_mut(|l| l.timestamp = 100_500);
    s.client.retire_export_certificate(&id);
    assert_eq!(
        s.client.get_export_certificate(&id).retired_at,
        Some(100_500)
    );
    assert_eq!(
        s.client.try_retire_export_certificate(&id),
        Err(Ok(ContractError::CertificateRetired))
    );
    assert_eq!(
        s.client
            .try_transfer_export_certificate(&id, &Address::generate(&s.env)),
        Err(Ok(ContractError::CertificateRetired))
    );
    // Retired certificates remain verifiable.
    assert!(s.client.verify_export_certificate(&id, &hash(&s.env, 5)));
}

#[test]
fn verification_checks_existence_and_reading_hash() {
    let s = setup();
    let id = s
        .client
        .mint_export_certificate(&s.oracle, &s.meter, &1, &0, &10, &hash(&s.env, 6));
    assert!(s.client.verify_export_certificate(&id, &hash(&s.env, 6)));
    assert!(!s.client.verify_export_certificate(&id, &hash(&s.env, 9)));
    assert!(!s.client.verify_export_certificate(&99, &hash(&s.env, 6)));
    assert_eq!(
        s.client.try_get_export_certificate(&99).err(),
        Some(Ok(ContractError::CertificateNotFound))
    );
}

#[test]
fn owner_listing_is_paginated_and_capped() {
    let s = setup();
    let h = hash(&s.env, 8);
    for i in 0..5u64 {
        s.client
            .mint_export_certificate(&s.oracle, &s.meter, &1, &(i * 10), &(i * 10 + 10), &h);
    }
    assert_eq!(
        s.client.get_certificates_by_owner(&s.producer, &1, &2),
        soroban_sdk::vec![&s.env, 2u64, 3u64]
    );
    assert_eq!(
        s.client
            .get_certificates_by_owner(&s.producer, &5, &10)
            .len(),
        0
    );
    assert_eq!(
        s.client
            .get_certificates_by_owner(&s.producer, &0, &(MAX_CERTIFICATE_PAGE + 50))
            .len(),
        5
    );
}

#[test]
fn minting_is_blocked_while_paused() {
    let s = setup();
    s.client.pause();
    assert_eq!(
        s.client
            .try_mint_export_certificate(&s.oracle, &s.meter, &1, &0, &10, &hash(&s.env, 1)),
        Err(Ok(ContractError::ContractPaused))
    );
}

#[test]
fn certificates_survive_meter_ownership_transfer() {
    let s = setup();
    let id = s
        .client
        .mint_export_certificate(&s.oracle, &s.meter, &1, &0, &10, &hash(&s.env, 1));
    let new_owner = Address::generate(&s.env);
    s.client.allowlist_add(&new_owner);
    s.client.transfer_meter(&s.meter, &new_owner);
    // Existing certificates stay with whoever holds them; new ones go to the
    // meter's new owner.
    assert_eq!(s.client.get_export_certificate(&id).owner, s.producer);
    let next =
        s.client
            .mint_export_certificate(&s.oracle, &s.meter, &1, &10, &20, &hash(&s.env, 1));
    assert_eq!(s.client.get_export_certificate(&next).producer, new_owner);
}
