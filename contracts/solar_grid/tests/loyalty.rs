mod common;

use common::TestSetup;
use solar_grid::{ContractError, LoyaltyTier};
use soroban_sdk::{
    testutils::Address as _,
    Address,
};

#[test]
fn test_loyalty_account_creation_and_tiers() {
    let s = TestSetup::new();
    let user = Address::generate(&s.env);

    // Initial account should be bronze with 0 points
    let account = s.client.get_loyalty_account(&user);
    assert_eq!(account.points, 0);
    assert_eq!(account.tier, LoyaltyTier::Bronze);
    assert_eq!(account.total_earned, 0);
    assert_eq!(account.total_redeemed, 0);
    assert_eq!(s.client.get_loyalty_discount(&user), 0);

    // Add 400 points -> Bronze
    let acc1 = s.client.add_loyalty_points(&user, &400);
    assert_eq!(acc1.points, 400);
    assert_eq!(acc1.tier, LoyaltyTier::Bronze);
    assert_eq!(s.client.get_loyalty_discount(&user), 0);

    // Add 200 more points -> 600 points -> Silver (5% discount)
    let acc2 = s.client.add_loyalty_points(&user, &200);
    assert_eq!(acc2.points, 600);
    assert_eq!(acc2.tier, LoyaltyTier::Silver);
    assert_eq!(s.client.get_loyalty_discount(&user), 5);

    // Add 1500 more points -> 2100 points -> Gold (10% discount)
    let acc3 = s.client.add_loyalty_points(&user, &1500);
    assert_eq!(acc3.points, 2100);
    assert_eq!(acc3.tier, LoyaltyTier::Gold);
    assert_eq!(s.client.get_loyalty_discount(&user), 10);
}

#[test]
fn test_loyalty_earn_points_on_payment() {
    let s = TestSetup::new();
    let user = Address::generate(&s.env);

    // 50 XLM payment = 50 * 10_000_000 stroops = 500_000_000 stroops -> 50 points
    let acc = s.client.earn_points_on_payment(&user, &500_000_000);
    assert_eq!(acc.points, 50);
    assert_eq!(acc.total_earned, 50);

    // Rejects non-positive payments
    let err = s.client.try_earn_points_on_payment(&user, &0).unwrap_err().unwrap();
    assert_eq!(err, ContractError::InvalidAmount);
}

#[test]
fn test_loyalty_redeem_points() {
    let s = TestSetup::new();
    let user = Address::generate(&s.env);

    s.client.add_loyalty_points(&user, &1000);
    let before = s.client.get_loyalty_account(&user);
    assert_eq!(before.points, 1000);
    assert_eq!(before.tier, LoyaltyTier::Silver);

    // Redeem 300 points
    let after = s.client.redeem_points(&user, &300);
    assert_eq!(after.points, 700);
    assert_eq!(after.total_redeemed, 300);
    assert_eq!(after.tier, LoyaltyTier::Silver);

    // Redeem remaining 700 points -> drops to Bronze
    let zero = s.client.redeem_points(&user, &700);
    assert_eq!(zero.points, 0);
    assert_eq!(zero.total_redeemed, 1000);
    assert_eq!(zero.tier, LoyaltyTier::Bronze);

    // Redeeming more than balance fails
    let err = s.client.try_redeem_points(&user, &50).unwrap_err().unwrap();
    assert_eq!(err, ContractError::InsufficientLoyaltyPoints);

    // Redeeming 0 fails
    let err_zero = s.client.try_redeem_points(&user, &0).unwrap_err().unwrap();
    assert_eq!(err_zero, ContractError::InvalidLoyaltyPoints);
}
