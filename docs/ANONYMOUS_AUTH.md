# Meter Anonymous Authentication (#1058)

Meters authenticate with **RSA blind-signature credentials**, so the backend can confirm a request
comes from *some* verified meter without learning *which* one.

## Protocol

1. **Verification** — an admin marks a device verified: `POST /api/anon-auth/meters/:deviceId`.
2. **Issuance** — the meter picks random serials, blinds each as `m' = H(serial)·rᵉ mod n` and sends
   `POST /api/anon-auth/issue { deviceId, blinded[] }`. The issuer checks verification and the per-epoch
   quota (`ANON_AUTH_QUOTA`, default 100 per `ANON_AUTH_EPOCH_MS`) and returns `s' = m'ᵈ mod n`.
3. **Unblinding** — the meter computes `s = s'·r⁻¹ mod n`. The issuer never saw `serial` or `s`, so a
   credential cannot be linked to the device ID it was issued to.
4. **Authentication** — the meter fetches `GET /api/anon-auth/nonce` and posts
   `POST /api/anon-auth/verify { serial, signature, nonce }`. The backend checks `sᵉ ≡ H(serial) (mod n)`
   and returns a `sessionId`.

`H` is a full-domain hash (SHA-256 in counter mode reduced mod n). The issuer public key is at
`GET /api/anon-auth/public-key`.

## Replay & sharing prevention

- Nonces are single-use and expire after 60 s.
- Each credential serial is single-use; a spent serial is rejected.
- Issuance quotas cap how many credentials a meter can obtain, which bounds the damage of a meter
  sharing credentials with unverified devices.

## Implementation

- Backend: `backend/src/lib/anonymousAuth.ts`, `backend/src/routes/anonymousAuth.ts`
- Client helpers `blind()` / `unblind()` in the same module document the meter-side steps for firmware.
- Tests: `backend/tests/meter-config-pricing-anon.integration.test.ts`
