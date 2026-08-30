import path from "node:path";
import * as StellarSdk from "@stellar/stellar-sdk";
import { adminInvoke } from "./stellar.js";
import { logger } from "./logger.js";
import { deadLetterEvents, usageEvents } from "./metrics.js";
import { registerDatabase } from "./databaseLifecycle.js";
import { getUTCTimestampDaysAgo } from "./dateUtils.js";
import { SqlitePool, type SqlitePoolStatus } from "./sqlitePool.js";
import type Database from "better-sqlite3";

const DB_PATH =
  process.env.USAGE_EVENTS_DB_PATH ??
  path.resolve(process.cwd(), "data", "usage-events.sqlite");
const RETRY_INTERVAL_MS = Number(
  process.env.RETRY_INTERVAL_MS ?? process.env.USAGE_RETRY_INTERVAL_MS ?? 30_000,
);
const MAX_RETRY_ATTEMPTS = Number(process.env.MAX_RETRY_ATTEMPTS ?? 5);
const MAX_RETRIES = MAX_RETRY_ATTEMPTS;

type UsageEventStatus = "pending" | "submitted" | "failed";

export type UsageEventRecord = {
  id: number;
  meter_id: string;
  units: number;
  cost: string;
  received_at: string;
  source_topic: string | null;
  status: UsageEventStatus;
  attempt_count: number;
  last_attempt_at: string | null;
  last_error: string | null;
  on_chain_tx_hash: string | null;
  submitted_at: string | null;
};

type CreateUsageEventInput = {
  meterId: string;
  units: number;
  cost: number;
  sourceTopic?: string | null;
};

// ── #735: connection pooling ─────────────────────────────────────────────────
// Previously every usage-event operation shared a single module-level handle,
// and transient workflows (the IoT bridge submit loop) opened/closed fresh
// connections per operation. We now route all access through a bounded pool:
//   - reads use the long-lived primary handle (stable for prepared/ETag cache);
//   - writes borrow a pooled connection via withConnection() so the bridge's
//     submit loop reuses warm handles instead of re-opening per event;
//   - min/max, idle eviction and acquire timeouts bound resource usage;
//   - status is exposed for health checks / Prometheus (metrics endpoint).
const pool = new SqlitePool({
  filename: DB_PATH,
  min: Number(process.env.USAGE_EVENTS_POOL_MIN ?? 2),
  max: Number(process.env.USAGE_EVENTS_POOL_MAX ?? 10),
  idleTimeout: Number(process.env.SQLITE_POOL_IDLE_TIMEOUT_MS ?? 30_000),
  acquireTimeout: Number(process.env.SQLITE_POOL_ACQUIRE_TIMEOUT_MS ?? 10_000),
  onOpen: applyUsageEventSchema,
});

