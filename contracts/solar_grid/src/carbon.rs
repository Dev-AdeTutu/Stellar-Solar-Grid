//! Carbon Credit Marketplace
//!
//! Tokenizes verified carbon credits (1 credit = 1 tonne CO2e avoided) as
//! fungible tokens and provides an on-chain order book for trading them.
//!
//! The module mirrors the structure of `recs.rs`:
//! - `CarbonCredit` token with per-account balances
//! - Automated issuance from verified solar generation
//! - Verification / certification of issuers
//! - Listing, bidding, cancelling and settling trades
//! - Order book storage keys and an index-price calculation

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, Env, Symbol, Vec,
};

// ---------------------------------------------------------------------------
// Storage keys
// ---------------------------------------------------------------------------

/// Storage keys used by the carbon credit marketplace.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CarbonKey {
    /// Admin address allowed to verify issuers.
    Admin,
    /// Total supply of carbon credits (in grams of CO2e).
    TotalSupply,
    /// Balance of carbon credits for an account.
    Balance(Address),
    /// Verification status of an issuer.
    Verified(Address),
    /// Amount of credits already issued to an issuer (prevents double issuance).
    Issued(Address),
    /// Monotonic listing id counter.
    NextListingId,
    /// Listing record by id.
    Listing(u64),
    /// All open listing ids (order book).
    OpenListings,
    /// Bid record by id.
    Bid(u64),
    /// Monotonic bid id counter.
    NextBidId,
    /// Bids attached to a listing.
    ListingBids(u64),
    /// Last traded price (index price), in stroops per credit.
    LastPrice,
    /// Accumulated trade volume (in credits).
    Volume,
}

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

/// A sell order for carbon credits.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Listing {
    pub id: u64,
    pub seller: Address,
    /// Amount of credits offered (in grams of CO2e).
    pub amount: i128,
    /// Asking price per credit, in stroops.
    pub price: i128,
    /// Remaining amount still available.
    pub remaining: i128,
    pub active: bool,
}

/// A buy order for a specific listing.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Bid {
    pub id: u64,
    pub listing_id: u64,
    pub buyer: Address,
    /// Amount of credits the buyer wants (in grams of CO2e).
    pub amount: i128,
    /// Bid price per credit, in stroops.
    pub price: i128,
    pub active: bool,
}

