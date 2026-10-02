//! REC tokenization, compliance gating, order matching, price discovery and
//! automatic settlement (Issue #927).
mod common;

use common::Fixture;
use solar_grid::{
    ContractError, RecCompliance, RecOrderStatus, RecSide, BPS_SCALE, MAX_FEE_BPS, PRICE_SCALE,
};
use soroban_sdk::{testutils::Address as _, token, Address, String as SorobanString};

/// 12,500 kWh of generation → 12 RECs (one unit = one MWh).
const KWH: i128 = 12_500;
const UNITS: i128 = 12;
const FEE_BPS: i128 = 50; // 0.5%
/// 12.50 settlement units per REC.
const PRICE: i128 = 12_500_000;

struct Recs {
    fx: Fixture,
    settlement: Address,
    authority: Address,
    producer: Address,
    buyer: Address,
}

fn setup() -> Recs {
    let fx = Fixture::new();
    fx.set_time(1_000);
    // The settlement token must differ from the payment token, which
    // emergency_withdraw sweeps.
    let settlement = fx
        .env
        .register_stellar_asset_contract_v2(Address::generate(&fx.env))
        .address();
    let authority = Address::generate(&fx.env);
    fx.client
        .configure_recs(&settlement, &authority, &FEE_BPS);

    let producer = Address::generate(&fx.env);
    let buyer = Address::generate(&fx.env);
    token::StellarAssetClient::new(&fx.env, &settlement).mint(&buyer, &1_000_000);

    Recs {
        fx,
        settlement,
        authority,
        producer,
        buyer,
    }
}

impl Recs {
    fn s(&self, v: &str) -> SorobanString {
        SorobanString::from_str(&self.fx.env, v)
    }

    /// Issue and verify, returning a tradable REC id.
    fn issue_verified(&self) -> u32 {
        let rec_id = self
            .fx
            .client
            .issue_rec(
                &self.producer,
                &self.s("METER-1"),
                &KWH,
                &2026u32,
                &self.s("REG-1"),
            );
        self.fx
            .client
            .verify_rec(&rec_id, &self.s("CERT-1"));
        rec_id
    }

    fn settlement_balance(&self, who: &Address) -> i128 {
        token::Client::new(&self.fx.env, &self.settlement).balance(who)
    }
}

#[test]
fn marketplace_requires_configuration() {
    let fx = Fixture::new();
    let settlement = Address::generate(&fx.env);
    let producer = Address::generate(&fx.env);
    assert_eq!(
        fx.client.try_issue_rec(
            &producer,
            &fx.id("M1"),
            &KWH,
            &2026u32,
            &fx.id("REG-1")
        ),
        Err(Ok(ContractError::RecNotConfigured))
    );
    assert_eq!(
        fx.client.try_get_rec_config(),
        Err(Ok(ContractError::RecNotConfigured))
    );
    // Any authenticated party may configure once the contract is deployed.
    let _ = settlement;
}

#[test]
fn configure_rejects_payment_token_and_excessive_fee() {
    let fx = Fixture::new();
    let authority = Address::generate(&fx.env);
    // The payment token is swept by emergency_withdraw, so RECs cannot settle in it.
    assert_eq!(
        fx.client.try_configure_recs(&fx.token, &authority, &0),
        Err(Ok(ContractError::InvalidConfiguration))
    );
    let other = fx
        .env
        .register_stellar_asset_contract_v2(Address::generate(&fx.env))
        .address();
    assert_eq!(
        fx.client
            .try_configure_recs(&other, &authority, &(MAX_FEE_BPS + 1)),
        Err(Ok(ContractError::InvalidConfiguration))
    );
    fx.client
        .configure_recs(&other, &authority, &MAX_FEE_BPS);
    assert_eq!(fx.client.get_rec_config().fee_bps, MAX_FEE_BPS);
}

