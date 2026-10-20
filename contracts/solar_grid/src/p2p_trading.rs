//! Peer-to-Peer (P2P) Energy Trading (Issue #978).
//!
//! Allows solar energy producers with excess capacity to list energy for sale,
//! and consumers to buy directly from peers with automatic order matching and settlement.

use crate::{ContractError, SolarGridContract, SolarGridContractArgs, SolarGridContractClient, EVT_NS};
use soroban_sdk::{contractimpl, contracttype, token, Address, Env, Symbol, Vec};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EnergyListing {
    pub listing_id: u64,
    pub seller: Address,
    pub kwh_available: u64,
    pub price_per_kwh: i128,
    pub active: bool,
    pub created_at: u64,
}

#[contracttype]
#[derive(Clone)]
pub enum P2PKey {
    ListingCount,
    Listing(u64),
    ActiveListingIds,
}

#[contractimpl]
impl SolarGridContract {
    /// List excess energy for sale on the peer-to-peer marketplace.
    /// Emits `EnergyListed`.
    pub fn list_energy_for_sale(
        env: Env,
        seller: Address,
        kwh_available: u64,
        price_per_kwh: i128,
    ) -> Result<u64, ContractError> {
        seller.require_auth();
        Self::require_not_paused(&env)?;

        if kwh_available == 0 || price_per_kwh <= 0 {
            return Err(ContractError::InvalidEnergyListing);
        }

        let count: u64 = env
            .storage()
            .persistent()
            .get(&P2PKey::ListingCount)
            .unwrap_or(0);
        let listing_id = count + 1;
        env.storage().persistent().set(&P2PKey::ListingCount, &listing_id);

        let created_at = env.ledger().timestamp();
        let listing = EnergyListing {
            listing_id,
            seller: seller.clone(),
            kwh_available,
            price_per_kwh,
            active: true,
            created_at,
        };

        env.storage()
            .persistent()
            .set(&P2PKey::Listing(listing_id), &listing);

        let mut active_ids: Vec<u64> = env
            .storage()
            .persistent()
            .get(&P2PKey::ActiveListingIds)
            .unwrap_or_else(|| Vec::new(&env));
        active_ids.push_back(listing_id);
        env.storage()
            .persistent()
            .set(&P2PKey::ActiveListingIds, &active_ids);

        env.events().publish(
            (EVT_NS, Symbol::new(&env, "energy_listed"), listing_id),
            (seller, kwh_available, price_per_kwh),
        );

        Ok(listing_id)
    }

    /// Internal helper to execute peer energy purchase
    fn execute_peer_buy(
        env: &Env,
        buyer: &Address,
        listing_id: u64,
        kwh_to_buy: u64,
    ) -> Result<i128, ContractError> {
        Self::require_not_paused(env)?;

        if kwh_to_buy == 0 {
            return Err(ContractError::InvalidEnergyListing);
        }

        let mut listing: EnergyListing = env
            .storage()
            .persistent()
            .get(&P2PKey::Listing(listing_id))
            .ok_or(ContractError::EnergyListingNotFound)?;

        if !listing.active {
            return Err(ContractError::EnergyListingInactive);
        }

        if kwh_to_buy > listing.kwh_available {
            return Err(ContractError::InsufficientEnergyAvailable);
        }

        let total_price = (kwh_to_buy as i128)
            .checked_mul(listing.price_per_kwh)
            .ok_or(ContractError::ArithmeticOverflow)?;

        // Transfer payment token from buyer to seller
        let token_address = Self::get_token_address(env)?;
        let token_client = token::Client::new(env, &token_address);
        token_client.transfer(buyer, &listing.seller, &total_price);

        listing.kwh_available -= kwh_to_buy;
        if listing.kwh_available == 0 {
            listing.active = false;
        }
        env.storage()
            .persistent()
            .set(&P2PKey::Listing(listing_id), &listing);

        if !listing.active {
            let active_ids: Vec<u64> = env
                .storage()
                .persistent()
                .get(&P2PKey::ActiveListingIds)
                .unwrap_or_else(|| Vec::new(env));
            let mut new_active_ids = Vec::new(env);
            for i in 0..active_ids.len() {
                let id = active_ids.get(i).unwrap();
                if id != listing_id {
                    new_active_ids.push_back(id);
                }
            }
            env.storage()
                .persistent()
                .set(&P2PKey::ActiveListingIds, &new_active_ids);
        }

        env.events().publish(
            (EVT_NS, Symbol::new(env, "energy_traded"), listing_id),
            (listing.seller.clone(), buyer.clone(), kwh_to_buy, total_price),
        );

        Ok(total_price)
    }

