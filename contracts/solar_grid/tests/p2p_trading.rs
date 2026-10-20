mod common;

use common::TestSetup;
use solar_grid::ContractError;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    Address,
};

#[test]
fn test_list_and_buy_energy_p2p() {
    let s = TestSetup::new();
    let seller = Address::generate(&s.env);
    let buyer = Address::generate(&s.env);

    s.mint(&buyer, 100_000_000);
    s.env.ledger().set_timestamp(1_000);

    // List 100 kWh for sale at 50 stroops per kWh
    let listing_id = s.client.list_energy_for_sale(&seller, &100, &50);
    assert_eq!(listing_id, 1);

    let listing = s.client.get_energy_listing(&listing_id);
    assert_eq!(listing.seller, seller);
    assert_eq!(listing.kwh_available, 100);
    assert_eq!(listing.price_per_kwh, 50);
    assert!(listing.active);

    // Buy 40 kWh
    let cost = s.client.buy_energy_from_peer(&buyer, &listing_id, &40);
    assert_eq!(cost, 2_000); // 40 * 50 = 2000
    assert_eq!(s.token.balance(&seller), 2_000);

    let updated = s.client.get_energy_listing(&listing_id);
    assert_eq!(updated.kwh_available, 60);
    assert!(updated.active);

    // Buy remaining 60 kWh -> listing becomes inactive
    let remaining_cost = s.client.buy_energy_from_peer(&buyer, &listing_id, &60);
    assert_eq!(remaining_cost, 3_000);
    assert_eq!(s.token.balance(&seller), 5_000);

    let final_listing = s.client.get_energy_listing(&listing_id);
    assert_eq!(final_listing.kwh_available, 0);
    assert!(!final_listing.active);

    // Cannot buy from completed listing
    let err = s.client.try_buy_energy_from_peer(&buyer, &listing_id, &10).unwrap_err().unwrap();
    assert_eq!(err, ContractError::EnergyListingInactive);
}

#[test]
fn test_order_matching_and_cancellation() {
    let s = TestSetup::new();
    let seller1 = Address::generate(&s.env);
    let seller2 = Address::generate(&s.env);
    let buyer = Address::generate(&s.env);

    s.mint(&buyer, 100_000_000);
    s.env.ledger().set_timestamp(1_000);

    // Seller 1 lists at 100 stroops/kWh
    let id1 = s.client.list_energy_for_sale(&seller1, &50, &100);
    // Seller 2 lists cheaper at 80 stroops/kWh
    let id2 = s.client.list_energy_for_sale(&seller2, &50, &80);

    // Match order should pick seller 2 (cheapest price 80)
    let total = s.client.match_and_buy_energy(&buyer, &20, &120);
    assert_eq!(total, 1_600); // 20 * 80
    assert_eq!(s.token.balance(&seller2), 1_600);

    // Cancel listing 1
    s.client.cancel_energy_listing(&seller1, &id1);
    let listing1 = s.client.get_energy_listing(&id1);
    assert!(!listing1.active);

    let active_list = s.client.get_active_energy_listings(&0, &10);
    assert_eq!(active_list.len(), 1);
    assert_eq!(active_list.get(0).unwrap().listing_id, id2);
}
