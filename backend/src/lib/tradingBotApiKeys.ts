// #891: API key management for trading bots (hashed storage, rotation, quotas, usage stats).
import crypto from "crypto";

interface ApiKey {
  id: string;
  owner: string;
  hash: string;
  createdAt: number;
  revokedAt?: number;
  /** Grace period after rotation during which the old key still works. */
  expiresAt?: number;
  dailyQuota: number;
  usage: { day: string; count: number };
  total: number;
}

const keys = new Map<string, ApiKey>(); // by hash
const hash = (k: string) => crypto.createHash("sha256").update(k).digest("hex");
const today = () => new Date().toISOString().slice(0, 10);
const DEFAULT_QUOTA = Number(process.env.BOT_DAILY_QUOTA ?? 50_000);

export function createKey(owner: string, dailyQuota = DEFAULT_QUOTA) {
  const raw = `sg_${crypto.randomBytes(24).toString("base64url")}`;
  const id = crypto.randomUUID();
  keys.set(hash(raw), { id, owner, hash: hash(raw), createdAt: Date.now(), dailyQuota, usage: { day: today(), count: 0 }, total: 0 });
  return { id, key: raw };
}

export function rotateKey(raw: string, graceMs = 24 * 3600_000) {
  const old = keys.get(hash(raw));
  if (!old || !isActive(old)) return null;
  old.expiresAt = Date.now() + graceMs;
  return createKey(old.owner, old.dailyQuota);
}

export function revokeKey(raw: string): boolean {
  const k = keys.get(hash(raw));
  if (!k) return false;
  k.revokedAt = Date.now();
  return true;
}

function isActive(k: ApiKey) {
  return !k.revokedAt && (!k.expiresAt || k.expiresAt > Date.now());
}

export type CheckResult = { ok: true; key: ApiKey } | { ok: false; status: 401 | 429; error: string };

export function checkAndCount(raw: string): CheckResult {
  const k = keys.get(hash(raw));
  if (!k || !isActive(k)) return { ok: false, status: 401, error: "Invalid or expired API key" };
  if (k.usage.day !== today()) k.usage = { day: today(), count: 0 };
  if (k.usage.count >= k.dailyQuota) return { ok: false, status: 429, error: "Daily quota exceeded" };
  k.usage.count++; k.total++;
  return { ok: true, key: k };
}

export function usageStats() {
  return [...keys.values()].map((k) => ({
    id: k.id, owner: k.owner, active: isActive(k), today: k.usage.count, dailyQuota: k.dailyQuota, total: k.total,
  }));
}