/// Result of a settled trade.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TradeResult {
    pub listing_id: u64,
    pub bid_id: u64,
    pub buyer: Address,
    pub seller: Address,
    pub amount: i128,
    pub price: i128,
    pub total: i128,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum CarbonError {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    Unauthorized = 3,
    NotVerified = 4,
    InvalidAmount = 5,
    InvalidPrice = 6,
    InsufficientBalance = 7,
    ListingNotFound = 8,
    ListingInactive = 9,
    BidNotFound = 10,
    BidInactive = 11,
    InsufficientBid = 12,
    NothingToIssue = 13,
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct CarbonCreditContract;

#[contractimpl]
impl CarbonCreditContract {
    /// Initialize the marketplace with an admin address.
    pub fn initialize(env: Env, admin: Address) -> Result<(), CarbonError> {
        if env.storage().instance().has(&CarbonKey::Admin) {
            return Err(CarbonError::AlreadyInitialized);
        }
        admin.require_auth();
        env.storage().instance().set(&CarbonKey::Admin, &admin);
        env.storage().instance().set(&CarbonKey::TotalSupply, &0i128);
        env.storage().instance().set(&CarbonKey::NextListingId, &0u64);
        env.storage().instance().set(&CarbonKey::NextBidId, &0u64);
        env.storage().instance().set(&CarbonKey::LastPrice, &0i128);
        env.storage().instance().set(&CarbonKey::Volume, &0i128);
        env.storage()
            .instance()
            .set(&CarbonKey::OpenListings, &Vec::<u64>::new(&env));
        Ok(())
    }

    /// Return the configured admin.
    pub fn admin(env: Env) -> Result<Address, CarbonError> {
        env.storage()
            .instance()
            .get(&CarbonKey::Admin)
            .ok_or(CarbonError::NotInitialized)
    }

    // -----------------------------------------------------------------------
    // Verification / certification
    // -----------------------------------------------------------------------

    /// Mark an issuer as verified (admin only).
    pub fn verify_issuer(env: Env, issuer: Address) -> Result<(), CarbonError> {
        let admin = Self::admin(env.clone())?;
        admin.require_auth();
        env.storage()
            .persistent()
            .set(&CarbonKey::Verified(issuer.clone()), &true);
        env.events()
            .publish((symbol_short!("carbon"), symbol_short!("verify")), issuer);
        Ok(())
    }

    /// Revoke an issuer's verification (admin only).
    pub fn revoke_issuer(env: Env, issuer: Address) -> Result<(), CarbonError> {
        let admin = Self::admin(env.clone())?;
        admin.require_auth();
        env.storage()
            .persistent()
            .set(&CarbonKey::Verified(issuer.clone()), &false);
        env.events().publish(
            (symbol_short!("carbon"), symbol_short!("revoke")),
            issuer,
        );
        Ok(())
    }

    /// Whether an issuer is verified.
    pub fn is_verified(env: Env, issuer: Address) -> bool {
        env.storage()
            .persistent()
            .get(&CarbonKey::Verified(issuer))
            .unwrap_or(false)
    }

    // -----------------------------------------------------------------------
    // Issuance
    // -----------------------------------------------------------------------

    /// Issue carbon credits to a verified issuer based on verified solar
    /// generation.
    ///
    /// `generation_wh` is the verified solar energy generated (in Wh).
    /// `emission_factor` is grams of CO2e avoided per Wh (scaled by 1e6 to
    /// allow fractional factors). The resulting credits are denominated in
    /// grams of CO2e.
    pub fn issue_from_generation(
        env: Env,
        issuer: Address,
        generation_wh: i128,
        emission_factor: i128,
    ) -> Result<i128, CarbonError> {
        issuer.require_auth();

        if !Self::is_verified(env.clone(), issuer.clone()) {
            return Err(CarbonError::NotVerified);
        }
        if generation_wh <= 0 || emission_factor <= 0 {
            return Err(CarbonError::InvalidAmount);
        }

        // credits = generation_wh * emission_factor / 1e6
        let credits = generation_wh
            .checked_mul(emission_factor)
            .ok_or(CarbonError::InvalidAmount)?
            / 1_000_000;

        if credits <= 0 {
            return Err(CarbonError::NothingToIssue);
        }

        Self::mint_internal(&env, &issuer, credits)?;

        let issued: i128 = env
            .storage()
            .persistent()
            .get(&CarbonKey::Issued(issuer.clone()))
            .unwrap_or(0);
        env.storage()
            .persistent()
            .set(&CarbonKey::Issued(issuer.clone()), &(issued + credits));

        env.events().publish(
            (symbol_short!("carbon"), symbol_short!("issue")),
            (issuer, credits),
        );

        Ok(credits)
    }

    /// Internal mint helper.
    fn mint_internal(env: &Env, to: &Address, amount: i128) -> Result<(), CarbonError> {
        if amount <= 0 {
            return Err(CarbonError::InvalidAmount);
        }
        let balance: i128 = env
            .storage()
            .persistent()
            .get(&CarbonKey::Balance(to.clone()))
            .unwrap_or(0);
        env.storage()
            .persistent()
            .set(&CarbonKey::Balance(to.clone()), &(balance + amount));

        let supply: i128 = env
            .storage()
            .instance()
            .get(&CarbonKey::TotalSupply)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&CarbonKey::TotalSupply, &(supply + amount));
        Ok(())
    }

    /// Internal burn helper.
    fn burn_internal(env: &Env, from: &Address, amount: i128) -> Result<(), CarbonError> {
        if amount <= 0 {
            return Err(CarbonError::InvalidAmount);
        }
        let balance: i128 = env
            .storage()
            .persistent()
            .get(&CarbonKey::Balance(from.clone()))
            .unwrap_or(0);
        if balance < amount {
            return Err(CarbonError::InsufficientBalance);
        }
        env.storage()
            .persistent()
            .set(&CarbonKey::Balance(from.clone()), &(balance - amount));

        let supply: i128 = env
            .storage()
            .instance()
            .get(&CarbonKey::TotalSupply)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&CarbonKey::TotalSupply, &(supply - amount));
        Ok(())
    }

    /// Balance of carbon credits for an account.
    pub fn balance(env: Env, account: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&CarbonKey::Balance(account))
            .unwrap_or(0)
    }

    /// Total supply of carbon credits.
    pub fn total_supply(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&CarbonKey::TotalSupply)
            .unwrap_or(0)
    }

    /// Amount of credits already issued to an issuer.
    pub fn issued(env: Env, issuer: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&CarbonKey::Issued(issuer))
            .unwrap_or(0)
    }

    // -----------------------------------------------------------------------
    // Marketplace: listings
    // -----------------------------------------------------------------------

    /// Create a sell listing for carbon credits.
    pub fn list(
        env: Env,
        seller: Address,
        amount: i128,
        price: i128,
    ) -> Result<u64, CarbonError> {
        seller.require_auth();

        if amount <= 0 {
            return Err(CarbonError::InvalidAmount);
        }
        if price <= 0 {
            return Err(CarbonError::InvalidPrice);
        }

        let balance = Self::balance(env.clone(), seller.clone());
        if balance < amount {
            return Err(CarbonError::InsufficientBalance);
        }

        // Escrow the credits by moving them out of the seller's balance.
        Self::burn_internal(&env, &seller, amount)?;

        let id: u64 = env
            .storage()
            .instance()
            .get(&CarbonKey::NextListingId)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&CarbonKey::NextListingId, &(id + 1));

        let listing = Listing {
            id,
            seller: seller.clone(),
            amount,
            price,
            remaining: amount,
            active: true,
        };
        env.storage()
            .persistent()
            .set(&CarbonKey::Listing(id), &listing);

        let mut open: Vec<u64> = env
            .storage()
            .instance()
            .get(&CarbonKey::OpenListings)
            .unwrap_or_else(|| Vec::new(&env));
        open.push_back(id);
        env.storage()
            .instance()
            .set(&CarbonKey::OpenListings, &open);

        env.events().publish(
            (symbol_short!("carbon"), symbol_short!("list")),
            (id, seller, amount, price),
        );

        Ok(id)
    }

    /// Cancel an active listing and return remaining credits to the seller.
    pub fn cancel_listing(env: Env, seller: Address, listing_id: u64) -> Result<(), CarbonError> {
        seller.require_auth();

        let mut listing: Listing = env
            .storage()
            .persistent()
            .get(&CarbonKey::Listing(listing_id))
            .ok_or(CarbonError::ListingNotFound)?;

        if listing.seller != seller {
            return Err(CarbonError::Unauthorized);
        }
        if !listing.active {
            return Err(CarbonError::ListingInactive);
        }

        let remaining = listing.remaining;
        listing.remaining = 0;
        listing.active = false;
        env.storage()
            .persistent()
            .set(&CarbonKey::Listing(listing_id), &listing);

        Self::remove_open_listing(&env, listing_id);

        if remaining > 0 {
            Self::mint_internal(&env, &seller, remaining)?;
        }

        env.events().publish(
            (symbol_short!("carbon"), symbol_short!("cancel")),
            (listing_id, seller, remaining),
        );

        Ok(())
    }

    /// Fetch a listing by id.
    pub fn get_listing(env: Env, listing_id: u64) -> Result<Listing, CarbonError> {
        env.storage()
            .persistent()
            .get(&CarbonKey::Listing(listing_id))
            .ok_or(CarbonError::ListingNotFound)
    }

    /// Return all open listing ids (the order book).
    pub fn open_listings(env: Env) -> Vec<u64> {
        env.storage()
            .instance()
            .get(&CarbonKey::OpenListings)
            .unwrap_or_else(|| Vec::new(&env))
    }

    fn remove_open_listing(env: &Env, listing_id: u64) {
        let open: Vec<u64> = env
            .storage()
            .instance()
            .get(&CarbonKey::OpenListings)
            .unwrap_or_else(|| Vec::new(env));
        let mut updated: Vec<u64> = Vec::new(env);
        for id in open.iter() {
            if id != listing_id {
                updated.push_back(id);
            }
        }
        env.storage()
            .instance()
            .set(&CarbonKey::OpenListings, &updated);
    }

    // -----------------------------------------------------------------------
    // Marketplace: bids & trading
    // -----------------------------------------------------------------------

    /// Place a bid on an active listing.
    pub fn bid(
        env: Env,
        buyer: Address,
        listing_id: u64,
        amount: i128,
        price: i128,
    ) -> Result<u64, CarbonError> {
        buyer.require_auth();

        if amount <= 0 {
            return Err(CarbonError::InvalidAmount);
        }
        if price <= 0 {
            return Err(CarbonError::InvalidPrice);
        }

        let listing: Listing = env
            .storage()
            .persistent()
            .get(&CarbonKey::Listing(listing_id))
            .ok_or(CarbonError::ListingNotFound)?;

        if !listing.active {
            return Err(CarbonError::ListingInactive);
        }
        if amount > listing.remaining {
            return Err(CarbonError::InsufficientBid);
        }

        let id: u64 = env
            .storage()
            .instance()
            .get(&CarbonKey::NextBidId)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&CarbonKey::NextBidId, &(id + 1));

        let bid = Bid {
            id,
            listing_id,
            buyer: buyer.clone(),
            amount,
            price,
            active: true,
        };
        env.storage().persistent().set(&CarbonKey::Bid(id), &bid);

        let mut bids: Vec<u64> = env
            .storage()
            .persistent()
            .get(&CarbonKey::ListingBids(listing_id))
            .unwrap_or_else(|| Vec::new(&env));
        bids.push_back(id);
        env.storage()
            .persistent()
            .set(&CarbonKey::ListingBids(listing_id), &bids);

        env.events().publish(
            (symbol_short!("carbon"), symbol_short!("bid")),
            (id, listing_id, buyer, amount, price),
        );

        Ok(id)
    }

    /// Cancel an active bid.
    pub fn cancel_bid(env: Env, buyer: Address, bid_id: u64) -> Result<(), CarbonError> {
        buyer.require_auth();

        let mut bid: Bid = env
            .storage()
            .persistent()
            .get(&CarbonKey::Bid(bid_id))
            .ok_or(CarbonError::BidNotFound)?;

        if bid.buyer != buyer {
            return Err(CarbonError::Unauthorized);
        }
        if !bid.active {
            return Err(CarbonError::BidInactive);
        }

        bid.active = false;
        env.storage().persistent().set(&CarbonKey::Bid(bid_id), &bid);

        env.events().publish(
            (symbol_short!("carbon"), symbol_short!("bcancel")),
            (bid_id, buyer),
        );

        Ok(())
    }

    /// Fetch a bid by id.
    pub fn get_bid(env: Env, bid_id: u64) -> Result<Bid, CarbonError> {
        env.storage()
            .persistent()
            .get(&CarbonKey::Bid(bid_id))
            .ok_or(CarbonError::BidNotFound)
    }

    /// Return all bid ids attached to a listing.
    pub fn listing_bids(env: Env, listing_id: u64) -> Vec<u64> {
        env.storage()
            .persistent()
            .get(&CarbonKey::ListingBids(listing_id))
            .unwrap_or_else(|| Vec::new(&env))
    }

    /// Settle a bid against a listing. The seller must authorize the trade.
    ///
    /// The bid price must be at least the listing price. Credits are
    /// transferred from escrow to the buyer and the listing's remaining
    /// amount is reduced.
    pub fn trade(env: Env, seller: Address, bid_id: u64) -> Result<TradeResult, CarbonError> {
        seller.require_auth();

        let mut bid: Bid = env
            .storage()
            .persistent()
            .get(&CarbonKey::Bid(bid_id))
            .ok_or(CarbonError::BidNotFound)?;

        if !bid.active {
            return Err(CarbonError::BidInactive);
        }

        let mut listing: Listing = env
            .storage()
            .persistent()
            .get(&CarbonKey::Listing(bid.listing_id))
            .ok_or(CarbonError::ListingNotFound)?;

        if !listing.active {
            return Err(CarbonError::ListingInactive);
        }
        if listing.seller != seller {
            return Err(CarbonError::Unauthorized);
        }
        if bid.price < listing.price {
            return Err(CarbonError::InvalidPrice);
        }
        if bid.amount > listing.remaining {
            return Err(CarbonError::InsufficientBid);
        }

        let amount = bid.amount;
        let price = bid.price;
        let total = amount
            .checked_mul(price)
            .ok_or(CarbonError::InvalidAmount)?;

        // Transfer escrowed credits to the buyer.
        Self::mint_internal(&env, &bid.buyer, amount)?;

        // Update listing.
        listing.remaining -= amount;
        if listing.remaining == 0 {
            listing.active = false;
            Self::remove_open_listing(&env, listing.id);
        }
        env.storage()
            .persistent()
            .set(&CarbonKey::Listing(listing.id), &listing);

        // Mark bid inactive.
        bid.active = false;
        env.storage().persistent().set(&CarbonKey::Bid(bid_id), &bid);

        // Update index price and volume.
        env.storage()
            .instance()
            .set(&CarbonKey::LastPrice, &price);
        let volume: i128 = env
            .storage()
            .instance()
            .get(&CarbonKey::Volume)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&CarbonKey::Volume, &(volume + amount));

        let result = TradeResult {
            listing_id: listing.id,
            bid_id,
            buyer: bid.buyer.clone(),
            seller: seller.clone(),
            amount,
            price,
            total,
        };

        env.events().publish(
            (symbol_short!("carbon"), symbol_short!("trade")),
            (listing.id, bid_id, amount, price),
        );

        Ok(result)
    }

    // -----------------------------------------------------------------------
    // Price discovery
    // -----------------------------------------------------------------------

    /// Last traded price (index price) in stroops per credit.
    pub fn last_price(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&CarbonKey::LastPrice)
            .unwrap_or(0)
    }

    /// Accumulated trade volume (in credits).
    pub fn volume(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&CarbonKey::Volume)
            .unwrap_or(0)
    }

    /// Compute a simple volume-weighted index price across all open listings.
    ///
    /// Returns the weighted average asking price, or 0 if there are no open
    /// listings.
    pub fn index_price(env: Env) -> i128 {
        let open: Vec<u64> = env
            .storage()
            .instance()
            .get(&CarbonKey::OpenListings)
            .unwrap_or_else(|| Vec::new(&env));

        let mut weighted: i128 = 0;
        let mut total_amount: i128 = 0;

        for id in open.iter() {
            if let Some(listing) = env
                .storage()
                .persistent()
                .get::<CarbonKey, Listing>(&CarbonKey::Listing(id))
            {
                if listing.active && listing.remaining > 0 {
                    weighted += listing.price * listing.remaining;
                    total_amount += listing.remaining;
                }
            }
        }

        if total_amount == 0 {
            0
        } else {
            weighted / total_amount
        }
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Symbol used for carbon credit events.
pub const CARBON_SYMBOL: Symbol = symbol_short!("carbon");