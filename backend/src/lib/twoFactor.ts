import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const STEP_SECONDS = 30;
const DIGITS = 6;
const state = new Map<string, { encryptedSecret: string; recoveryHashes: string[] }>();

function encryptionKey(): Buffer {
  const raw = process.env.TWO_FACTOR_ENCRYPTION_KEY;
  if (!raw) throw new Error("TWO_FACTOR_ENCRYPTION_KEY is required when 2FA is enabled");
  return createHmac("sha256", "stellar-solar-grid-2fa").update(raw).digest();
}

function base32Encode(bytes: Buffer): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += alphabet[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(input: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of input.replace(/=+$/, "").toUpperCase()) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new Error("Invalid base32 secret");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function encrypt(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

function decrypt(value: string): string {
  const [iv, tag, ciphertext] = value.split(".").map((part) => Buffer.from(part, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

function codeFor(secret: string, counter: number): string {
  const digest = createHmac("sha1", base32Decode(secret)).update(Buffer.from(BigInt(counter).toString(16).padStart(16, "0"), "hex")).digest();
  const offset = digest[digest.length - 1] & 15;
  const number = (digest.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
  return String(number).padStart(DIGITS, "0");
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function verifyTotp(secret: string, code: string, timestamp = Date.now()): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const counter = Math.floor(timestamp / 1000 / STEP_SECONDS);
  return [-1, 0, 1].some((delta) => {
    const expected = Buffer.from(codeFor(secret, counter + delta));
    const actual = Buffer.from(code);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  });
}

export function setupTwoFactor(adminId: string): { secret: string; recoveryCodes: string[] } {
  const secret = generateTotpSecret();
  const recoveryCodes = Array.from({ length: 8 }, () => randomBytes(5).toString("hex"));
  state.set(adminId, { encryptedSecret: encrypt(secret), recoveryHashes: recoveryCodes.map((code) => createHmac("sha256", encryptionKey()).update(code).digest("hex")) });
  return { secret, recoveryCodes };
}

export function hasTwoFactor(adminId: string): boolean {
  return state.has(adminId);
}

export function verifyTwoFactor(adminId: string, code: string): boolean {
  const record = state.get(adminId);
  if (!record) return false;
  const secret = decrypt(record.encryptedSecret);
  if (verifyTotp(secret, code)) return true;
  const hash = createHmac("sha256", encryptionKey()).update(code).digest("hex");
  const index = record.recoveryHashes.indexOf(hash);
  if (index < 0) return false;
  record.recoveryHashes.splice(index, 1);
  return true;
}

export function resetTwoFactorForTests(): void {
  state.clear();
}
