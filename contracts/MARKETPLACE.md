# Energy Service Marketplace

## Overview
Complete decentralized marketplace enabling prosumers to offer diverse energy services beyond just selling excess power.

## Features
- ✅ List services (backup power, peak shaving, frequency regulation, load balancing, demand response)
- ✅ Service request and bidding system  
- ✅ Automated service delivery and payment with escrow
- ✅ Rating and review system
- ✅ Dispute resolution
- ✅ Frontend marketplace UI
- ✅ Comprehensive tests

## Smart Contract: EnergyServiceMarketplace.sol

### Service Types
1. **Backup Power** - Emergency power during outages
2. **Peak Shaving** - Reduce peak demand
3. **Frequency Regulation** - Grid stability
4. **Load Balancing** - Distribute energy
5. **Demand Response** - Price-based adjustment

### Core Functions
- `listService()` - Providers list services
- `createServiceRequest()` - Consumers request services
- `placeBid()` - Providers bid on requests
- `acceptBid()` - Consumers accept bids
- `completeDelivery()` - Mark service complete
- `releasePayment()` - Release escrowed funds
- `submitReview()` - Rate and review
- `createDispute()` - Initiate dispute
- `resolveDispute()` - Admin resolution

### Security
- Escrow system for payments
- ReentrancyGuard protection
- Access controls
- Pausable in emergencies
- Platform fee capped at 10%

## Frontend
React-based UI with Web3 integration in `/frontend` directory.

## Testing
Comprehensive test suite covering all functionality in `/test` directory.

## Documentation
- Full API reference in `/docs/API.md`
- Frontend guide in `/frontend/README.md`
- Deployment instructions in root README.md
