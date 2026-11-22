/**
 * Tiered API rate limiting by subscription level (#1080). See API.md.
 *
 * Token-bucket per consumer: each tier refills `requestsPerMinute` tokens per
 * minute up to `requestsPerMinute + burst`, so premium/enterprise consumers
 * can absorb short spikes. Usage counters are tracked in real time per
 * consumer and exposed via /api/rate-limits/usage.
 */

import path from "node:path";
import Database from "better-sqlite3";
import { registerDatabase } from "./databaseLifecycle.js";

export type Tier = "free" | "basic" | "premium" | "enterprise";

export interface TierLimits {
  requestsPerMinute: number;
  requestsPerDay: number;
  /** Extra tokens above the steady rate that may be spent in a spike. */
  burst: number;
}

export const TIERS: Record<Tier, TierLimits> = {
  free: { requestsPerMinute: 10, requestsPerDay: 1_000, burst: 0 },
  basic: { requestsPerMinute: 60, requestsPerDay: 10_000, burst: 0 },
  premium: { requestsPerMinute: 300, requestsPerDay: 100_000, burst: 150 },
  enterprise: { requestsPerMinute: 1_200, requestsPerDay: 1_000_000, burst: 1_200 },
};

const TIER_ORDER: Tier[] = ["free", "basic", "premium", "enterprise"];
/** Fraction of the daily quota at which an upgrade prompt is returned. */
export const UPGRADE_PROMPT_THRESHOLD = 0.8;

interface Usage {
  tokens: number;
  lastRefillMs: number;
  dayKey: string;
  dayCount: number;
  totalCount: number;
}

const DB_PATH =
  process.env.RATE_LIMIT_TIERS_DB_PATH ?? path.resolve(process.cwd(), "data", "rate-limit-tiers.sqlite");

/** Tiers are persisted (#1129) so upgrades survive restarts; `subscriptions` is a read-through cache. */
const subscriptions = new Map<string, Tier>();
const usage = new Map<string, Usage>();

let _db: Database.Database | undefined;

function db(): Database.Database {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.exec(`
      CREATE TABLE IF NOT EXISTS rate_limit_tiers (
        consumer_id TEXT PRIMARY KEY,
        tier TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }
  return _db;
}

registerDatabase("rate-limit-tiers", () => {
  _db?.close();
  _db = undefined;
});

export function isTier(value: unknown): value is Tier {
  return typeof value === "string" && value in TIERS;
}

export function setTier(consumerId: string, tier: Tier): void {
  db()
    .prepare(
      `INSERT INTO rate_limit_tiers (consumer_id, tier, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(consumer_id) DO UPDATE SET tier = excluded.tier, updated_at = excluded.updated_at`,
    )
    .run(consumerId, tier, new Date().toISOString());
  subscriptions.set(consumerId, tier);
  const u = usage.get(consumerId);
  if (u) u.tokens = Math.min(u.tokens, capacity(tier));
}

export function getTier(consumerId: string): Tier {
  const cached = subscriptions.get(consumerId);
  if (cached) return cached;
  const row = db().prepare("SELECT tier FROM rate_limit_tiers WHERE consumer_id = ?").get(consumerId) as
    | { tier: string }
    | undefined;
  if (row && isTier(row.tier)) {
    subscriptions.set(consumerId, row.tier);
    return row.tier;
  }
  // Cache the default too so unsubscribed consumers do not hit SQLite per request.
  subscriptions.set(consumerId, "free");
  return "free";
}

function capacity(tier: Tier): number {
  return TIERS[tier].requestsPerMinute + TIERS[tier].burst;
}

function dayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function load(consumerId: string, now: number): Usage {
  const tier = getTier(consumerId);
  let u = usage.get(consumerId);
  if (!u) {
    u = { tokens: capacity(tier), lastRefillMs: now, dayKey: dayKey(now), dayCount: 0, totalCount: 0 };
    usage.set(consumerId, u);
  }
  const elapsed = now - u.lastRefillMs;
  if (elapsed > 0) {
    u.tokens = Math.min(capacity(tier), u.tokens + (elapsed / 60_000) * TIERS[tier].requestsPerMinute);
    u.lastRefillMs = now;
  }
  if (u.dayKey !== dayKey(now)) {
    u.dayKey = dayKey(now);
    u.dayCount = 0;
  }
  return u;
}

export interface ConsumeResult {
  allowed: boolean;
  tier: Tier;
  limitPerMinute: number;
  remainingMinute: number;
  limitPerDay: number;
  remainingDay: number;
  retryAfterSeconds: number;
  upgrade?: { suggestedTier: Tier; message: string };
}

export function nextTier(tier: Tier): Tier | undefined {
  return TIER_ORDER[TIER_ORDER.indexOf(tier) + 1];
}

function upgradePrompt(tier: Tier, dayCount: number): ConsumeResult["upgrade"] {
  const suggested = nextTier(tier);
  if (!suggested || dayCount < TIERS[tier].requestsPerDay * UPGRADE_PROMPT_THRESHOLD) return undefined;
  const pct = Math.round((dayCount / TIERS[tier].requestsPerDay) * 100);
  return { suggestedTier: suggested, message: `You have used ${pct}% of your ${tier} daily quota. Upgrade to ${suggested} for higher limits.` };
}

export function consume(consumerId: string, now = Date.now()): ConsumeResult {
  const tier = getTier(consumerId);
  const limits = TIERS[tier];
  const u = load(consumerId, now);
  const dayExceeded = u.dayCount >= limits.requestsPerDay;
  const allowed = !dayExceeded && u.tokens >= 1;
  if (allowed) {
    u.tokens -= 1;
    u.dayCount += 1;
    u.totalCount += 1;
  }
  const retryAfterSeconds = allowed
    ? 0
    : dayExceeded
      ? Math.ceil((Date.parse(`${u.dayKey}T00:00:00Z`) + 86_400_000 - now) / 1000)
      : Math.ceil(((1 - u.tokens) / limits.requestsPerMinute) * 60);
  return {
    allowed,
    tier,
    limitPerMinute: limits.requestsPerMinute,
    remainingMinute: Math.floor(u.tokens),
    limitPerDay: limits.requestsPerDay,
    remainingDay: Math.max(limits.requestsPerDay - u.dayCount, 0),
    retryAfterSeconds,
    upgrade: upgradePrompt(tier, u.dayCount),
  };
}

export function getUsage(consumerId: string, now = Date.now()) {
  const tier = getTier(consumerId);
  const u = load(consumerId, now);
  return {
    consumerId,
    tier,
    limits: TIERS[tier],
    tokensAvailable: Math.floor(u.tokens),
    requestsToday: u.dayCount,
    totalRequests: u.totalCount,
    quotaUsedPct: Math.round((u.dayCount / TIERS[tier].requestsPerDay) * 10_000) / 100,
    upgrade: upgradePrompt(tier, u.dayCount) ?? null,
  };
}

/** Drop in-memory state only (simulates a process restart); persisted tiers are kept. */
export function _resetTieredRateLimitCache(): void {
  subscriptions.clear();
  usage.clear();
}

/** Clear in-memory state and persisted tiers (test isolation). */
export function _resetTieredRateLimit(): void {
  _resetTieredRateLimitCache();
  db().prepare("DELETE FROM rate_limit_tiers").run();
}
