---
name: Bug Report
about: Report a reproducible bug in Stellar SolarGrid
title: "[Bug] Race condition when disconnecting wallet during transaction"
labels: bug
assignees: ''
---

## Describe the Bug

If a user disconnects their Freighter wallet while a payment transaction is being signed, the frontend enters an inconsistent state showing both "Connected" and "Disconnected" indicators simultaneously. Subsequent payment attempts fail with cryptic errors.

## Steps to Reproduce

1. Connect Freighter wallet
2. Initiate a payment from the UserDashboard
3. When the Freighter popup appears, disconnect the wallet from the extension settings
4. Reject or close the transaction popup
5. Observe UI state and attempt another payment

## Expected Behavior

The UI should detect wallet disconnection, clean up any pending transactions, show appropriate error message, and update the connection state atomically.

## Actual Behavior

- WalletConnectButton shows "Connected"
- User address is still displayed in navbar
- Payment attempts fail with "Wallet not found" toast
- Page refresh required to restore correct state

## Screenshots / Logs

```
TypeError: Cannot read properties of undefined (reading 'publicKey')
    at makePayment (UserDashboard.tsx:142)
```

## Environment

| Field | Value |
|-------|-------|
| Component | frontend |
| OS | Windows 11 |
| Node.js version | 20.14.2 |
| Browser | Chrome 124 |
| Freighter version | 5.10.0 |
| Network | testnet |

## Additional Context

The Zustand store likely needs better wallet disconnection event handling with cleanup logic in the wallet service.