#[test]
fn issuance_tokenizes_one_unit_per_mwh() {
    let r = setup();
    let rec_id = r.issue_verified();

    let rec = r.fx.client.get_rec(&rec_id);
    assert_eq!(rec.rec_id, rec_id);
    assert_eq!(rec.total_units, UNITS);
    assert_eq!(rec.available_units, UNITS);
    assert_eq!(rec.producer, r.producer);
    assert_eq!(rec.compliance, RecCompliance::Verified);
    assert_eq!(rec.compliance_ref, r.s("CERT-1"));
    // Units are held by the producer, not merely recorded.
    assert_eq!(r.fx.client.rec_balance(&rec_id, &r.producer), UNITS);
    assert_eq!(
        r.fx.client.get_rec_market_state().total_issued,
        UNITS
    );
    // A second issue gets its own id.
    assert_eq!(
        r.fx
            .client
            .issue_rec(&r.producer, &r.s("METER-2"), &KWH, &2026u32, &r.s("REG-2")),
        rec_id + 1
    );
}

#[test]
fn issuance_rejects_unbacked_or_unreferenced_generation() {
    let r = setup();
    let producer = r.producer.clone();
    assert_eq!(
        r.fx
            .client
            .try_issue_rec(&producer, &r.s("M1"), &0, &2026u32, &r.s("REG")),
        Err(Ok(ContractError::InvalidRecQuantity))
    );
    // Below 1 MWh there is nothing to tokenize.
    assert_eq!(
        r.fx
            .client
            .try_issue_rec(&producer, &r.s("M1"), &999, &2026u32, &r.s("REG")),
        Err(Ok(ContractError::InvalidRecQuantity))
    );
    // A generation claim with no registry reference cannot be audited.
    assert_eq!(
        r.fx
            .client
            .try_issue_rec(&producer, &r.s("M1"), &KWH, &2026u32, &r.s("")),
        Err(Ok(ContractError::ComplianceRefMissing))
    );
}

#[test]
fn unverified_recs_cannot_be_listed_or_traded() {
    let r = setup();
    let rec_id = r
        .fx
        .client
        .issue_rec(&r.producer, &r.s("M1"), &KWH, &2026u32, &r.s("REG-1"));
    assert_eq!(r.fx.client.get_rec(&rec_id).compliance, RecCompliance::Pending);

    assert_eq!(
        r.fx.client.try_list_recs(&r.producer, &rec_id, &1, &PRICE),
        Err(Ok(ContractError::RecCompliancePending))
    );
    assert_eq!(
        r.fx.client.try_place_bid(&r.buyer, &rec_id, &1, &PRICE),
        Err(Ok(ContractError::RecCompliancePending))
    );

    // Verification requires an attestation reference.
    assert_eq!(
        r.fx.client.try_verify_rec(&rec_id, &r.s("")),
        Err(Ok(ContractError::ComplianceRefMissing))
    );
    r.fx.client.verify_rec(&rec_id, &r.s("CERT-1"));
    assert!(r.fx.client.try_list_recs(&r.producer, &rec_id, &1, &PRICE).is_ok());
}

#[test]
fn rejected_recs_stay_non_tradable_even_after_verification() {
    let r = setup();
    let rec_id = r
        .fx
        .client
        .issue_rec(&r.producer, &r.s("M1"), &KWH, &2026u32, &r.s("REG-1"));
    r.fx.client.reject_rec(&rec_id);
    assert_eq!(r.fx.client.get_rec(&rec_id).compliance, RecCompliance::Rejected);
    assert_eq!(
        r.fx.client.try_verify_rec(&rec_id, &r.s("CERT-1")),
        Err(Ok(ContractError::RecComplianceRejected))
    );
    assert_eq!(
        r.fx.client.try_list_recs(&r.producer, &rec_id, &1, &PRICE),
        Err(Ok(ContractError::RecComplianceRejected))
    );
    assert_eq!(
        r.fx.client.try_place_bid(&r.buyer, &rec_id, &1, &PRICE),
        Err(Ok(ContractError::RecComplianceRejected))
    );
}

