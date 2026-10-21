/**
 * Provider revenue event store (#1002).
 *
 * Every successful payment (see routes/payments.ts, alongside saveReceipt())
 * is recorded here as a lightweight, queryable row: meter, payer, amount and
 * timestamp. The on-chain contract (`get_provider_revenue`) only exposes a
 * single running total — it has no notion of "revenue between date A and B",
 * so the revenue trends / MRR / ARPU / churn / geo-breakdown analytics in
 * revenueAnalytics.ts are computed from this historical store instead.
 *
 * Geo dimension: there is no dedicated "region" field on a meter anywhere in
 * this codebase. The closest existing geo dimension is the free-text
 * `location` string indexed by lib/meterMetadataIndex.ts (the same index
 * routes/meterMap.ts reads from). We look that up per-meter at write time and
 * store it alongside the payment; meters with no indexed location bucket into
 * "Unknown" in the geo breakdown. This is a simplification, not real
 * geocoding — see API.md for the caveat.
 *
 * Follows the same pooled better-sqlite3 pattern as lib/meterNotes.ts.
 */
import path from "node:path";
import { registerDatabase } from "./databaseLifecycle.js";
import { SqlitePool, type SqlitePoolStatus } from "./sqlitePool.js";
import { getMeterLocationIndex } from "./meterMetadataIndex.js";
import type Database from "better-sqlite3";

const DB_PATH =
  process.env.REVENUE_EVENTS_DB_PATH ??
  path.resolve(process.cwd(), "data", "revenue-events.sqlite");

export type RevenueEventRecord = {
  id: number;
  payment_id: string;
  meter_id: string;
  payer: string | null;
  /** Amount in stroops (1 XLM = 10_000_000 stroops), matching payments.ts. */
  amount: number;
  region: string | null;
  created_at: string;
};

const pool = new SqlitePool({
  filename: DB_PATH,
  min: Number(process.env.REVENUE_EVENTS_POOL_MIN ?? 1),
  max: Number(process.env.REVENUE_EVENTS_POOL_MAX ?? 5),
  idleTimeout: Number(process.env.SQLITE_POOL_IDLE_TIMEOUT_MS ?? 30_000),
  acquireTimeout: Number(process.env.SQLITE_POOL_ACQUIRE_TIMEOUT_MS ?? 10_000),
  onOpen: applyRevenueEventsSchema,
});

function applyRevenueEventsSchema(database: Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS revenue_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payment_id TEXT NOT NULL UNIQUE,
      meter_id TEXT NOT NULL,
      payer TEXT,
      amount INTEGER NOT NULL,
      region TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_revenue_events_created_at
      ON revenue_events (created_at);
    CREATE INDEX IF NOT EXISTS idx_revenue_events_meter
      ON revenue_events (meter_id, created_at);
  `);
}

registerDatabase("revenue-events", () => {
  pool.drain();
});

pool.warm();

export function initRevenueStore() {
  return pool.primaryDb();
}

export function closeRevenueStore(): void {
  pool.drain();
}

export function getRevenueStorePoolStatus(): SqlitePoolStatus {
  return pool.status();
}

/**
 * Record a completed payment for revenue analytics. Idempotent on
 * `payment_id` (the Soroban transaction hash) — a duplicate webhook retry or
 * re-processed event won't double-count revenue.
 */
export function recordRevenueEvent(input: {
  paymentId: string;
  meterId: string;
  amount: number;
  payer?: string | null;
  createdAt?: string;
}): RevenueEventRecord | null {
  const region = (() => {
    try {
      return getMeterLocationIndex(input.meterId);
    } catch {
      return null;
    }
  })();
  const createdAt = input.createdAt ?? new Date().toISOString();

  return pool.withConnection((database) => {
    try {
      database
        .prepare(
          `INSERT INTO revenue_events (payment_id, meter_id, payer, amount, region, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(input.paymentId, input.meterId, input.payer ?? null, input.amount, region, createdAt);
    } catch (err: any) {
      // UNIQUE constraint on payment_id — already recorded, nothing to do.
      if (!String(err?.message ?? "").includes("UNIQUE")) throw err;
      return null;
    }
    return database
      .prepare(`SELECT * FROM revenue_events WHERE payment_id = ?`)
      .get(input.paymentId) as RevenueEventRecord;
  });
}

/**
 * Fetch revenue events, optionally restricted to [from, to) (ISO strings).
 * Returns every row when no bounds are given.
 */
export function getRevenueEvents(range: { from?: string; to?: string } = {}): RevenueEventRecord[] {
  const db = pool.primaryDb();
  const where: string[] = [];
  const params: unknown[] = [];
  if (range.from) {
    where.push("created_at >= ?");
    params.push(range.from);
  }
  if (range.to) {
    where.push("created_at <= ?");
    params.push(range.to);
  }
  return db
    .prepare(
      `SELECT * FROM revenue_events
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY created_at ASC`,
    )
    .all(...params) as RevenueEventRecord[];
}

export function resetRevenueStoreForTests(): void {
  const db = pool.primaryDb();
  db.exec("DELETE FROM revenue_events");
}
