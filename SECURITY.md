# Security controls

## Admin two-factor authentication

Set `TWO_FACTOR_ENCRYPTION_KEY` to a long, randomly generated secret before configuring 2FA. Call `POST /api/admin/2fa/setup` with the admin secret once; store the returned recovery codes in a password manager and import the `otpauthUrl` into an authenticator. Subsequent login requests to `POST /api/admin/login` require the six-digit authenticator code or one unused recovery code. Recovery codes are hashed and consumed after one use. All protected admin endpoints reject API-key-only requests once 2FA is enabled.

## Auto top-up

Auto top-up uses the token contract's `transfer_from` allowance. The meter owner must approve the Solar Grid contract before calling `enable_auto_topup`. The trusted oracle/backend may then call `trigger_auto_topup`; it is idempotent while the balance remains above the configured threshold and emits `AutoTopupTriggered` after a successful transfer. Never give the backend an owner's private key.

## Geographic metadata

Meter metadata may include `latitude`, `longitude`, `region`, `provider`, `active`, and `usage`. Coordinates are validated to WGS84 bounds before being returned from `/api/meters/map`; records without valid coordinates are omitted. Do not store personally identifying information in public meter metadata.