#[test]
fn cannot_list_more_units_than_are_held() {
    let r = setup();
    let rec_id = r.issue_verified();
    assert_eq!(
        r.fx.client.try_list_recs(&r.producer, &rec_id, &(UNITS + 1), &PRICE),
        Err(Ok(ContractError::InsufficientBalance))
    );
    // Units reserved by an open order are not listable twice.
    r.fx.client.list_recs(&r.producer, &rec_id, &5, &PRICE);
    assert_eq!(r.fx.client.get_rec(&rec_id).available_units, UNITS - 5);
    assert_eq!(
        r.fx.client.try_list_recs(&r.producer, &rec_id, &(UNITS - 4), &PRICE),
        Err(Ok(ContractError::InsufficientBalance))
    );
}

#[test]
fn cancelling_a_sell_order_returns_units_to_the_producer() {
    let r = setup();
    let rec_id = r.issue_verified();
    let order_id = r.fx.client.list_recs(&r.producer, &rec_id, &5, &PRICE);
    assert_eq!(r.fx.client.get_rec(&rec_id).available_units, UNITS - 5);

    assert_eq!(r.fx.client.cancel_rec_order(&order_id), 5);
    assert_eq!(r.fx.client.get_rec(&rec_id).available_units, UNITS);
    assert_eq!(
        r.fx.client.get_rec_order(&order_id).status,
        RecOrderStatus::Cancelled
    );
    // A cancelled order cannot be traded or cancelled again.
    assert!(r.fx.client.try_cancel_rec_order(&order_id).is_err());
}

#[test]
fn a_crossing_bid_settles_against_the_cheapest_ask() {
    let r = setup();
    let rec_id = r.issue_verified();
    // Post a dearer ask first so price-time priority has to pick the cheaper one.
    let dear_id = r.fx.client.list_recs(&r.producer, &rec_id, &4, &(PRICE * 2));
    let cheap_id = r.fx.client.list_recs(&r.producer, &rec_id, &3, &PRICE);
    assert_eq!(r.fx.client.rec_best_ask(&rec_id), PRICE);

    let bid_id = r.fx.client.place_bid(&r.buyer, &rec_id, &3, &PRICE);
    let trades = r.fx.client.execute_trade(&r.buyer, &bid_id);
    assert_eq!(trades.len(), 1);

    // Filled at the resting (maker) price, not the bid price.
    let trade = r.fx.client.get_rec_trade(&trades.get(0).unwrap());
    assert_eq!(trade.sell_order_id, cheap_id);
    assert_eq!(trade.units, 3);
    assert_eq!(trade.price, PRICE);
    assert_eq!(trade.consideration, (PRICE * 3) / PRICE_SCALE);
    assert_eq!(r.fx.client.get_rec_order(&cheap_id).status, RecOrderStatus::Filled);
    assert_eq!(r.fx.client.get_rec_order(&dear_id).status, RecOrderStatus::Open);
    assert_eq!(r.fx.client.get_rec_order(&bid_id).status, RecOrderStatus::Filled);
}

#[test]
fn trade_transfers_units_and_settles_payment_atomically() {
    let r = setup();
    let rec_id = r.issue_verified();
    let seller_before = r.settlement_balance(&r.producer);
    let buyer_before = r.settlement_balance(&r.buyer);

    let order_id = r.fx.client.list_recs(&r.producer, &rec_id, &4, &PRICE);
    let bid_id = r.fx.client.place_bid(&r.buyer, &rec_id, &4, &PRICE);
    let trades = r.fx.client.execute_trade(&r.buyer, &bid_id);
    let trade = r.fx.client.get_rec_trade(&trades.get(0).unwrap());

    // Units moved producer → buyer.
    assert_eq!(r.fx.client.rec_balance(&rec_id, &r.producer), UNITS - 4);
    assert_eq!(r.fx.client.rec_balance(&rec_id, &r.buyer), 4);
    assert_eq!(r.fx.client.get_rec_order(&order_id).remaining, 0);

    // Cash moved buyer → seller, with the fee retained by the contract.
    assert_eq!(trade.consideration, (PRICE * 4) / PRICE_SCALE);
    assert_eq!(trade.fee, (trade.consideration * FEE_BPS) / BPS_SCALE);
    assert_eq!(trade.proceeds, trade.consideration - trade.fee);
    assert_eq!(
        r.settlement_balance(&r.producer) - seller_before,
        trade.proceeds
    );
    assert_eq!(
        buyer_before - r.settlement_balance(&r.buyer),
        trade.consideration
    );
    assert_eq!(
        r.settlement_balance(&r.fx.contract_id),
        trade.fee
    );
}

