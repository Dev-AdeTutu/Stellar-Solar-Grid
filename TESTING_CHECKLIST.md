# User Dashboard Testing Checklist

## Pre-Testing Setup

### Environment Configuration
- [ ] `.env.local` file exists in `frontend/` directory
- [ ] `NEXT_PUBLIC_CONTRACT_ID` is set to deployed contract address
- [ ] `NEXT_PUBLIC_RPC_URL` is set (testnet: `https://soroban-testnet.stellar.org`)
- [ ] `NEXT_PUBLIC_NETWORK_PASSPHRASE` matches network (testnet: `Test SDF Network ; September 2015`)

### Wallet Setup
- [ ] Freighter wallet extension installed in browser
- [ ] Wallet has testnet account with XLM balance
- [ ] At least one meter registered to the wallet address

### Development Server
- [ ] Frontend server running (`npm run dev` in `frontend/` directory)
- [ ] No console errors on page load
- [ ] Dashboard accessible at `/dashboard/user`

---

## Functional Testing

### 1. Initial Page Load (Not Connected)

**Test**: Load dashboard without wallet connected

**Expected**:
- [ ] Page loads without errors
- [ ] Shows "Connect your wallet to view your meters" message
- [ ] "Connect Wallet" button is visible and clickable
- [ ] No meter data displayed
- [ ] No loading indicators
- [ ] No error messages

**Browser Console**:
- [ ] No errors
- [ ] No warnings (except expected Next.js dev warnings)

---

### 2. Wallet Connection

**Test**: Connect Freighter wallet

**Steps**:
1. Click "Connect Wallet" button
2. Freighter popup appears
3. Select account and approve

**Expected**:
- [ ] Freighter popup opens
- [ ] Can select account
- [ ] After approval, popup closes
- [ ] Dashboard immediately starts loading data
- [ ] Loading skeleton cards appear
- [ ] Wallet address stored in state

**Browser Console**:
- [ ] No errors during connection
- [ ] RPC calls visible in Network tab

---

### 3. Data Fetching (Single Meter)

**Test**: Dashboard fetches and displays meter data

**Expected**:
- [ ] Loading skeleton appears
- [ ] After ~1-2 seconds, meter card appears
- [ ] Meter ID displayed correctly (e.g., "METER1")
- [ ] Status badge shows correct state:
  - [ ] Green "Active" if balance > 0 and not expired
  - [ ] Red "Inactive" if balance = 0 or expired
- [ ] Plan badge shows correct plan:
  - [ ] Blue "Daily" for daily plan
  - [ ] Purple "Weekly" for weekly plan
  - [ ] Green "UsageBased" for usage-based plan
- [ ] Balance displays in XLM (e.g., "5.0 XLM")
- [ ] Units used displays in kWh (e.g., "100.5 kWh")
- [ ] Last payment shows date (e.g., "1/15/2024")
- [ ] Expiry shows:
  - [ ] Date for Daily/Weekly plans
  - [ ] "Never (Usage-based)" for UsageBased plans
- [ ] "Top Up" button visible and clickable
- [ ] "History" button visible and clickable

**Browser Console**:
- [ ] Network tab shows:
  - [ ] 1 call to `get_meters_by_owner`
  - [ ] 1 call to `get_meter`
  - [ ] 1 call to `get_meter_balance`
- [ ] No errors

---

### 4. Data Fetching (Multiple Meters)

**Test**: Dashboard with 3+ meters

**Expected**:
- [ ] All meters load in parallel
- [ ] Each meter card displays independently
- [ ] Loading time reasonable (~2-3 seconds for 3 meters)
- [ ] All meter data accurate
- [ ] Cards stack vertically with spacing

**Browser Console**:
- [ ] Network tab shows:
  - [ ] 1 call to `get_meters_by_owner`
  - [ ] N calls to `get_meter` (N = number of meters)
  - [ ] N calls to `get_meter_balance`
- [ ] Calls made in parallel (check timing)

---

### 5. Manual Refresh

**Test**: Click refresh button

**Steps**:
1. Wait for initial data load
2. Note the "Last updated" timestamp
3. Click "↻ Refresh" button

**Expected**:
- [ ] Button shows "Refreshing…" text
- [ ] Button becomes disabled
- [ ] Data reloads from contract
- [ ] "Last updated" timestamp updates
- [ ] Button returns to "↻ Refresh" state
- [ ] Button becomes enabled again

**Browser Console**:
- [ ] New RPC calls made
- [ ] No errors

---

### 6. Wallet Disconnection

**Test**: Disconnect wallet

**Steps**:
1. With data loaded, disconnect wallet via Freighter
2. Or click disconnect in navbar (if implemented)

