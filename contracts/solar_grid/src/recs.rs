//! Renewable Energy Credit (REC) tokenization and marketplace (Issue #927).
//!
//! A REC is a claim on one MWh of verified renewable generation. Issuance is
//! gated on a registry (admin) recording the generating meter and the kWh it
//! is backed by; the units live in an internal ledger rather than a Stellar
//! Asset Contract because a REC is a specific vintage/site claim, not a
//! fungible currency — minting one as SAC units would make vintages
//! indistinguishable after issuance.
//!
//! Trading follows a crossing order book per REC id:
//!   - `list_recs` posts an ask, `place_bid` posts a bid,
//!   - `execute_trade` matches resting asks against a bid and settles.
//!
//! Price discovery is emergent: fills execute at the resting (maker) price in
//! price-then-time priority, so the last traded price and the rolling
//! volume-weighted index move purely as a result of what participants actually
//! agree to pay. `rec_index_price` reports the volume-weighted average and
//! returns the last price until volume exists — never a price nobody agreed to.
//!
//! Compliance is enforced by construction: a REC cannot be listed or traded
//! until the compliance authority attests it, so unverified generation never
//! reaches the market.
//!
//! Settlement is atomic — units move seller→buyer and the settlement token
//! moves buyer→seller (minus `fee_bps`, retained by the marketplace) within one
//! call, so a trade can never settle one leg without the other.

use crate::{ContractError, SolarGridContract, SolarGridContractArgs, SolarGridContractClient};
use alloc::vec::Vec as StdVec;
use soroban_sdk::{contractimpl, contracttype, symbol_short, token, Address, Env, String, Vec};

/// Fixed-point scale for REC prices: quoted in micro-units of the settlement token.
pub const PRICE_SCALE: i128 = 1_000_000;
/// Basis-point denominator for the marketplace fee.
pub const BPS_SCALE: i128 = 10_000;
/// Largest fee the marketplace may charge (10%).
pub const MAX_FEE_BPS: i128 = 1_000;
/// Upper bound on a single REC issue, so one call cannot exhaust the ledger.
pub const MAX_REC_QUANTITY: i128 = 1_000_000_000;
/// Upper bound on page size for order/trade listings.
pub const MAX_REC_PAGE: u32 = 100;