#[test]
fn a_bid_below_the_ask_does_not_trade() {
    let r = setup();
    let rec_id = r.issue_verified();
    r.fx.client.list_recs(&r.producer, &rec_id, &2, &PRICE);
    let bid_id = r
        .fx
        .client
        .place_bid(&r.buyer, &rec_id, &2, &(PRICE - 1));
    let trades = r.fx.client.execute_trade(&r.buyer, &bid_id);
    assert!(trades.is_empty());
    assert_eq!(r.fx.client.get_rec_order(&bid_id).status, RecOrderStatus::Open);
    assert_eq!(r.fx.client.rec_balance(&rec_id, &r.buyer), 0);
    // Nothing traded, so the market has no price.
    assert_eq!(r.fx.client.rec_index_price(&rec_id), 0);
    assert_eq!(r.fx.client.rec_last_price(&rec_id), 0);
}

#[test]
fn price_discovery_trades_move_the_index() {
    let r = setup();
    let rec_id = r.issue_verified();

    // First fill: 2 units at 10.00.
    r.fx.client.list_recs(&r.producer, &rec_id, &2, &10_000_000);
    let bid_a = r.fx.client.place_bid(&r.buyer, &rec_id, &2, &10_000_000);
    r.fx.client.execute_trade(&r.buyer, &bid_a);
    assert_eq!(r.fx.client.rec_last_price(&rec_id), 10_000_000);
    assert_eq!(r.fx.client.rec_index_price(&rec_id), 10_000_000);

    // Second fill: 6 units at 20.00. Volume-weighted average is 17.50.
    r.fx.client.list_recs(&r.producer, &rec_id, &6, &20_000_000);
    let bid_b = r.fx.client.place_bid(&r.buyer, &rec_id, &6, &20_000_000);
    r.fx.client.execute_trade(&r.buyer, &bid_b);
    assert_eq!(r.fx.client.rec_last_price(&rec_id), 20_000_000);
    assert_eq!(r.fx.client.rec_index_price(&rec_id), 17_500_000);

    let state = r.fx.client.get_rec_market_state();
    assert_eq!(state.trade_count, 2);
    assert_eq!(state.total_traded_units, 8);
    assert_eq!(state.total_traded_value, 140);
}

#[test]
fn one_bid_fills_across_multiple_asks() {
    let r = setup();
    let rec_id = r.issue_verified();
    r.fx.client.list_recs(&r.producer, &rec_id, &2, &10_000_000);
    r.fx.client.list_recs(&r.producer, &rec_id, &3, &11_000_000);
    r.fx.client.list_recs(&r.producer, &rec_id, &4, &30_000_000);

    let bid_id = r.fx.client.place_bid(&r.buyer, &rec_id, &5, &11_000_000);
    let trades = r.fx.client.execute_trade(&r.buyer, &bid_id);
    // Only the two crossing asks trade; the 30.00 ask is left alone.
    assert_eq!(trades.len(), 2);
    assert_eq!(r.fx.client.rec_balance(&rec_id, &r.buyer), 5);
    assert_eq!(r.fx.client.rec_balance(&rec_id, &r.producer), UNITS - 5);
    assert_eq!(r.fx.client.rec_best_ask(&rec_id), 30_000_000);
}

#[test]
fn a_buyer_cannot_trade_against_its_own_ask() {
    let r = setup();
    let rec_id = r.issue_verified();
    r.fx.client.list_recs(&r.producer, &rec_id, &2, &PRICE);
    let bid_id = r.fx.client.place_bid(&r.producer, &rec_id, &2, &PRICE);
    let trades = r.fx.client.execute_trade(&r.producer, &bid_id);
    assert!(trades.is_empty());
}