function applyUsageEventSchema(database: Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS kv (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meter_id TEXT NOT NULL,
      units INTEGER NOT NULL,
      cost TEXT NOT NULL,
      received_at TEXT NOT NULL,
      source_topic TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_attempt_at TEXT,
      last_error TEXT,
      on_chain_tx_hash TEXT,
      submitted_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_usage_events_meter_received_at
      ON usage_events (meter_id, received_at DESC);

    CREATE INDEX IF NOT EXISTS idx_usage_events_retry
      ON usage_events (status, attempt_count, received_at ASC);

    CREATE INDEX IF NOT EXISTS idx_usage_events_status_submitted_at
      ON usage_events (status, submitted_at);
  `);
}

registerDatabase("usage-events", () => {
  pool.drain();
});
let retryTimer: NodeJS.Timeout | undefined;
let retryInFlight = false;
const activeSubmissionIds = new Set<number>();

/** Warm the primary connection so the schema bootstraps at startup. */
pool.warm();

/**
 * Read-path accessor. Returns the stable primary handle used by the paginated
 * and read-only APIs so ETag/prepared caching stays consistent.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function db(): any {
  return pool.primaryDb();
}

export function initUsageEventStore() {
  return pool.primaryDb();
}

/** Close the usage-event store during graceful application shutdown. */
export function closeUsageEventStore(): void {
  if (retryTimer) {
    clearInterval(retryTimer);
    retryTimer = undefined;
  }
  pool.drain();
}

/** Expose pool status for health checks / monitoring (#735). */
export function getUsageEventPoolStatus(): SqlitePoolStatus {
  return pool.status();
}

export function getKV(key: string): string | null {
  const row = db().prepare('SELECT value FROM kv WHERE key = ?').get(key) as any;
  return row?.value ?? null;
}

export function setKV(key: string, value: string) {
  db().prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(key, value);
}

export function recordUsageEvent(input: CreateUsageEventInput): UsageEventRecord {
  const receivedAt = new Date().toISOString();
  const id = pool.withConnection((database) => {
    const statement = database.prepare(`
      INSERT INTO usage_events (
        meter_id,
        units,
        cost,
        received_at,
        source_topic,
        status,
        attempt_count
      ) VALUES (?, ?, ?, ?, ?, 'pending', 0)
    `);
    return statement.run(
      input.meterId,
      input.units,
      String(input.cost),
      receivedAt,
      input.sourceTopic ?? null,
    ).lastInsertRowid;
  });

  usageEvents.inc({ status: "pending" });

  return getUsageEventById(Number(id))!;
}

export function getUsageHistory(
  meterId: string,
  page: number,
  pageSize: number
): {
  events: UsageEventRecord[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
} {
  const offset = (page - 1) * pageSize;

  const events = db()
    .prepare(
      "SELECT id, meter_id, units, cost, on_chain_tx_hash, received_at " +
      "FROM usage_events WHERE meter_id = ? ORDER BY received_at DESC, id DESC LIMIT ? OFFSET ?"
    )
    .all(meterId, pageSize, offset) as UsageEventRecord[];

  const { count } = db()
    .prepare("SELECT COUNT(*) as count FROM usage_events WHERE meter_id = ?")
    .get(meterId) as { count: number };

  return {
    events,
    page,
    pageSize,
    total: count,
    hasMore: offset + pageSize < count,
  };
}

export function getTypicalWeeklyUsageStroops(meterId: string): number {
  const row = db()
    .prepare(
      `
        SELECT COALESCE(SUM(CAST(cost AS INTEGER)), 0) as weekly_cost
        FROM usage_events
        WHERE meter_id = ?
          AND received_at >= datetime('now', '-7 days')
      `,
    )
    .get(meterId) as { weekly_cost: number | null };

  return Number(row?.weekly_cost ?? 0);
}

export async function persistAndSubmitUsageEvent(input: CreateUsageEventInput) {
  const event = recordUsageEvent(input);
  try {
    await submitUsageEvent(event.id);
  } catch {
    // Keep the persisted record for the retry worker.
  }
  return getUsageEventById(event.id)!;
}

/**
 * Insert a batch of usage events and mark them as submitted with a tx hash.
 * This is used by the IoT bridge when it submits a batched update on-chain so
 * each event is persisted locally with the on-chain tx hash.
 */
export function insertSubmittedUsageEvents(
  readings: Array<{ meterId: string; units: number; cost: number; sourceTopic?: string | null }>,
  txHash: string,
) {
  const now = new Date().toISOString();
  pool.withConnection((database) => {
    const stmt = database.prepare(
      `
        INSERT INTO usage_events (
          meter_id,
          units,
          cost,
          received_at,
          source_topic,
          status,
          attempt_count,
          last_attempt_at,
          on_chain_tx_hash,
          submitted_at
        ) VALUES (?, ?, ?, ?, ?, 'submitted', 1, ?, ?, ?)
      `,
    );

    const insert = database.transaction((rows: Array<{ meterId: string; units: number; cost: number; sourceTopic?: string | null }>) => {
      for (const r of rows) {
        stmt.run(
          r.meterId,
          r.units,
          String(r.cost),
          now,
          r.sourceTopic ?? null,
          now,
          txHash,
          now,
        );
        usageEvents.inc({ status: "submitted" });
      }
    });

    insert(readings);
  });
}

export function startUsageEventRetryWorker() {
  if (retryTimer) {
    return;
  }

  logger.info('Usage event retry worker started', { intervalMs: RETRY_INTERVAL_MS, maxRetryAttempts: MAX_RETRY_ATTEMPTS });
  retryTimer = setInterval(() => {
    void retryQueuedUsageEvents();
  }, RETRY_INTERVAL_MS);
  retryTimer.unref?.();

  process.on('SIGTERM', () => {
    if (retryTimer) {
      clearInterval(retryTimer);
      retryTimer = undefined;
      logger.info('Usage event retry worker stopped on SIGTERM');
    }
  });
}

export async function retryQueuedUsageEvents() {
  if (retryInFlight) {
    return;
  }

  retryInFlight = true;
  try {
    const queued = db()
      .prepare(
        `
          SELECT id
          FROM usage_events
          WHERE status IN ('pending', 'failed')
            AND attempt_count < ?
          ORDER BY received_at ASC, id ASC
          LIMIT 25
        `
      )
      .all(MAX_RETRIES) as Array<{ id: number }>;

    for (const { id } of queued) {
      await submitUsageEvent(id);
    }
  } finally {
    retryInFlight = false;
  }
}

export type TopConsumer = {
  meterId: string;
  totalUnits: number;
  rank: number;
};

/** Top consumers by total units used over the last `days` days. */
export function getTopConsumers(days: number, limit = 10): TopConsumer[] {
  // Use UTC-aware timestamp calculation to prevent timezone-dependent cutoff
  const sinceTimestamp = getUTCTimestampDaysAgo(days);
  const since = new Date(sinceTimestamp).toISOString();

  const rows = db()
    .prepare(
      `
        SELECT meter_id AS meterId, SUM(units) AS totalUnits
        FROM usage_events
        WHERE received_at >= ?
        GROUP BY meter_id
        ORDER BY totalUnits DESC
        LIMIT ?
      `
    )
    .all(since, limit) as Array<{ meterId: string; totalUnits: number }>;

  return rows.map((row, index) => ({
    meterId: row.meterId,
    totalUnits: row.totalUnits,
    rank: index + 1,
  }));
}

function getUsageEventById(id: number): UsageEventRecord | undefined {
  return db().prepare("SELECT * FROM usage_events WHERE id = ?").get(id) as UsageEventRecord | undefined;
}

async function submitUsageEvent(id: number) {
  if (activeSubmissionIds.has(id)) {
    return getUsageEventById(id);
  }

  const event = getUsageEventById(id);
  if (!event || event.status === "submitted" || event.attempt_count >= MAX_RETRIES) {
    return event;
  }

  activeSubmissionIds.add(id);
  const attemptedAt = new Date().toISOString();

  try {
    const hash = await adminInvoke("update_usage", [
      StellarSdk.nativeToScVal(event.meter_id, { type: "symbol" }),
      StellarSdk.nativeToScVal(BigInt(event.units), { type: "u64" }),
      StellarSdk.nativeToScVal(BigInt(event.cost), { type: "i128" }),
    ]);

    pool.withConnection((database) => {
      database
        .prepare(
          `
            UPDATE usage_events
            SET status = 'submitted',
                attempt_count = attempt_count + 1,
                last_attempt_at = ?,
                last_error = NULL,
                on_chain_tx_hash = ?,
                submitted_at = ?
            WHERE id = ?
          `
        )
        .run(attemptedAt, hash, attemptedAt, id);
    });

    usageEvents.inc({ status: "submitted" });

    return getUsageEventById(id);
  } catch (error) {
    const nextAttemptCount = event.attempt_count + 1;
    const finalStatus: UsageEventStatus =
      nextAttemptCount >= MAX_RETRIES ? "failed" : "pending";

    if (finalStatus === "failed") {
      logger.error({
        eventId: id,
        meter_id: event.meter_id,
        units: event.units,
        last_error: error instanceof Error ? error.message : String(error),
      }, 'Usage event transitioned to failed state after max retries');
      deadLetterEvents.inc({ meter_id: event.meter_id });
    }

    pool.withConnection((database) => {
      database
        .prepare(
          `
            UPDATE usage_events
            SET status = ?,
                attempt_count = ?,
                last_attempt_at = ?,
                last_error = ?,
                on_chain_tx_hash = NULL
            WHERE id = ?
          `
        )
        .run(
          finalStatus,
          nextAttemptCount,
          attemptedAt,
          error instanceof Error ? error.message : String(error),
          id,
        );
    });

    usageEvents.inc({ status: finalStatus });

    throw error;
  } finally {
    activeSubmissionIds.delete(id);
  }
}

/**
 * Return all events in 'failed' (dead-lettered) status, newest first.
 * Supports optional pagination via limit/offset.
 */
export function getDeadLetterEvents(
  limit = 50,
  offset = 0,
): { events: UsageEventRecord[]; total: number } {
  const events = db()
    .prepare(
      `SELECT * FROM usage_events
       WHERE status = 'failed'
       ORDER BY last_attempt_at DESC, id DESC
       LIMIT ? OFFSET ?`,
    )
    .all(limit, offset) as UsageEventRecord[];

  const { count } = db()
    .prepare(`SELECT COUNT(*) as count FROM usage_events WHERE status = 'failed'`)
    .get() as { count: number };

  return { events, total: count };
}

/**
 * Requeue a dead-lettered event for retry by resetting its status to
 * 'pending' and zeroing the attempt counter.  Returns the updated record,
 * or undefined if the event does not exist or is not in 'failed' state.
 */
export function requeueDeadLetterEvent(id: number): UsageEventRecord | undefined {
  const event = getUsageEventById(id);
  if (!event || event.status !== 'failed') return undefined;

  pool.withConnection((database) => {
    database
      .prepare(
        `UPDATE usage_events
         SET status = 'pending',
             attempt_count = 0,
             last_error = NULL,
             last_attempt_at = NULL
         WHERE id = ?`,
      )
      .run(id);
  });

  logger.info({ eventId: id, meterId: event.meter_id }, 'Dead-lettered event requeued for retry');
  return getUsageEventById(id);
}

/** Purge submitted events older than N days. Returns deleted row count. */
export function purgeSubmittedUsageEvents(olderThanDays: number): number {
  // Use UTC-aware timestamp calculation to prevent timezone-dependent cutoff
  const cutoffTimestamp = getUTCTimestampDaysAgo(olderThanDays);
  const cutoff = new Date(cutoffTimestamp).toISOString();

  return pool.withConnection((database) => {
    const result = database
      .prepare("DELETE FROM usage_events WHERE status = 'submitted' AND received_at < ?")
      .run(cutoff);
    return result.changes;
  });
}

/** Alias for getDeadLetterEvents with page/pageSize convention. */
export function getFailedUsageEvents(
  page: number,
  pageSize: number,
): { events: UsageEventRecord[]; total: number } {
  return getDeadLetterEvents(pageSize, (page - 1) * pageSize);
}

/** Alias for requeueDeadLetterEvent. */
export function replayFailedUsageEvent(id: number): UsageEventRecord | undefined {
  return requeueDeadLetterEvent(id);
}

/** Count of events currently in dead-letter state (used by /health). */
export function countDeadLetterEvents(): number {
  const row = db()
    .prepare(`SELECT COUNT(*) as count FROM usage_events WHERE status = 'failed'`)
    .get() as { count: number };
  return row.count;
}
