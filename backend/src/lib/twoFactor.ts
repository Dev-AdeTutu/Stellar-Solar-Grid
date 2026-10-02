// #890: TOTP (RFC 6238) two-factor auth with SMS fallback and recovery codes.
//
// This module serves two audiences:
//   - end users enrolling an authenticator app (`enroll`/`verify`/`issueSmsCode`),
//   - the admin console, which additionally stores its TOTP secret encrypted at
//     rest (`setupTwoFactor`/`verifyTwoFactor`).
// Both share the RFC 6238 primitives below.
import crypto, { createCipheriv, createDecipheriv, createHmac, randomBytes } from "crypto";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(s: string): Buffer {
  let bits = 0, value = 0; const out: number[] = [];
  for (const c of s.replace(/=+$/, "").toUpperCase()) {
    const i = B32.indexOf(c);
    if (i < 0) continue;
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export function generateSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

export function totp(secret: string, time = Date.now(), step = 30): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(time / 1000 / step)));
  const h = crypto.createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  const code = (h.readUInt32BE(o) & 0x7fffffff) % 1_000_000;
  return code.toString().padStart(6, "0");
}

function safeEq(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Verifies a TOTP code allowing ±1 step of clock drift. */
export function verifyTotp(secret: string, code: string, time = Date.now()): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  return [-1, 0, 1].some((w) => safeEq(totp(secret, time + w * 30_000), code));
}

export function otpauthUrl(secret: string, account: string, issuer = "SolarGrid"): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}`;
}

const hash = (v: string) => crypto.createHash("sha256").update(v).digest("hex");

interface Enrollment {
  secret: string;
  enabled: boolean;
  phone?: string;
  recoveryHashes: Set<string>;
  sms?: { hash: string; expiresAt: number };
  failures: number;
  lockedUntil: number;
}

const store = new Map<string, Enrollment>();
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60_000;

export function enroll(account: string, phone?: string) {
  const secret = generateSecret();
  store.set(account, { secret, enabled: false, phone, recoveryHashes: new Set(), failures: 0, lockedUntil: 0 });
  return { secret, otpauthUrl: otpauthUrl(secret, account) };
}

export function generateRecoveryCodes(account: string, n = 10): string[] {
  const e = store.get(account);
  if (!e) throw new Error("not enrolled");
  const codes = Array.from({ length: n }, () => crypto.randomBytes(5).toString("hex"));
  e.recoveryHashes = new Set(codes.map(hash));
  return codes;
}

export function issueSmsCode(account: string): { code: string; phone: string } | null {
  const e = store.get(account);
  if (!e?.phone) return null;
  const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
  e.sms = { hash: hash(code), expiresAt: Date.now() + 5 * 60_000 };
  return { code, phone: e.phone };
}

export type VerifyMethod = "totp" | "sms" | "recovery";

export function verify(account: string, code: string, method: VerifyMethod = "totp"): boolean {
  const e = store.get(account);
  if (!e || Date.now() < e.lockedUntil) return false;
  let ok = false;
  if (method === "totp") ok = verifyTotp(e.secret, code);
  else if (method === "sms") {
    ok = !!e.sms && e.sms.expiresAt > Date.now() && safeEq(e.sms.hash, hash(code));
    if (ok) e.sms = undefined;
  } else if (method === "recovery") {
    ok = e.recoveryHashes.delete(hash(code)); // single-use
  }
  if (ok) { e.failures = 0; if (method === "totp") e.enabled = true; }
  else if (++e.failures >= MAX_FAILURES) { e.lockedUntil = Date.now() + LOCK_MS; e.failures = 0; }
  return ok;
}

export function isEnabled(account: string): boolean {
  return !!store.get(account)?.enabled;
}

export function disable(account: string): void {
  store.delete(account);
}

/** Enforcement policy: accounts whose value meets TWO_FACTOR_ENFORCE_THRESHOLD must use 2FA. */
export function isTwoFactorRequired(accountValue: number): boolean {
  const threshold = Number(process.env.TWO_FACTOR_ENFORCE_THRESHOLD ?? 10_000);
  return accountValue >= threshold;
}

// ── Admin 2FA (secret encrypted at rest) ─────────────────────────────────────

const state = new Map<string, { encryptedSecret: string; recoveryHashes: string[] }>();

function encryptionKey(): Buffer {
  const raw = process.env.TWO_FACTOR_ENCRYPTION_KEY;
  if (!raw) throw new Error("TWO_FACTOR_ENCRYPTION_KEY is required when 2FA is enabled");
  return createHmac("sha256", "stellar-solar-grid-2fa").update(raw).digest();
}

function encrypt(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

function decrypt(value: string): string {
  const [iv, tag, ciphertext] = value.split(".").map((part) => Buffer.from(part, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

/** Keyed hash so stored recovery codes are not recoverable from a dump. */
function keyedHash(value: string): string {
  return createHmac("sha256", encryptionKey()).update(value).digest("hex");
}

export function setupTwoFactor(adminId: string): { secret: string; recoveryCodes: string[] } {
  const secret = generateSecret();
  const recoveryCodes = Array.from({ length: 8 }, () => randomBytes(5).toString("hex"));
  state.set(adminId, {
    encryptedSecret: encrypt(secret),
    recoveryHashes: recoveryCodes.map(keyedHash),
  });
  return { secret, recoveryCodes };
}

export function hasTwoFactor(adminId: string): boolean {
  return state.has(adminId);
}

/** Accepts a live TOTP code, or a single-use recovery code. */
export function verifyTwoFactor(adminId: string, code: string): boolean {
  const record = state.get(adminId);
  if (!record) return false;
  if (verifyTotp(decrypt(record.encryptedSecret), code)) return true;
  const hashed = keyedHash(code);
  const index = record.recoveryHashes.indexOf(hashed);
  if (index < 0) return false;
  record.recoveryHashes.splice(index, 1);
  return true;
}

export function resetTwoFactorForTests(): void {
  state.clear();
}
