/**
 * Admin credit-score overrides (#1003).
 *
 * Lets an admin manually pin a user's score and/or credit limit — e.g. to
 * fast-track a known-good customer, or clamp down on one under investigation
 * — independently of what the computed formula in `creditScoring.ts` would
 * say. An override always takes precedence over the computed score while it
 * is active (not expired), and is returned alongside the computed value so
 * callers can see both ("what the formula says" vs "what's actually in
 * effect").
 *
 * One override row per address (latest write wins); `set` is an upsert.
 * Follows the same pooled better-sqlite3 pattern as lib/meterNotes.ts.
 */
import path from "node:path";
import { registerDatabase } from "./databaseLifecycle.js";
import { SqlitePool, type SqlitePoolStatus } from "./sqlitePool.js";
import type Database from "better-sqlite3";

const DB_PATH =
  process.env.CREDIT_OVERRIDES_DB_PATH ??
  path.resolve(process.cwd(), "data", "credit-overrides.sqlite");

export type CreditOverrideRecord = {
  address: string;
  score: number | null;
  credit_limit_stroops: number | null;
  reason: string;
  set_by: string | null;
  created_at: string;
  expires_at: string | null;
};

const pool = new SqlitePool({
  filename: DB_PATH,
  min: Number(process.env.CREDIT_OVERRIDES_POOL_MIN ?? 1),
  max: Number(process.env.CREDIT_OVERRIDES_POOL_MAX ?? 5),
  idleTimeout: Number(process.env.SQLITE_POOL_IDLE_TIMEOUT_MS ?? 30_000),
  acquireTimeout: Number(process.env.SQLITE_POOL_ACQUIRE_TIMEOUT_MS ?? 10_000),
  onOpen: applyCreditOverridesSchema,
});

function applyCreditOverridesSchema(database: Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS credit_overrides (
      address TEXT PRIMARY KEY,
      score INTEGER,
      credit_limit_stroops INTEGER,
      reason TEXT NOT NULL,
      set_by TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT
    );
  `);
}

registerDatabase("credit-overrides", () => {
  pool.drain();
});

pool.warm();

export function initCreditOverridesStore() {
  return pool.primaryDb();
}

export function closeCreditOverridesStore(): void {
  pool.drain();
}

export function getCreditOverridesPoolStatus(): SqlitePoolStatus {
  return pool.status();
}

/** Upsert a manual override for an address. `score`/`creditLimitStroops` are optional — set either or both. */
export function setCreditOverride(input: {
  address: string;
  score?: number | null;
  creditLimitStroops?: number | null;
  reason: string;
  setBy?: string | null;
  expiresAt?: string | null;
}): CreditOverrideRecord {
  const createdAt = new Date().toISOString();
  pool.withConnection((database) => {
    database
      .prepare(
        `INSERT INTO credit_overrides (address, score, credit_limit_stroops, reason, set_by, created_at, expires_at)
         VALUES (@address, @score, @creditLimitStroops, @reason, @setBy, @createdAt, @expiresAt)
         ON CONFLICT (address) DO UPDATE SET
           score = excluded.score,
           credit_limit_stroops = excluded.credit_limit_stroops,
           reason = excluded.reason,
           set_by = excluded.set_by,
           created_at = excluded.created_at,
           expires_at = excluded.expires_at`,
      )
      .run({
        address: input.address,
        score: input.score ?? null,
        creditLimitStroops: input.creditLimitStroops ?? null,
        reason: input.reason,
        setBy: input.setBy ?? null,
        createdAt,
        expiresAt: input.expiresAt ?? null,
      });
  });
  return getCreditOverride(input.address)!;
}

/** Fetch a stored override regardless of expiry (callers decide what "active" means). */
export function getCreditOverride(address: string): CreditOverrideRecord | undefined {
  return pool
    .primaryDb()
    .prepare("SELECT * FROM credit_overrides WHERE address = ?")
    .get(address) as CreditOverrideRecord | undefined;
}

/** Fetch the override only if it exists and has not expired. */
export function getActiveCreditOverride(address: string, now: Date = new Date()): CreditOverrideRecord | undefined {
  const override = getCreditOverride(address);
  if (!override) return undefined;
  if (override.expires_at && new Date(override.expires_at).getTime() <= now.getTime()) return undefined;
  return override;
}

export function clearCreditOverride(address: string): boolean {
  return pool.withConnection((database) => {
    const result = database.prepare("DELETE FROM credit_overrides WHERE address = ?").run(address);
    return (result.changes as number) > 0;
  });
}

export function resetCreditOverridesForTests(): void {
  pool.primaryDb().exec("DELETE FROM credit_overrides");
}