**Expected**:
- [ ] Meter data clears immediately
- [ ] Shows "Connect your wallet" message again
- [ ] No error messages
- [ ] "Last updated" timestamp clears

**Browser Console**:
- [ ] No errors

---

### 7. Wallet Switch

**Test**: Switch to different wallet

**Steps**:
1. Load dashboard with Wallet A
2. Switch to Wallet B in Freighter
3. Refresh page or reconnect

**Expected**:
- [ ] Dashboard detects address change
- [ ] Automatically fetches data for new wallet
- [ ] Shows meters for Wallet B (not Wallet A)
- [ ] Loading state shown during fetch
- [ ] No stale data from previous wallet

**Browser Console**:
- [ ] New RPC calls with Wallet B address
- [ ] No errors

---

### 8. Error Handling - Network Error

**Test**: Simulate network failure

**Steps**:
1. Open DevTools → Network tab
2. Set throttling to "Offline"
3. Click refresh or reload page

**Expected**:
- [ ] Error message appears
- [ ] Message is user-friendly (not raw error)
- [ ] "Try again" button visible
- [ ] Toast notification appears
- [ ] No crash or blank screen

**Browser Console**:
- [ ] Error logged (expected)
- [ ] No unhandled promise rejections

---

### 9. Error Handling - Invalid Meter

**Test**: Meter doesn't exist

**Setup**: Manually modify code to query non-existent meter

**Expected**:
- [ ] Error message: "Meter not found" or similar
- [ ] Other meters still display (if multiple)
- [ ] Retry button available
- [ ] No crash

---

### 10. Edge Case - No Meters

**Test**: Wallet with no registered meters

**Expected**:
- [ ] No loading skeleton after initial fetch
- [ ] Shows "No meters registered to this address" message
- [ ] No error state
- [ ] Message is centered and clear

---

### 11. Edge Case - Zero Balance

**Test**: Meter with balance = 0

**Expected**:
- [ ] Status badge shows "Inactive" (red)
- [ ] Balance shows "0.0 XLM"
- [ ] Warning alert appears:
  - [ ] Yellow background
  - [ ] Warning icon (⚠)
  - [ ] Text: "Your balance is zero. Top up to restore access."
- [ ] "Top Up" button still functional

---

### 12. Edge Case - Expired Plan

**Test**: Meter with expired Daily/Weekly plan

**Expected**:
- [ ] Status badge shows "Inactive" (red)
- [ ] Expiry date shows in red text
- [ ] Shows "Expired [date]"
- [ ] Warning alert appears:
  - [ ] Text: "Your plan has expired. Top up to restore access."
- [ ] "Top Up" button still functional

---

### 13. Edge Case - UsageBased Plan

**Test**: Meter with UsageBased plan

**Expected**:
- [ ] Plan badge shows "UsageBased" (green)
- [ ] Expiry shows "Never (Usage-based)"
- [ ] No expiry warning (even if expires_at is far future)
- [ ] Status based only on balance and active flag

---

### 14. Navigation - Top Up Button

**Test**: Click "Top Up" button

**Expected**:
- [ ] Navigates to `/pay?meter=METER_ID`
- [ ] Meter ID passed in URL query
- [ ] Payment page loads correctly

---

### 15. Navigation - History Button

**Test**: Click "History" button

**Expected**:
- [ ] Navigates to `/history`
- [ ] History page loads correctly

---

### 16. Responsive Design - Mobile

**Test**: View on mobile device or narrow browser

**Steps**:
1. Open DevTools
2. Toggle device toolbar (mobile view)
3. Test various screen sizes

**Expected**:
- [ ] Layout adapts to narrow screen
- [ ] Stats grid stacks properly (2 columns)
- [ ] Buttons stack vertically if needed
- [ ] Text doesn't overflow
- [ ] All content readable
- [ ] Touch targets large enough

---

### 17. Responsive Design - Desktop

**Test**: View on wide screen

**Expected**:
- [ ] Stats grid shows 4 columns
- [ ] Cards have max-width (not too wide)
- [ ] Centered layout
- [ ] Proper spacing
- [ ] Buttons side-by-side

---

### 18. Performance - Load Time

**Test**: Measure initial load time

**Expected**:
- [ ] Initial page load < 1 second
- [ ] Data fetch completes < 3 seconds (for 3 meters)
- [ ] No layout shift during load
- [ ] Smooth transitions

**Browser DevTools**:
- [ ] Check Performance tab
- [ ] Check Lighthouse score
- [ ] No memory leaks

---

### 19. Accessibility

**Test**: Keyboard navigation and screen readers