    /// Purchase energy directly from a specific peer listing.
    /// Settles payment via the contract's configured token from buyer to seller.
    /// Emits `EnergyTraded`.
    pub fn buy_energy_from_peer(
        env: Env,
        buyer: Address,
        listing_id: u64,
        kwh_to_buy: u64,
    ) -> Result<i128, ContractError> {
        buyer.require_auth();
        Self::execute_peer_buy(&env, &buyer, listing_id, kwh_to_buy)
    }

    /// Automatically find the best priced active listing satisfying the requested kWh and price cap.
    pub fn match_and_buy_energy(
        env: Env,
        buyer: Address,
        kwh_needed: u64,
        max_price_per_kwh: i128,
    ) -> Result<i128, ContractError> {
        buyer.require_auth();
        Self::require_not_paused(&env)?;

        if kwh_needed == 0 {
            return Err(ContractError::InvalidEnergyListing);
        }

        let active_ids: Vec<u64> = env
            .storage()
            .persistent()
            .get(&P2PKey::ActiveListingIds)
            .unwrap_or_else(|| Vec::new(&env));

        let mut best_id: Option<u64> = None;
        let mut lowest_price = i128::MAX;

        for i in 0..active_ids.len() {
            let id = active_ids.get(i).unwrap();
            if let Some(listing) = env
                .storage()
                .persistent()
                .get::<_, EnergyListing>(&P2PKey::Listing(id))
            {
                if listing.active
                    && listing.kwh_available >= kwh_needed
                    && listing.price_per_kwh <= max_price_per_kwh
                    && listing.price_per_kwh < lowest_price
                {
                    lowest_price = listing.price_per_kwh;
                    best_id = Some(id);
                }
            }
        }

        if let Some(id) = best_id {
            Self::execute_peer_buy(&env, &buyer, id, kwh_needed)
        } else {
            Err(ContractError::EnergyListingNotFound)
        }
    }

    /// Cancel an active energy listing.
    pub fn cancel_energy_listing(
        env: Env,
        seller: Address,
        listing_id: u64,
    ) -> Result<(), ContractError> {
        seller.require_auth();
        Self::require_not_paused(&env)?;

        let mut listing: EnergyListing = env
            .storage()
            .persistent()
            .get(&P2PKey::Listing(listing_id))
            .ok_or(ContractError::EnergyListingNotFound)?;

        if listing.seller != seller {
            return Err(ContractError::Unauthorized);
        }

        listing.active = false;
        env.storage()
            .persistent()
            .set(&P2PKey::Listing(listing_id), &listing);

        let active_ids: Vec<u64> = env
            .storage()
            .persistent()
            .get(&P2PKey::ActiveListingIds)
            .unwrap_or_else(|| Vec::new(&env));
        let mut new_active_ids = Vec::new(&env);
        for i in 0..active_ids.len() {
            let id = active_ids.get(i).unwrap();
            if id != listing_id {
                new_active_ids.push_back(id);
            }
        }
        env.storage()
            .persistent()
            .set(&P2PKey::ActiveListingIds, &new_active_ids);

        Ok(())
    }

    /// Get listing details by ID.
    pub fn get_energy_listing(env: Env, listing_id: u64) -> Result<EnergyListing, ContractError> {
        env.storage()
            .persistent()
            .get(&P2PKey::Listing(listing_id))
            .ok_or(ContractError::EnergyListingNotFound)
    }

    /// Get paginated list of active energy listings.
    pub fn get_active_energy_listings(env: Env, offset: u32, limit: u32) -> Vec<EnergyListing> {
        let active_ids: Vec<u64> = env
            .storage()
            .persistent()
            .get(&P2PKey::ActiveListingIds)
            .unwrap_or_else(|| Vec::new(&env));

        let mut results = Vec::new(&env);
        let end = (offset + limit).min(active_ids.len());
        for i in offset..end {
            let id = active_ids.get(i).unwrap();
            if let Some(listing) = env
                .storage()
                .persistent()
                .get::<_, EnergyListing>(&P2PKey::Listing(id))
            {
                if listing.active {
                    results.push_back(listing);
                }
            }
        }
        results
    }
}