#[contracttype]
#[derive(Clone)]
enum RecKey {
    Config,
    Market,
    Rec(u32),
    /// Units of one REC id held by one address.
    Balance(u32, Address),
    Order(u32),
    Trade(u32),
    /// Rolling price-discovery inputs for one REC id, so reads are O(1).
    Index(u32),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RecConfig {
    /// Token RECs are paid in. Must not be the contract's payment token.
    pub settlement_token: Address,
    /// Allowed to attest that a REC's generation is compliant.
    pub compliance_authority: Address,
    /// Marketplace fee charged on each trade, in basis points.
    pub fee_bps: i128,
}

/// Compliance state of a REC. Only `Verified` credits may be traded.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RecCompliance {
    /// Issued, awaiting attestation.
    Pending,
    /// Attested by the compliance authority — tradable.
    Verified,
    /// Rejected — permanently non-tradable.
    Rejected,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RecSide {
    Sell,
    Buy,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RecOrderStatus {
    Open,
    Filled,
    Cancelled,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RenewableEnergyCredit {
    pub rec_id: u32,
    pub producer: Address,
    pub meter_id: String,
    pub vintage: u32,
    pub registry_ref: String,
    pub total_units: i128,
    /// Units not reserved by an open sell order.
    pub available_units: i128,
    pub compliance: RecCompliance,
    /// Attestation reference; empty until verified.
    pub compliance_ref: String,
    pub issued_at: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RecOrder {
    pub order_id: u32,
    pub rec_id: u32,
    pub side: RecSide,
    pub owner: Address,
    /// Units still unfilled.
    pub remaining: i128,
    /// Price per unit, scaled by PRICE_SCALE.
    pub price: i128,
    pub status: RecOrderStatus,
    pub created_at: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RecTrade {
    pub trade_id: u32,
    pub rec_id: u32,
    pub seller: Address,
    pub buyer: Address,
    pub sell_order_id: u32,
    pub buy_order_id: u32,
    pub units: i128,
    /// Price per unit, scaled by PRICE_SCALE.
    pub price: i128,
    /// Gross consideration in settlement-token units.
    pub consideration: i128,
    pub fee: i128,
    /// Consideration credited to the seller after the fee.
    pub proceeds: i128,
    pub settled_at: u64,
}

/// Rolling volume-weighted price inputs for one REC id.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RecIndex {
    pub last_price: i128,
    pub total_units: i128,
    pub total_value: i128,
    pub trade_count: u32,
}

/// Counters, exposed for health checks and dashboards.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RecMarketState {
    pub next_rec_id: u32,
    pub next_order_id: u32,
    pub next_trade_id: u32,
    pub total_issued: i128,
    pub total_traded_units: i128,
    pub total_traded_value: i128,
    pub trade_count: u32,
}

fn mul_div(a: i128, b: i128, d: i128) -> Result<i128, ContractError> {
    a.checked_mul(b)
        .map(|v| v / d)
        .ok_or(ContractError::InvalidAmount)
}

fn load_config(env: &Env) -> Result<RecConfig, ContractError> {
    env.storage()
        .instance()
        .get(&RecKey::Config)
        .ok_or(ContractError::RecNotConfigured)
}

fn load_rec(env: &Env, rec_id: u32) -> Result<RenewableEnergyCredit, ContractError> {
    env.storage()
        .persistent()
        .get(&RecKey::Rec(rec_id))
        .ok_or(ContractError::RecNotFound)
}

fn save_rec(env: &Env, rec: &RenewableEnergyCredit) {
    env.storage().persistent().set(&RecKey::Rec(rec.rec_id), rec);
}

fn load_order(env: &Env, order_id: u32) -> Result<RecOrder, ContractError> {
    env.storage()
        .persistent()
        .get(&RecKey::Order(order_id))
        .ok_or(ContractError::OrderNotFound)
}

fn save_order(env: &Env, order: &RecOrder) {
    env.storage().persistent().set(&RecKey::Order(order.order_id), order);
}

fn balance_of(env: &Env, rec_id: u32, owner: &Address) -> i128 {
    env.storage()
        .persistent()
        .get(&RecKey::Balance(rec_id, owner.clone()))
        .unwrap_or(0)
}

fn set_balance(env: &Env, rec_id: u32, owner: &Address, amount: i128) {
    let key = RecKey::Balance(rec_id, owner.clone());
    if amount == 0 {
        env.storage().persistent().remove(&key);
    } else {
        env.storage().persistent().set(&key, &amount);
    }
}

fn transfer_units(
    env: &Env,
    rec_id: u32,
    from: &Address,
    to: &Address,
    amount: i128,
) -> Result<(), ContractError> {
    let from_balance = balance_of(env, rec_id, from);
    if amount <= 0 || amount > from_balance {
        return Err(ContractError::InsufficientBalance);
    }
    set_balance(env, rec_id, from, from_balance - amount);
    set_balance(env, rec_id, to, balance_of(env, rec_id, to) + amount);
    Ok(())
}

fn require_tradable(rec: &RenewableEnergyCredit) -> Result<(), ContractError> {
    match rec.compliance {
        RecCompliance::Verified => Ok(()),
        RecCompliance::Pending => Err(ContractError::RecCompliancePending),
        RecCompliance::Rejected => Err(ContractError::RecComplianceRejected),
    }
}

#[contractimpl]
impl SolarGridContract {
    /// Admin: configure the marketplace. Rejected if the settlement token is
    /// the contract's payment token, which `emergency_withdraw` sweeps.
    pub fn configure_recs(
        env: Env,
        settlement_token: Address,
        compliance_authority: Address,
        fee_bps: i128,
    ) -> Result<(), ContractError> {
        Self::require_admin(&env)?;
        if fee_bps < 0 || fee_bps > MAX_FEE_BPS {
            return Err(ContractError::InvalidConfiguration);
        }
        if let Ok(payment_token) = Self::get_token_address(&env) {
            if settlement_token == payment_token {
                return Err(ContractError::InvalidConfiguration);
            }
        }
        env.storage().instance().set(
            &RecKey::Config,
            &RecConfig {
                settlement_token,
                compliance_authority: compliance_authority.clone(),
                fee_bps,
            },
        );
        env.events().publish(
            (symbol_short!("solar"), symbol_short!("rec_cfg")),
            (compliance_authority, fee_bps),
        );
        Ok(())
    }

    pub fn get_rec_config(env: Env) -> Result<RecConfig, ContractError> {
        load_config(&env)
    }

    /// Admin (the registry): issue RECs backed by `kwh_generated` generation.
    ///
    /// One unit represents one MWh, so a meter that produced 12,500 kWh gets 12
    /// RECs. Issued credits start `Pending` and cannot be listed until the
    /// compliance authority attests them, so unverified generation never
    /// reaches the market.
    pub fn issue_rec(
        env: Env,
        producer: Address,
        meter_id: String,
        kwh_generated: i128,
        vintage: u32,
        registry_ref: String,
    ) -> Result<u32, ContractError> {
        Self::require_admin(&env)?;
        if Self::pause_is_active(&env) {
            return Err(ContractError::ContractPaused);
        }
        load_config(&env)?;
        if kwh_generated <= 0 {
            return Err(ContractError::InvalidRecQuantity);
        }
        if registry_ref.is_empty() {
            return Err(ContractError::ComplianceRefMissing);
        }

        let units = kwh_generated / 1_000;
        if units <= 0 || units > MAX_REC_QUANTITY {
            return Err(ContractError::InvalidRecQuantity);
        }

        let mut state = Self::rec_market_state_internal(&env);
        let rec_id = state.next_rec_id;
        state.next_rec_id += 1;
        state.total_issued += units;

        let rec = RenewableEnergyCredit {
            rec_id,
            producer: producer.clone(),
            meter_id,
            vintage,
            registry_ref,
            total_units: units,
            available_units: units,
            compliance: RecCompliance::Pending,
            compliance_ref: String::from_str(&env, ""),
            issued_at: env.ledger().timestamp(),
        };
        save_rec(&env, &rec);
        // The registry mints straight into the producer's balance; a transfer
        // would fail because no units exist yet.
        set_balance(&env, rec_id, &producer, balance_of(&env, rec_id, &producer) + units);
        env.storage().instance().set(&RecKey::Market, &state);

        env.events().publish(
            (symbol_short!("solar"), symbol_short!("rec_iss"), rec_id),
            (producer, units),
        );
        Ok(rec_id)
    }

    /// Compliance authority: attest a REC so it may be traded.
    pub fn verify_rec(env: Env, rec_id: u32, compliance_ref: String) -> Result<(), ContractError> {
        let cfg = load_config(&env)?;
        cfg.compliance_authority.require_auth();
        if compliance_ref.is_empty() {
            return Err(ContractError::ComplianceRefMissing);
        }
        let mut rec = load_rec(&env, rec_id)?;
        if rec.compliance == RecCompliance::Rejected {
            return Err(ContractError::RecComplianceRejected);
        }
        rec.compliance = RecCompliance::Verified;
        rec.compliance_ref = compliance_ref;
        save_rec(&env, &rec);
        env.events().publish(
            (symbol_short!("solar"), symbol_short!("rec_ok"), rec_id),
            rec.producer,
        );
        Ok(())
    }

    /// Compliance authority: reject a REC permanently.
    pub fn reject_rec(env: Env, rec_id: u32) -> Result<(), ContractError> {
        let cfg = load_config(&env)?;
        cfg.compliance_authority.require_auth();
        let mut rec = load_rec(&env, rec_id)?;
        rec.compliance = RecCompliance::Rejected;
        save_rec(&env, &rec);
        env.events().publish(
            (symbol_short!("solar"), symbol_short!("rec_rj"), rec_id),
            rec.producer,
        );
        Ok(())
    }

    /// Producer: post a sell order for up to `units` of `rec_id`.
    pub fn list_recs(
        env: Env,
        seller: Address,
        rec_id: u32,
        units: i128,
        price: i128,
    ) -> Result<u32, ContractError> {
        seller.require_auth();
        if Self::pause_is_active(&env) {
            return Err(ContractError::ContractPaused);
        }
        load_config(&env)?;
        if units <= 0 || price <= 0 {
            return Err(ContractError::InvalidAmount);
        }
        let mut rec = load_rec(&env, rec_id)?;
        require_tradable(&rec)?;
        // Only what the seller holds and has not already reserved can be listed.
        if units > balance_of(&env, rec_id, &seller) || units > rec.available_units {
            return Err(ContractError::InsufficientBalance);
        }

        let mut state = Self::rec_market_state_internal(&env);
        let order_id = state.next_order_id;
        state.next_order_id += 1;
        rec.available_units -= units;
        save_rec(&env, &rec);

        let order = RecOrder {
            order_id,
            rec_id,
            side: RecSide::Sell,
            owner: seller.clone(),
            remaining: units,
            price,
            status: RecOrderStatus::Open,
            created_at: env.ledger().timestamp(),
        };
        save_order(&env, &order);
        env.storage().instance().set(&RecKey::Market, &state);

        env.events().publish(
            (symbol_short!("solar"), symbol_short!("rec_lst"), order_id),
            (seller, rec_id, units, price),
        );
        Ok(order_id)
    }

    /// Buyer: post a buy order. Funds are not escrowed here; they move on fill.
    pub fn place_bid(env: Env, buyer: Address, rec_id: u32, units: i128, price: i128) -> Result<u32, ContractError> {
        buyer.require_auth();
        if Self::pause_is_active(&env) {
            return Err(ContractError::ContractPaused);
        }
        load_config(&env)?;
        if units <= 0 || price <= 0 {
            return Err(ContractError::InvalidAmount);
        }
        let rec = load_rec(&env, rec_id)?;
        require_tradable(&rec)?;

        let mut state = Self::rec_market_state_internal(&env);
        let order_id = state.next_order_id;
        state.next_order_id += 1;
        let order = RecOrder {
            order_id,
            rec_id,
            side: RecSide::Buy,
            owner: buyer.clone(),
            remaining: units,
            price,
            status: RecOrderStatus::Open,
            created_at: env.ledger().timestamp(),
        };
        save_order(&env, &order);
        env.storage().instance().set(&RecKey::Market, &state);

        env.events().publish(
            (symbol_short!("solar"), symbol_short!("rec_bid"), order_id),
            (buyer, rec_id, units, price),
        );
        Ok(order_id)
    }

    /// Match `buy_order_id` against resting asks for the same REC and settle
    /// each fill. Returns the trade ids, cheapest fill first.
    pub fn execute_trade(env: Env, buyer: Address, buy_order_id: u32) -> Result<Vec<u32>, ContractError> {
        buyer.require_auth();
        if Self::pause_is_active(&env) {
            return Err(ContractError::ContractPaused);
        }
        let cfg = load_config(&env)?;
        let mut buy = load_order(&env, buy_order_id)?;
        if buy.side != RecSide::Buy {
            return Err(ContractError::OrderNotOpen);
        }
        if buy.status != RecOrderStatus::Open {
            return Err(ContractError::OrderNotFilled);
        }
        if buy.owner != buyer {
            return Err(ContractError::Unauthorized);
        }
        let rec = load_rec(&env, buy.rec_id)?;
        require_tradable(&rec)?;

        // Price-then-time priority over every crossing ask.
        let mut asks: StdVec<(i128, u32)> = StdVec::new();
        let scan_limit = Self::rec_market_state_internal(&env).next_order_id;
        let mut id = 1u32;
        while id < scan_limit {
            if let Ok(candidate) = load_order(&env, id) {
                if candidate.rec_id == buy.rec_id
                    && candidate.side == RecSide::Sell
                    && candidate.status == RecOrderStatus::Open
                    && candidate.remaining > 0
                    && candidate.price <= buy.price
                    && candidate.owner != buyer
                {
                    asks.push((candidate.price, id));
                }
            }
            id += 1;
        }
        asks.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));

        let mut trades: Vec<u32> = Vec::new(&env);
        for (_, ask_id) in asks.iter() {
            if buy.remaining == 0 {
                break;
            }
            let mut ask = load_order(&env, *ask_id)?;
            if ask.status != RecOrderStatus::Open || ask.remaining == 0 {
                continue;
            }
            let units = if buy.remaining < ask.remaining {
                buy.remaining
            } else {
                ask.remaining
            };

            let trade_id = Self::settle_rec_trade(
                &env,
                &cfg,
                buy.rec_id,
                &ask.owner,
                &buy.owner,
                *ask_id,
                buy_order_id,
                units,
                ask.price,
            )?;
            trades.push_back(trade_id);

            ask.remaining -= units;
            ask.status = if ask.remaining == 0 {
                RecOrderStatus::Filled
            } else {
                RecOrderStatus::Open
            };
            save_order(&env, &ask);
            buy.remaining -= units;
        }

        buy.status = if buy.remaining == 0 {
            RecOrderStatus::Filled
        } else {
            RecOrderStatus::Open
        };
        save_order(&env, &buy);

        env.events().publish(
            (symbol_short!("solar"), symbol_short!("rec_trd"), buy_order_id),
            (buyer, trades.len()),
        );
        Ok(trades)
    }

    /// Cancel an open order the caller owns. Returns the unfilled quantity;
    /// a sell order's units go back to the producer's available balance.
    pub fn cancel_rec_order(env: Env, order_id: u32) -> Result<i128, ContractError> {
        let mut order = load_order(&env, order_id)?;
        order.owner.require_auth();
        if order.status != RecOrderStatus::Open {
            return Err(ContractError::OrderNotOpen);
        }
        order.status = RecOrderStatus::Cancelled;
        save_order(&env, &order);

        if order.side == RecSide::Sell {
            let mut rec = load_rec(&env, order.rec_id)?;
            rec.available_units += order.remaining;
            save_rec(&env, &rec);
        }
        env.events().publish(
            (symbol_short!("solar"), symbol_short!("rec_can"), order_id),
            order.owner,
        );
        Ok(order.remaining)
    }

    // ── Views ─────────────────────────────────────────────────────────────────

    pub fn get_rec(env: Env, rec_id: u32) -> Result<RenewableEnergyCredit, ContractError> {
        load_rec(&env, rec_id)
    }

    /// Units of `rec_id` held by `owner`.
    pub fn rec_balance(env: Env, rec_id: u32, owner: Address) -> i128 {
        balance_of(&env, rec_id, &owner)
    }

    pub fn get_rec_order(env: Env, order_id: u32) -> Result<RecOrder, ContractError> {
        load_order(&env, order_id)
    }

    pub fn get_rec_trade(env: Env, trade_id: u32) -> Result<RecTrade, ContractError> {
        env.storage()
            .persistent()
            .get(&RecKey::Trade(trade_id))
            .ok_or(ContractError::TradeNotFound)
    }

    /// Volume-weighted average traded price for `rec_id`, scaled by PRICE_SCALE.
    /// Falls back to the last traded price until volume exists.
    pub fn rec_index_price(env: Env, rec_id: u32) -> Result<i128, ContractError> {
        let index = Self::rec_index_internal(&env, rec_id);
        if index.total_units > 0 {
            mul_div(index.total_value, PRICE_SCALE, index.total_units)
        } else {
            Ok(index.last_price)
        }
    }

    /// Last traded price for `rec_id`, scaled by PRICE_SCALE. Zero if untraded.
    pub fn rec_last_price(env: Env, rec_id: u32) -> Result<i128, ContractError> {
        Ok(Self::rec_index_internal(&env, rec_id).last_price)
    }

    /// Cheapest resting ask for `rec_id`, scaled by PRICE_SCALE. Zero if none.
    pub fn rec_best_ask(env: Env, rec_id: u32) -> Result<i128, ContractError> {
        load_rec(&env, rec_id)?;
        Ok(Self::scan_book(&env, rec_id, true).first().map(|p| p.0).unwrap_or(0))
    }

    /// Highest resting bid for `rec_id`, scaled by PRICE_SCALE. Zero if none.
    pub fn rec_best_bid(env: Env, rec_id: u32) -> Result<i128, ContractError> {
        load_rec(&env, rec_id)?;
        Ok(Self::scan_book(&env, rec_id, false).first().map(|p| p.0).unwrap_or(0))
    }

    pub fn get_rec_market_state(env: Env) -> RecMarketState {
        Self::rec_market_state_internal(&env)
    }

    /// Open orders for `rec_id` in price-time priority, capped at MAX_REC_PAGE.
    /// `asks = true` returns the sell side (cheapest first), otherwise the buy
    /// side (highest first).
    pub fn list_rec_orders(
        env: Env,
        rec_id: u32,
        asks: bool,
        start: u32,
        limit: u32,
    ) -> Result<Vec<RecOrder>, ContractError> {
        load_rec(&env, rec_id)?;
        let side = if asks { RecSide::Sell } else { RecSide::Buy };
        let ranked = Self::scan_book(&env, rec_id, asks);
        let cap = if limit == 0 { MAX_REC_PAGE } else { limit.min(MAX_REC_PAGE) };
        let mut out: Vec<RecOrder> = Vec::new(&env);
        for (_, order_id) in ranked.iter().skip(start as usize).take(cap as usize) {
            if let Ok(order) = load_order(&env, *order_id) {
                if order.side == side && order.status == RecOrderStatus::Open {
                    out.push_back(order);
                }
            }
        }
        Ok(out)
    }

    /// Executed trades for `rec_id`, newest first, capped at MAX_REC_PAGE.
    pub fn list_rec_trades(
        env: Env,
        rec_id: u32,
        start: u32,
        limit: u32,
    ) -> Result<Vec<RecTrade>, ContractError> {
        load_rec(&env, rec_id)?;
        let cap = if limit == 0 { MAX_REC_PAGE } else { limit.min(MAX_REC_PAGE) };
        let state = Self::rec_market_state_internal(&env);
        let mut out: Vec<RecTrade> = Vec::new(&env);
        // Trade ids ascend, so the newest is `next_trade_id - 1`.
        let mut id = state.next_trade_id.saturating_sub(1);
        let mut skipped = 0u32;
        while id >= 1 && out.len() < cap + start {
            if let Some(trade) = env.storage().persistent().get::<RecKey, RecTrade>(&RecKey::Trade(id)) {
                if trade.rec_id == rec_id {
                    if skipped >= start {
                        out.push_back(trade);
                    } else {
                        skipped += 1;
                    }
                }
            }
            if id == 1 {
                break;
            }
            id -= 1;
        }
        while out.len() > cap {
            out.remove(out.len() - 1);
        }
        Ok(out)
    }

    // ── Internals ────────────────────────────────────────────────────────────

    /// Move units and settlement funds for one fill. Effects are applied before
    /// the token transfers so a failed payment reverts the whole call.
    #[allow(clippy::too_many_arguments)]
    fn settle_rec_trade(
        env: &Env,
        cfg: &RecConfig,
        rec_id: u32,
        seller: &Address,
        buyer: &Address,
        sell_order_id: u32,
        buy_order_id: u32,
        units: i128,
        price: i128,
    ) -> Result<u32, ContractError> {
        let consideration = mul_div(units, price, PRICE_SCALE)?;
        if consideration <= 0 {
            return Err(ContractError::InvalidAmount);
        }
        let fee = mul_div(consideration, cfg.fee_bps, BPS_SCALE)?;
        let proceeds = consideration - fee;

        transfer_units(env, rec_id, seller, buyer, units)?;

        let mut state = Self::rec_market_state_internal(env);
        let trade = RecTrade {
            trade_id: state.next_trade_id,
            rec_id,
            seller: seller.clone(),
            buyer: buyer.clone(),
            sell_order_id,
            buy_order_id,
            units,
            price,
            consideration,
            fee,
            proceeds,
            settled_at: env.ledger().timestamp(),
        };
        state.next_trade_id += 1;
        state.total_traded_units += units;
        state.total_traded_value += consideration;
        state.trade_count += 1;
        env.storage().instance().set(&RecKey::Market, &state);

        let mut index = Self::rec_index_internal(env, rec_id);
        index.last_price = price;
        index.total_units += units;
        index.total_value += consideration;
        index.trade_count += 1;
        env.storage().persistent().set(&RecKey::Index(rec_id), &index);

        env.storage().persistent().set(&RecKey::Trade(trade.trade_id), &trade);

        let settlement = token::Client::new(env, &cfg.settlement_token);
        if proceeds > 0 {
            settlement.transfer(buyer, seller, &proceeds);
        }
        if fee > 0 {
            settlement.transfer(buyer, &env.current_contract_address(), &fee);
        }

        env.events().publish(
            (symbol_short!("solar"), symbol_short!("rec_fill"), trade.trade_id),
            (seller, buyer, units, consideration),
        );
        Ok(trade.trade_id)
    }

    fn rec_market_state_internal(env: &Env) -> RecMarketState {
        env.storage()
            .instance()
            .get(&RecKey::Market)
            .unwrap_or(RecMarketState {
                next_rec_id: 1,
                next_order_id: 1,
                next_trade_id: 1,
                total_issued: 0,
                total_traded_units: 0,
                total_traded_value: 0,
                trade_count: 0,
            })
    }

    fn rec_index_internal(env: &Env, rec_id: u32) -> RecIndex {
        env.storage()
            .persistent()
            .get(&RecKey::Index(rec_id))
            .unwrap_or(RecIndex {
                last_price: 0,
                total_units: 0,
                total_value: 0,
                trade_count: 0,
            })
    }

    /// Every open order for `rec_id` as (price, order_id), sorted by price then
    /// id. Ascending for asks, descending for bids.
    fn scan_book(env: &Env, rec_id: u32, asks: bool) -> StdVec<(i128, u32)> {
        let side = if asks { RecSide::Sell } else { RecSide::Buy };
        let mut book: StdVec<(i128, u32)> = StdVec::new();
        let scan_limit = Self::rec_market_state_internal(env).next_order_id;
        let mut id = 1u32;
        while id < scan_limit {
            if let Ok(order) = load_order(env, id) {
                if order.rec_id == rec_id
                    && order.side == side
                    && order.status == RecOrderStatus::Open
                    && order.remaining > 0
                {
                    book.push((order.price, id));
                }
            }
            id += 1;
        }
        if asks {
            book.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
        } else {
            book.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
        }
        book
    }
}
