mod common;

use common::TestSetup;
use solar_grid::{ClaimStatus, ContractError};
use soroban_sdk::{
    testutils::{Address as _, Events, Ledger},
    Address, String,
};

#[test]
fn purchase_and_file_insurance_claim() {
    let s = TestSetup::new();
    let owner = s.allowlisted_user();
    let provider = Address::generate(&s.env);
    let meter = s.register_meter(&owner, "MTR-INS-1");

    s.mint(&owner, 10_000_000);
    s.env.ledger().set_timestamp(1_000);

    let policy = s.client.purchase_insurance(
        &meter,
        &provider,
        &500_000,
        &5_000_000,
        &86_400,
    );

    assert_eq!(policy.meter_id, meter);
    assert_eq!(policy.provider, provider);
    assert_eq!(policy.premium, 500_000);
    assert_eq!(policy.coverage, 5_000_000);
    assert_eq!(policy.expiry, 87_400);
    assert!(policy.active);
    assert!(s.client.is_meter_insured(&meter));
    assert_eq!(s.token.balance(&provider), 500_000);

    let reason = String::from_str(&s.env, "Lightning strike surge damage");
    let claim_id = s
        .client
        .file_insurance_claim(&meter, &2_000_000, &reason);
    assert_eq!(claim_id, 1);

    let claims = s.client.get_meter_claims(&meter);
    assert_eq!(claims.len(), 1);
    let claim = claims.get(0).unwrap();
    assert_eq!(claim.id, 1);
    assert_eq!(claim.amount, 2_000_000);
    assert_eq!(claim.status, ClaimStatus::Pending);
}

#[test]
fn insurance_rejects_expired_or_excessive_claims() {
    let s = TestSetup::new();
    let owner = s.allowlisted_user();
    let provider = Address::generate(&s.env);
    let meter = s.register_meter(&owner, "MTR-INS-2");

    s.mint(&owner, 10_000_000);
    s.env.ledger().set_timestamp(1_000);

    s.client
        .purchase_insurance(&meter, &provider, &250_000, &1_000_000, &3_600);

    // Exceeds coverage
    let err = s
        .client
        .try_file_insurance_claim(
            &meter,
            &2_000_000,
            &String::from_str(&s.env, "Theft"),
        )
        .unwrap_err()
        .unwrap();
    assert_eq!(err, ContractError::ClaimExceedsCoverage);

    // Advance past expiry
    s.env.ledger().set_timestamp(5_000);
    assert!(!s.client.is_meter_insured(&meter));

    let exp_err = s
        .client
        .try_file_insurance_claim(
            &meter,
            &500_000,
            &String::from_str(&s.env, "Accidental damage"),
        )
        .unwrap_err()
        .unwrap();
    assert_eq!(exp_err, ContractError::InsurancePolicyExpired);
}
