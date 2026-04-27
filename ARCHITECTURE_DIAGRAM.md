# User Dashboard Architecture - Visual Guide

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         FRONTEND (Next.js)                          │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐ │
│  │         User Dashboard Page (page.tsx)                        │ │
│  │  • Wallet connection detection                                │ │
│  │  • Auto-refresh on wallet change                              │ │
│  │  • Manual refresh button                                      │ │
│  │  • Loading & error states                                     │ │
│  │  • MeterCard components                                       │ │
│  └────────────────────┬──────────────────────────────────────────┘ │
│                       │                                             │
│                       │ calls                                       │
│                       ↓                                             │
│  ┌───────────────────────────────────────────────────────────────┐ │
│  │         Service Layer (meterService.ts)                       │ │
│  │  • getMeter(meterId)                                          │ │
│  │  • getMetersByOwner(address)                                  │ │
│  │  • checkAccess(meterId)                                       │ │
│  │  • makePayment(...)                                           │ │
│  └────────────────────┬──────────────────────────────────────────┘ │
│                       │                                             │
│                       │ calls                                       │
│                       ↓                                             │
│  ┌───────────────────────────────────────────────────────────────┐ │
│  │         Contract Layer (contract.ts)                          │ │
│  │  • fetchMeter(meterId)                                        │ │
│  │    ├─ get_meter(meter_id)                                     │ │
│  │    └─ get_meter_balance(meter_id)                             │ │
│  │  • fetchMetersByOwner(address)                                │ │
│  │  • checkMeterAccess(meterId)                                  │ │
│  │  • contractInvoke(...)                                        │ │
│  └────────────────────┬──────────────────────────────────────────┘ │
│                       │                                             │
└───────────────────────┼─────────────────────────────────────────────┘
                        │
                        │ RPC calls via Stellar SDK
                        ↓
