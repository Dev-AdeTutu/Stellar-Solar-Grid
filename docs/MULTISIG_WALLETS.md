# Multi-Signature Wallets (#872)

Organizations (co-ops, landlords, businesses) can hold meters, pay for energy
and receive certificates from an account that requires approval from several
members. The feature has three parts:

| Part | Location |
|---|---|
| N-of-M wallet contract (Soroban custom account) | `contracts/multisig_wallet` |
| Signature collection + email notifications | `backend/src/lib/multisig.ts`, `backend/src/routes/multisig.ts` |
| Approval workflow UI | `frontend/src/app/multisig/page.tsx` |

## How it works

A `multisig_wallet` is a Soroban **custom account**. Its contract address is
used wherever SolarGrid expects an `Address` — as a meter owner, payer,
delegate or certificate holder. Whenever SolarGrid calls `require_auth()` on
that address, the network invokes the wallet's `__check_auth`, which succeeds
only if at least `threshold` distinct registered signers signed the
authorization payload. No SolarGrid contract change is needed: producers and
consumers that are multisig wallets go through exactly the same code paths.

Signers are ed25519 public keys — the keys behind ordinary `G...` accounts —
so every member signs with their existing wallet. The payload is the SHA-256
of the Soroban `HashIdPreimage` for the authorization entry, which is exactly
what SEP-43 `signAuthEntry` signs (Freighter, xBull, Hana, …).

```
member proposes ──► backend simulates call ──► stores auth entry + payload
                                                  │   emails pending signers
members sign preimage in their wallet ◄───────────┘
          │
          └──► backend verifies each signature against payload + signer set
                   │  threshold reached → "ready" email
                   └──► relayer attaches sorted signatures, submits, pays fee
                          network runs __check_auth (N-of-M) → call executes
```

## Deploying a wallet

```bash
cd contracts
cargo build -p multisig_wallet --target wasm32v1-none --release
stellar contract deploy \
  --wasm target/wasm32v1-none/release/multisig_wallet.wasm \
  --source <deployer> --network testnet \
  -- --signers '["<hex ed25519 key 1>","<hex key 2>","<hex key 3>"]' --threshold 2
```

`stellar keys public-key <name>` prints a `G...` address; its raw 32-byte key
(`StrKey.decodeEd25519PublicKey`) is the hex value to pass. Then:

1. Allowlist the wallet address in SolarGrid (`allowlist_add`) and register
   its meters like any owner.
2. Register it with the backend so members get notifications:
   `POST /api/multisig/wallets` (admin key) with `{ address, name, signers:
   [{ publicKey, email, label }] }`. Signers and threshold are read from the
   chain; only labels and emails come from the request.

## Contract API

| Function | Auth | Description |
|---|---|---|
| `__constructor(signers: Vec<BytesN<32>>, threshold: u32)` | deployer | 1 ≤ threshold ≤ signers ≤ 20, no duplicates |
| `get_signers()`, `get_threshold()` | — | Current configuration |
| `add_signer(key)`, `remove_signer(key)`, `set_threshold(t)` | wallet itself (N-of-M) | The set must always be able to reach the threshold |
| `__check_auth(payload, signatures: Vec<Signature>, contexts)` | host | `Signature { public_key: BytesN<32>, signature: BytesN<64> }`, sorted by strictly increasing `public_key` |

Errors: `InvalidThreshold` (1), `DuplicateSigner` (2), `InvalidSignerCount`
(3), `NotEnoughSignatures` (4), `UnknownSigner` (5), `SignaturesNotSorted`
(6), `SignerNotFound` (7), `SignerAlreadyExists` (8). Event: `msig_cfg`
`{ signer_count, threshold }` on every configuration change.

## Backend API

See `backend/openapi.yaml` (tag `multisig`). Proposals are created from a
fixed catalog — `make_payment`, `transfer_meter`, `set_emergency_contact`,
`add_delegate`, `remove_delegate` — so clients never submit raw XDR. A
proposal stays signable for `MULTISIG_SIGNATURE_TTL_LEDGERS` (default 17 280,
about one day); after that it is marked `expired`. Notification links use
`APP_URL`; email delivery uses the existing `EMAIL_PROVIDER` configuration.
Data is stored in `MULTISIG_DB_PATH` (default `data/multisig.sqlite`).

## Security review

Scope: `contracts/multisig_wallet/src/lib.rs`, the backend signature
collection service and its interaction with the SolarGrid contract.
Type: internal review by the implementing team against
[SECURITY_AUDIT_PREP.md](SECURITY_AUDIT_PREP.md). **This is not a third-party
audit.** An independent audit is required before organizations hold
significant funds in these wallets.

| # | Area | Finding | Status |
|---|---|---|---|
| 1 | Signature counting | A single signer submitting its signature several times could satisfy the threshold alone. | **Mitigated**: signatures must be strictly increasing by public key, which rejects duplicates (`SignaturesNotSorted`). Tested. |
| 2 | Unknown keys | Signatures from keys outside the set could be counted. | **Mitigated**: every key must be in the stored signer set (`UnknownSigner`). Tested. |
| 3 | Invalid signatures | A mix of valid and invalid signatures could be accepted. | **Mitigated**: `ed25519_verify` traps on any invalid signature, failing the whole authorization. Tested. |
| 4 | Replay | Approvals for one action could be reused for another, or twice. | **Mitigated by the protocol**: the payload commits to the network, the exact invocation tree (contract, function, arguments, sub-invocations), a nonce and an expiration ledger; the host consumes the nonce. Tested for a different argument. |
| 5 | Signer-set takeover | Anyone changing signers or threshold would bypass N-of-M. | **Mitigated**: management functions call `require_auth` on the wallet itself, so changes need the same N-of-M approval. Tested without auth. |
| 6 | Locking the wallet | Removing signers or raising the threshold could make the wallet unusable. | **Mitigated**: every change re-validates `1 ≤ threshold ≤ signer count`. |
| 7 | Cost / DoS | Large signer sets make `__check_auth` expensive. | **Mitigated**: at most 20 signers; verification is O(signatures × signers) with small constants. |
| 8 | Backend trust | The relayer submits transactions. | **By design**: the relayer only pays fees. It cannot forge approvals — the network verifies every signature in `__check_auth`. A compromised backend can at worst withhold or delay submission, or email misleading descriptions; signers should check the action in their wallet's signing prompt. |
| 9 | Backend input | Garbage signatures could be stored and block submission. | **Mitigated**: each signature is verified against the payload and the on-chain signer set before storage; outsiders get 403, duplicates 409. |
| 10 | Privacy | Signer emails could leak through the API. | **Mitigated**: emails are write-only; responses expose only a `notifications` flag. Wallet registration requires the admin key. |
| 11 | Stale configuration | The backend's copy of the signer set can drift after on-chain changes. | **Operational**: re-register the wallet after changing signers. The chain remains authoritative; a stale copy can only cause a rejected submission, never an unauthorized one. |
| 12 | Proposal expiry | Long-lived approvals widen the window for misuse. | **Mitigated**: authorizations expire at `expirationLedger` on-chain; the backend marks proposals expired as well. |

### Recommendations before mainnet

- Independent audit of `multisig_wallet` and the backend relayer flow.
- Pin signer hardware wallets for high-value organizations and keep
  thresholds above 1.
- Monitor `msig_cfg` events and alert members on any signer-set change.
