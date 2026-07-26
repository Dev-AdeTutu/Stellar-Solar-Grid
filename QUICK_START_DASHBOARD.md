# Quick Start - User Dashboard Real Data

## What Was Done

The user dashboard now fetches **real-time data** from the Soroban smart contract instead of mock data.

## Key Files Modified

1. **`frontend/src/lib/contract.ts`**
   - Fixed `MeterData` interface to match v1 contract schema
   - Updated `fetchMeter()` to fetch balance separately via `get_meter_balance()`
   - Added `checkMeterAccess()` function

2. **`frontend/src/services/meterService.ts`**
   - Added `checkAccess()` export

3. **`frontend/src/app/dashboard/user/page.tsx`**
   - Enhanced `MeterCard` to show all real data including expiry
   - Added warnings for expired plans and zero balance
   - Improved access status calculation

## How It Works

```typescript
// 1. Get meter IDs for connected wallet
const meterIds = await getMetersByOwner(walletAddress);

// 2. For each meter, fetch details + balance
const meter = await getMeter(meterId);
// This internally calls:
//   - get_meter(meter_id) → meter details
//   - get_meter_balance(meter_id) → balance

// 3. Display in dashboard
// Shows: balance, active status, units used, plan, last payment, expiry
```

## Testing

1. **Start the frontend**:
   ```bash
   cd frontend
   npm run dev
   ```

2. **Connect Freighter wallet** on the dashboard

3. **Verify data displays**:
   - Balance in XLM
   - Active/Inactive status (green/red badge)
   - Units used in kWh
   - Plan type (Daily/Weekly/UsageBased)
   - Last payment date
   - Expiry date

4. **Test refresh**:
   - Click "↻ Refresh" button
   - Data should reload from contract

5. **Test wallet change**:
   - Disconnect wallet
   - Connect different wallet
   - Data should update automatically

## Contract Functions Used

| Function | Purpose | Returns |
|----------|---------|---------|
| `get_meters_by_owner(address)` | Get meter IDs | `Vec<Symbol>` |
| `get_meter(meter_id)` | Get meter details | `Meter` struct |
| `get_meter_balance(meter_id)` | Get balance | `i128` (stroops) |
| `check_access(meter_id)` | Check access status | `bool` |

## Important Notes

### Balance Storage (v1 Schema)
- In contract v1, balance is **NOT** in the `Meter` struct
- Balance is stored separately via `DataKey::MeterBalance`
- Must call `get_meter_balance()` separately

### Units Used
- Contract stores in **milli-kWh** (units × 1000)
- Dashboard converts to kWh by dividing by 1000

### Access Status
Dashboard calculates: `hasAccess = active && balance > 0 && !expired`

### Expiry Logic
- **Daily plan**: expires_at = last_payment + 86,400 seconds
- **Weekly plan**: expires_at = last_payment + 604,800 seconds  
- **UsageBased plan**: expires_at = u64::MAX (never expires by time)

## Troubleshooting

### "No result from get_meter"
- Meter ID doesn't exist in contract
- Check if meter is registered

### "No result from get_meter_balance"
- Meter exists but has no balance entry
- This is normal for newly registered meters (balance = 0)

### Data not updating
- Check wallet is connected
- Check RPC_URL is correct
- Check CONTRACT_ID is correct
- Open browser console for errors

### TypeScript errors
```bash
cd frontend
npm run build
```

## Next Steps

1. ✅ Dashboard displays real data
2. ✅ Auto-refresh on wallet change
3. ✅ Manual refresh button
4. ✅ Loading and error states
5. ✅ Expiry tracking
6. ✅ Balance warnings

**All acceptance criteria met!** 🎉

## Questions?

Check `DASHBOARD_IMPLEMENTATION.md` for detailed documentation.
