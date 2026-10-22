/**
 * Anonymous meter authentication via RSA blind signatures (#1058).
 *
 * 1. A verified meter generates random serials, blinds each (m' = H(serial)·rᵉ mod n)
 *    and requests issuance with its device ID. The issuer checks the meter is
 *    registered, enforces a per-epoch quota, and signs blindly (s' = m'ᵈ mod n).
 * 2. The meter unblinds (s = s'·r⁻¹ mod n). (serial, s) is a valid credential
 *    the issuer has never seen, so it cannot be linked back to the device ID.
 * 3. To authenticate, the meter presents (serial, s) bound to a fresh server
 *    nonce. The backend checks sᵉ ≡ H(serial) (mod n), that the nonce is live
 *    and unused, and that the serial was never spent — preventing replay and
 *    limiting sharing (each credential works exactly once).
 */
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";

export const ISSUANCE_QUOTA = Number(process.env.ANON_AUTH_QUOTA ?? 100);
export const EPOCH_MS = Number(process.env.ANON_AUTH_EPOCH_MS ?? 24 * 3600_000);
export const NONCE_TTL_MS = 60_000;

const b64uToBig = (s: string) => BigInt(`0x${Buffer.from(s, "base64url").toString("hex")}`);

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  base %= mod;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod;
    base = (base * base) % mod;
    exp >>= 1n;
  }
  return result;
}

export function modInverse(a: bigint, m: bigint): bigint {
  let [oldR, r] = [((a % m) + m) % m, m];
  let [oldS, s] = [1n, 0n];
  while (r !== 0n) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
  }
  if (oldR !== 1n) throw new Error("not invertible");
  return ((oldS % m) + m) % m;
}

function gcd(a: bigint, b: bigint): bigint {
  while (b) [a, b] = [b, a % b];
  return a;
}

type IssuerKey = { n: bigint; e: bigint; d: bigint; bytes: number };
let key: IssuerKey | undefined;

function issuerKey(): IssuerKey {
  if (!key) {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = privateKey.export({ format: "jwk" });
    const n = b64uToBig(jwk.n!);
    key = { n, e: b64uToBig(jwk.e!), d: b64uToBig(jwk.d!), bytes: Buffer.from(jwk.n!, "base64url").length };
  }
  return key;
}

export const publicKey = () => {
  const { n, e } = issuerKey();
  return { n: n.toString(16), e: e.toString(16) };
};

/** Full-domain hash of a serial into Z_n (SHA-256 in counter mode). */
export function hashToInt(serial: string): bigint {
  const { n, bytes } = issuerKey();
  const chunks: Buffer[] = [];
  for (let i = 0; Buffer.concat(chunks).length < bytes; i++) {
    chunks.push(createHash("sha256").update(`anon-meter:${i}:${serial}`).digest());
  }
  return BigInt(`0x${Buffer.concat(chunks).subarray(0, bytes).toString("hex")}`) % n;
}

// ── Meter (client) side helpers — mirrored by the IoT firmware ──────────────

export function blind(serial: string): { blinded: string; r: string } {
  const { n, e } = issuerKey();
  let r: bigint;
  do r = BigInt(`0x${randomBytes(256).toString("hex")}`) % n;
  while (r < 2n || gcd(r, n) !== 1n);
  return { blinded: ((hashToInt(serial) * modPow(r, e, n)) % n).toString(16), r: r.toString(16) };
}

export function unblind(blindSig: string, r: string): string {
  const { n } = issuerKey();
  return ((BigInt(`0x${blindSig}`) * modInverse(BigInt(`0x${r}`), n)) % n).toString(16);
}

// ── Issuer / verifier ───────────────────────────────────────────────────────

const verifiedMeters = new Set<string>();
const issuance = new Map<string, { epochStart: number; count: number }>();
const spentSerials = new Set<string>();
const nonces = new Map<string, number>();

export const registerVerifiedMeter = (deviceId: string) => verifiedMeters.add(deviceId);

/** Blind-sign credential requests for a verified meter, within its epoch quota. */
export function issueBlindSignatures(deviceId: string, blinded: string[], now = Date.now()): string[] {
  if (!verifiedMeters.has(deviceId)) throw new Error("Meter is not verified");
  const q = issuance.get(deviceId);
  const state = q && now - q.epochStart < EPOCH_MS ? q : { epochStart: now, count: 0 };
  if (state.count + blinded.length > ISSUANCE_QUOTA) throw new Error("Issuance quota exceeded for this epoch");
  const { n, d } = issuerKey();
  const sigs = blinded.map((b) => {
    const m = BigInt(`0x${b}`);
    if (m <= 0n || m >= n) throw new Error("Invalid blinded message");
    return modPow(m, d, n).toString(16);
  });
  state.count += blinded.length;
  issuance.set(deviceId, state);
  return sigs;
}

export function createNonce(now = Date.now()): string {
  for (const [k, exp] of nonces) if (exp <= now) nonces.delete(k);
  const nonce = randomBytes(16).toString("hex");
  nonces.set(nonce, now + NONCE_TTL_MS);
  return nonce;
}

export type VerifyResult = { ok: true; sessionId: string } | { ok: false; reason: string };

/** Verify an anonymous credential presentation. Nonce and serial are each single-use. */
export function verifyCredential(serial: string, signature: string, nonce: string, now = Date.now()): VerifyResult {
  const exp = nonces.get(nonce);
  if (!exp || exp <= now) return { ok: false, reason: "invalid or expired nonce" };
  nonces.delete(nonce);
  if (spentSerials.has(serial)) return { ok: false, reason: "credential already used" };
  const { n, e } = issuerKey();
  let sig: bigint;
  try {
    sig = BigInt(`0x${signature}`);
  } catch {
    return { ok: false, reason: "malformed signature" };
  }
  if (sig <= 0n || sig >= n || modPow(sig, e, n) !== hashToInt(serial)) return { ok: false, reason: "invalid signature" };
  spentSerials.add(serial);
  return { ok: true, sessionId: createHash("sha256").update(`${serial}:${nonce}`).digest("hex").slice(0, 32) };
}

/** Test helper. */
export function resetAnonymousAuth(): void {
  verifiedMeters.clear();
  issuance.clear();
  spentSerials.clear();
  nonces.clear();
}