**Expected**:
- [ ] Can tab through all interactive elements
- [ ] Focus indicators visible
- [ ] Buttons have proper labels
- [ ] Status badges have semantic meaning
- [ ] Error messages announced by screen reader
- [ ] Loading states announced

**Tools**:
- [ ] Run Lighthouse accessibility audit
- [ ] Test with screen reader (NVDA/JAWS/VoiceOver)

---

### 20. Browser Compatibility

**Test**: Multiple browsers

**Expected to work in**:
- [ ] Chrome/Edge (latest)
- [ ] Firefox (latest)
- [ ] Safari (latest)
- [ ] Mobile Safari (iOS)
- [ ] Chrome Mobile (Android)

---

## Data Accuracy Testing

### Balance Verification

**Test**: Verify balance matches contract

**Steps**:
1. Note balance shown in dashboard
2. Query contract directly via CLI or explorer
3. Compare values

**Expected**:
- [ ] Values match exactly
- [ ] Conversion from stroops to XLM correct
- [ ] No rounding errors

---

### Units Used Verification

**Test**: Verify units match contract

**Steps**:
1. Note units shown in dashboard
2. Query contract directly
3. Compare values

**Expected**:
- [ ] Values match
- [ ] Conversion from milli-kWh to kWh correct (divide by 1000)
- [ ] Decimal places shown correctly

---

### Status Verification

**Test**: Verify active status calculation

**Formula**: `hasAccess = active && balance > 0 && !expired`

**Test Cases**:
- [ ] active=true, balance>0, not expired → Shows "Active" (green)
- [ ] active=false, balance>0, not expired → Shows "Inactive" (red)
- [ ] active=true, balance=0, not expired → Shows "Inactive" (red)
- [ ] active=true, balance>0, expired → Shows "Inactive" (red)

---

### Expiry Verification

**Test**: Verify expiry calculation

**Test Cases**:
- [ ] Daily plan: expires_at = last_payment + 86400 seconds
- [ ] Weekly plan: expires_at = last_payment + 604800 seconds
- [ ] UsageBased: expires_at = u64::MAX → Shows "Never"
- [ ] Expired plan: now > expires_at → Shows "Expired [date]"

---

## Security Testing

### Read-Only Operations

**Test**: Verify no private keys exposed

**Expected**:
- [ ] No private keys in code
- [ ] No private keys in localStorage
- [ ] No private keys in console logs
- [ ] Throwaway keypairs used for queries

---

### Wallet Signature

**Test**: Verify signature only for writes

**Expected**:
- [ ] Reading data doesn't require signature
- [ ] No Freighter popup for read operations
- [ ] Only write operations (make_payment) require signature

---

### Input Validation

**Test**: Invalid inputs handled

**Test Cases**:
- [ ] Invalid meter ID → Error message
- [ ] Invalid address → Error message
- [ ] Malformed data → Error message
- [ ] No crashes or security issues

---

## Regression Testing

After any code changes, re-run:
- [ ] Wallet connection
- [ ] Data fetching (single meter)
- [ ] Manual refresh
- [ ] Error handling
- [ ] Responsive design

---

## Sign-Off

### Developer Testing
- [ ] All functional tests passed
- [ ] All edge cases handled
- [ ] No console errors
- [ ] Performance acceptable
- [ ] Code reviewed

**Tested by**: ________________  
**Date**: ________________

### QA Testing
- [ ] All test cases executed
- [ ] Bugs reported and fixed
- [ ] Regression tests passed
- [ ] Documentation reviewed

**Tested by**: ________________  
**Date**: ________________

### Acceptance
- [ ] Meets all acceptance criteria
- [ ] User experience satisfactory
- [ ] Ready for deployment

**Approved by**: ________________  
**Date**: ________________

---

## Known Issues

Document any known issues or limitations:

1. _______________________________________________
2. _______________________________________________
3. _______________________________________________

---

## Test Results Summary

| Category | Tests | Passed | Failed | Notes |
|----------|-------|--------|--------|-------|
| Functional | 15 | | | |
| Edge Cases | 5 | | | |
| Navigation | 2 | | | |
| Responsive | 2 | | | |
| Performance | 1 | | | |
| Accessibility | 1 | | | |
| Browser Compat | 5 | | | |
| Data Accuracy | 4 | | | |
| Security | 3 | | | |
| **TOTAL** | **38** | | | |

---

## Automated Testing (Future)

Consider adding:
- [ ] Unit tests for contract functions
- [ ] Integration tests for data fetching
- [ ] E2E tests with Playwright/Cypress
- [ ] Visual regression tests
- [ ] Performance benchmarks

---

**Testing completed successfully! ✅**