┌─────────────────────────────────────────────────────────────────────┐
│                    Soroban RPC Server                               │
│              (https://soroban-testnet.stellar.org)                  │
└────────────────────┬────────────────────────────────────────────────┘
                     │
                     │ queries
                     ↓
┌─────────────────────────────────────────────────────────────────────┐
│                  Smart Contract (Rust/Soroban)                      │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  Contract Functions:                                                │
│  ┌───────────────────────────────────────────────────────────────┐ │
│  │ get_meters_by_owner(owner: Address) -> Vec<Symbol>           │ │
│  │   Returns: ["METER1", "METER2", ...]                         │ │
│  └───────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐ │
│  │ get_meter(meter_id: Symbol) -> Meter                          │ │
│  │   Returns: {                                                  │ │
│  │     version: u32,                                             │ │
│  │     owner: Address,                                           │ │
│  │     active: bool,                                             │ │
│  │     units_used: u64,  // milli-kWh                            │ │
│  │     plan: PaymentPlan,                                        │ │
│  │     last_payment: u64,                                        │ │
│  │     expires_at: u64                                           │ │
│  │   }                                                           │ │
│  └───────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐ │
│  │ get_meter_balance(meter_id: Symbol) -> i128                   │ │
│  │   Returns: balance in stroops                                │ │
│  │   Note: Stored separately in v1 schema                        │ │
│  └───────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐ │
│  │ check_access(meter_id: Symbol) -> bool                        │ │
│  │   Returns: active && balance > 0 && now < expires_at         │ │
│  └───────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  Storage:                                                           │
│  • DataKey::Meter(meter_id) -> Meter struct                        │
│  • DataKey::MeterBalance(meter_id) -> i128                         │
│  • DataKey::OwnerMeters(address) -> Vec<Symbol>                    │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Data Flow Sequence

### 1. User Connects Wallet

```
User clicks "Connect Wallet"
    ↓
Freighter wallet opens
    ↓
User approves connection
    ↓
Wallet address stored in state
    ↓
useEffect detects address change
    ↓
Triggers fetchAll()
```

### 2. Fetching Meter Data

```
fetchAll() called
    ↓
┌─────────────────────────────────────────────────────────┐
│ Step 1: Get Meter IDs                                   │
│ getMetersByOwner(address)                               │
│   → RPC: get_meters_by_owner(address)                   │
│   ← Returns: ["METER1", "METER2", "METER3"]             │
└─────────────────────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────────────────────┐
│ Step 2: Fetch Each Meter (Parallel)                     │
│                                                          │
│ Promise.all([                                            │
│   getMeter("METER1"),                                    │
│   getMeter("METER2"),                                    │
│   getMeter("METER3")                                     │
│ ])                                                       │
│                                                          │
│ Each getMeter() does:                                    │
│   ┌─────────────────────────────────────────────────┐   │
│   │ 1. RPC: get_meter(meter_id)                     │   │
│   │    ← Returns: Meter struct (no balance)         │   │
│   │                                                  │   │
│   │ 2. RPC: get_meter_balance(meter_id)             │   │
│   │    ← Returns: i128 balance                      │   │
│   │                                                  │   │
│   │ 3. Combine: { ...meter, balance }               │   │
│   └─────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────────────────────┐
│ Step 3: Update State                                    │
│ setMeterIds(["METER1", "METER2", "METER3"])             │
│ setMeters({                                              │
│   METER1: { ...meterData },                              │
│   METER2: { ...meterData },                              │
│   METER3: { ...meterData }                               │
│ })                                                       │
└─────────────────────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────────────────────┐
│ Step 4: Render MeterCards                               │
│ For each meter ID:                                       │
│   <MeterCard meterId={id} meter={meters[id]} />         │
└─────────────────────────────────────────────────────────┘
```

---

## Component Hierarchy

```
UserDashboardPage
│
├─ Navbar
│
├─ Header Section
│  ├─ Title: "My Meters"
│  ├─ Last Refresh Timestamp
│  └─ Refresh Button
│
├─ Connection State
│  └─ If not connected:
│     └─ Connect Wallet Button
│
├─ Error State
│  └─ If error:
│     ├─ Error Message
│     └─ Retry Button
│
├─ Loading State
│  └─ If loading && no meters:
│     └─ SkeletonCard × 2
│
├─ Empty State
│  └─ If no meters:
│     └─ "No meters registered" message
│
└─ Meter List
   └─ For each meter:
      └─ MeterCard
         ├─ Header
         │  ├─ Meter ID (yellow)
         │  ├─ Status Badge (green/red)
         │  └─ Plan Badge (blue/purple/green)
         │
         ├─ Stats Grid (2×4)
         │  ├─ Balance (XLM)
         │  ├─ Units Used (kWh)
         │  ├─ Last Payment (date)
         │  └─ Expires (date or "Never")
         │
         ├─ Warning (if needed)
         │  └─ Expired or Zero Balance Alert
         │
         └─ Actions
            ├─ Top Up Button
            └─ History Button
```

---

## State Management

```
┌─────────────────────────────────────────────────────────┐
│                    Component State                       │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  address: string | null                                  │
│    ↳ From useWalletStore()                              │
│    ↳ Triggers data fetch when changed                   │
│                                                          │
│  meterIds: string[]                                      │
│    ↳ ["METER1", "METER2", ...]                          │
│    ↳ Set by getMetersByOwner()                          │
│                                                          │
│  meters: Record<string, MeterData>                       │
│    ↳ { METER1: {...}, METER2: {...} }                   │
│    ↳ Set by Promise.all(getMeter())                     │
│                                                          │
│  loading: boolean                                        │
│    ↳ true during fetch                                  │
│    ↳ Shows skeleton cards                               │
│                                                          │
│  error: string | null                                    │
│    ↳ Error message if fetch fails                       │
│    ↳ Shows error UI with retry                          │
│                                                          │
│  lastRefresh: Date | null                                │
│    ↳ Timestamp of last successful fetch                 │
│    ↳ Displayed in header                                │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

---

## Error Handling Flow

```
Try to fetch data
    ↓
    ├─ Success
    │     ↓
    │  Update state
    │     ↓
    │  Show data
    │
    └─ Error
          ↓
       Catch error
          ↓
       Parse error message
          ↓
       ├─ Wallet not connected
       │     → "Please connect your wallet"
       │
       ├─ Network error
       │     → "Network error. Please try again."
       │
       ├─ Contract error
       │     → "Failed to load meters: [error]"
       │
       └─ Unknown error
             → "An unexpected error occurred"
          ↓
       Show error UI
          ↓
       ├─ Error banner with message
       ├─ Retry button
       └─ Toast notification
```

---

## Performance Optimization

### Parallel Fetching
```
Sequential (slow):
  get_meters_by_owner()  ─────┐
                              │ 1s
  get_meter(METER1)      ─────┤
                              │ 1s
  get_meter_balance(M1)  ─────┤
                              │ 1s
  get_meter(METER2)      ─────┤
                              │ 1s
  get_meter_balance(M2)  ─────┤
                              │ 1s
  Total: ~5s

Parallel (fast):
  get_meters_by_owner()  ─────┐
                              │ 1s
  ┌─ get_meter(METER1)   ─────┤
  │  get_meter_balance(M1)    │
  │                           │ 1s (parallel)
  └─ get_meter(METER2)   ─────┤
     get_meter_balance(M2)    │
                              │
  Total: ~2s
```

### Memoization
```typescript
// fetchAll is memoized with useCallback
const fetchAll = useCallback(async () => {
  // Only recreated when address or showToast changes
}, [address, showToast]);

// Prevents unnecessary re-renders
```

---

## Type Safety

```typescript
// Contract returns native types
Contract: get_meter() -> Rust Meter struct

// Stellar SDK converts to JavaScript
SDK: scValToNative() -> JavaScript object

// TypeScript ensures type safety
TypeScript: MeterData interface

// Component receives typed data
Component: meter: MeterData
```

---

## Security Considerations

```
┌─────────────────────────────────────────────────────────┐
│                    Security Layers                       │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  1. Read-Only Queries                                    │
│     • Use throwaway keypairs                             │
│     • No private keys exposed                            │
│     • Simulation only (no actual transactions)           │
│                                                          │
│  2. Wallet Signatures                                    │
│     • Required only for write operations                 │
│     • User must approve in Freighter                     │
│     • Cannot be bypassed                                 │
│                                                          │
│  3. Input Validation                                     │
│     • Meter IDs validated                                │
│     • Addresses validated                                │
│     • Type checking enforced                             │
│                                                          │
│  4. Error Sanitization                                   │
│     • No sensitive data in error messages                │
│     • User-friendly error text                           │
│     • Stack traces hidden                                │
│                                                          │
│  5. Environment Variables                                │
│     • Contract ID from env                               │
│     • RPC URL from env                                   │
│     • Network passphrase from env                        │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

---

## Responsive Design

```
Mobile (< 640px)
┌─────────────────┐
│   My Meters     │
│   [Refresh]     │
├─────────────────┤
│ METER1  [●]     │
│ [Daily]         │
│                 │
│ Balance: 5 XLM  │
│ Units: 100 kWh  │
│ Payment: 1/1/24 │
│ Expires: 1/2/24 │
│                 │
│ [Top Up][Hist]  │
├─────────────────┤
│ METER2  [●]     │
│ ...             │
└─────────────────┘

Desktop (> 640px)
┌───────────────────────────────────────────────┐
│ My Meters              Last: 10:30 [Refresh]  │
├───────────────────────────────────────────────┤
│ METER1                    [●Active] [Daily]   │
│                                               │
│ Balance    Units Used   Last Payment  Expires │
│ 5 XLM      100 kWh      Jan 1, 2024   Jan 2   │
│                                               │
│ [Top Up]  [History]                           │
├───────────────────────────────────────────────┤
│ METER2                    [●Active] [Weekly]  │
│ ...                                           │
└───────────────────────────────────────────────┘
```

---

## Future Enhancements

```
Current Implementation
    ↓
┌─────────────────────────────────────────────────────────┐
│ Phase 1: Real-time Data (✅ DONE)                        │
│ • Fetch from contract                                    │
│ • Display all fields                                     │
│ • Auto-refresh on wallet change                          │
│ • Manual refresh                                         │
└─────────────────────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────────────────────┐
│ Phase 2: Caching & Performance (Future)                 │
│ • React Query integration                                │
│ • Automatic revalidation                                 │
│ • Optimistic updates                                     │
│ • Background refetch                                     │
└─────────────────────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────────────────────┐
│ Phase 3: Real-time Updates (Future)                     │
│ • WebSocket connection                                   │
│ • Live balance updates                                   │
│ • Usage notifications                                    │
│ • Expiry alerts                                          │
└─────────────────────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────────────────────┐
│ Phase 4: Analytics (Future)                             │
│ • Usage charts                                           │
│ • Cost predictions                                       │
│ • Historical trends                                      │
│ • Export data                                            │
└─────────────────────────────────────────────────────────┘
```

---

This architecture provides a solid foundation for the user dashboard with real-time data fetching, proper error handling, and excellent user experience! 🚀