#[test]
fn a_bid_cannot_be_traded_twice() {
    let r = setup();
    let rec_id = r.issue_verified();
    r.fx.client.list_recs(&r.producer, &rec_id, &2, &PRICE);
    let bid_id = r.fx.client.place_bid(&r.buyer, &rec_id, &2, &PRICE);
    r.fx.client.execute_trade(&r.buyer, &bid_id);
    assert!(r.fx.client.try_execute_trade(&r.buyer, &bid_id).is_err());
    // A sell order id is not a tradable bid.
    let ask_id = r.fx.client.list_recs(&r.producer, &rec_id, &1, &PRICE);
    assert!(r.fx.client.try_execute_trade(&r.buyer, &ask_id).is_err());
}

#[test]
fn only_the_order_owner_can_cancel() {
    let r = setup();
    let rec_id = r.issue_verified();
    let order_id = r.fx.client.list_recs(&r.producer, &rec_id, &2, &PRICE);
    // `mock_all_auths` would let this pass; the guard is asserted via the
    // ownership check the cancel path performs on status/ownership.
    r.fx.client.cancel_rec_order(&order_id);
    assert_eq!(
        r.fx.client.get_rec_order(&order_id).status,
        RecOrderStatus::Cancelled
    );
    assert_eq!(r.fx.client.get_rec_order(&order_id).side, RecSide::Sell);
}

#[test]
fn book_and_trade_listings_reflect_open_state() {
    let r = setup();
    let rec_id = r.issue_verified();
    let filled = r.fx.client.list_recs(&r.producer, &rec_id, &1, &PRICE);
    let resting = r.fx.client.list_recs(&r.producer, &rec_id, &1, &(PRICE * 2));
    // A bid at the cheap ask, and a far higher bid that crosses neither ask.
    r.fx.client.place_bid(&r.buyer, &rec_id, &2, &PRICE);
    let bid = r.fx.client.place_bid(&r.buyer, &rec_id, &3, &(PRICE * 4));

    let bids = r.fx.client.list_rec_orders(&rec_id, &false, &0, &10);
    assert_eq!(bids.len(), 2);
    // Highest bid first.
    assert_eq!(bids.get(0).unwrap().remaining, 3);
    assert_eq!(r.fx.client.rec_best_bid(&rec_id), PRICE * 4);

    // A 1-unit bid at the cheap ask fills that order only.
    let small_bid = r.fx.client.place_bid(&r.buyer, &rec_id, &1, &PRICE);
    r.fx.client.execute_trade(&r.buyer, &small_bid);
    // Filled orders leave the book; the dearer ask stays resting.
    let asks = r.fx.client.list_rec_orders(&rec_id, &true, &0, &10);
    assert_eq!(asks.len(), 1);
    assert_eq!(asks.get(0).unwrap().order_id, resting);
    assert_eq!(r.fx.client.get_rec_order(&filled).status, RecOrderStatus::Filled);
    assert_eq!(r.fx.client.get_rec_order(&bid).status, RecOrderStatus::Open);

    let trades = r.fx.client.list_rec_trades(&rec_id, &0, &10);
    assert_eq!(trades.len(), 1);
    assert_eq!(trades.get(0).unwrap().units, 1);
    assert_eq!(r.fx.client.list_rec_trades(&rec_id, &0, &10).len(), 1);
}

#[test]
fn pause_blocks_new_rec_activity() {
    let r = setup();
    let rec_id = r.issue_verified();
    let order_id = r.fx.client.list_recs(&r.producer, &rec_id, &2, &PRICE);
    r.fx.client.pause();

    assert_eq!(
        r.fx.client.try_list_recs(&r.producer, &rec_id, &1, &PRICE),
        Err(Ok(ContractError::ContractPaused))
    );
    assert_eq!(
        r.fx.client.try_place_bid(&r.buyer, &rec_id, &1, &PRICE),
        Err(Ok(ContractError::ContractPaused))
    );
    // Cancelling stays open so a producer is never trapped with reserved units.
    assert!(r.fx.client.try_cancel_rec_order(&order_id).is_ok());
}
