import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import Database from "better-sqlite3";
import * as StellarSdk from "@stellar/stellar-sdk";
import { adminInvoke } from "./stellar.js";
import { logger } from "./logger.js";
import { deadLetterEvents, usageEvents, usageEventsCompacted, usageEventsArchived } from "./metrics.js";

const DB_PATH =
  process.env.USAGE_EVENTS_DB_PATH ??
  path.resolve(process.cwd(), "data", "usage-events.sqlite");
const RETRY_INTERVAL_MS = Number(
  process.env.RETRY_INTERVAL_MS ?? process.env.USAGE_RETRY_INTERVAL_MS ?? 30_000,
);
const MAX_RETRY_ATTEMPTS = Number(process.env.MAX_RETRY_ATTEMPTS ?? 5);
const MAX_RETRIES = MAX_RETRY_ATTEMPTS;

// ── Retention / compaction (Closes #685) ────────────────────────────────────
//
// usage_events grows ~1KB/event; left unbounded it reaches multiple GB within
// months at fleet scale. Detailed rows older than DETAIL_RETENTION_DAYS are
// rolled up into daily (date, meter_id) summaries in usage_summary and
// deleted. Rows older than ARCHIVE_RETENTION_DAYS are additionally dumped to
// a gzipped JSONL file under USAGE_ARCHIVE_DIR before deletion, so the raw
// records aren't lost — point USAGE_ARCHIVE_DIR at a mounted/synced bucket
// (s3fs, gcsfuse, an `aws s3 sync` cron target, etc.) to treat it as cold
// storage without pulling a cloud SDK into this service.
const DETAIL_RETENTION_DAYS = Number(process.env.USAGE_DETAIL_RETENTION_DAYS ?? 90);
const ARCHIVE_RETENTION_DAYS = Number(process.env.USAGE_ARCHIVE_RETENTION_DAYS ?? 365);
const ARCHIVE_DIR =
  process.env.USAGE_ARCHIVE_DIR ?? path.resolve(process.cwd(), "data", "archive");
const COMPACTION_INTERVAL_MS = Number(process.env.USAGE_COMPACTION_INTERVAL_MS ?? 24 * 60 * 60 * 1000);
let compactionTimer: NodeJS.Timeout | undefined;

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

// Cast needed: `moduleResolution: node16` resolves better-sqlite3's export= type
// such that the instance type loses its namespace-declared methods at this call site.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = openDatabase() as any;
let retryTimer: NodeJS.Timeout | undefined;
let retryInFlight = false;
const activeSubmissionIds = new Set<number>();

function openDatabase() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const database = new Database(DB_PATH);
  database.pragma("journal_mode = WAL");
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

    -- Daily per-meter rollup of usage_events older than the detail
    -- retention window (see compactUsageEvents). Primary key is
    -- (date, meter_id) — not just date — so multiple meters on the same
    -- day get distinct rows.
    CREATE TABLE IF NOT EXISTS usage_summary (
      date TEXT NOT NULL,
      meter_id TEXT NOT NULL,
      total_units INTEGER NOT NULL DEFAULT 0,
      total_cost INTEGER NOT NULL DEFAULT 0,
      event_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (date, meter_id)
    );

    CREATE INDEX IF NOT EXISTS idx_usage_summary_meter_date
      ON usage_summary (meter_id, date DESC);
  `);
  return database;
}

export function initUsageEventStore() {
  return db;
}

export function getKV(key: string): string | null {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as any;
  return row?.value ?? null;
}

export function setKV(key: string, value: string) {
  db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(key, value);
}

export function recordUsageEvent(input: CreateUsageEventInput): UsageEventRecord {
  const receivedAt = new Date().toISOString();
  const statement = db.prepare(`
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

  const result = statement.run(
    input.meterId,
    input.units,
    String(input.cost),
    receivedAt,
    input.sourceTopic ?? null
  );

  usageEvents.inc({ status: "pending" });

  return getUsageEventById(Number(result.lastInsertRowid))!;
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

  const events = db
    .prepare(
      "SELECT id, meter_id, units, cost, on_chain_tx_hash, received_at " +
      "FROM usage_events WHERE meter_id = ? ORDER BY received_at DESC, id DESC LIMIT ? OFFSET ?"
    )
    .all(meterId, pageSize, offset) as UsageEventRecord[];

  const { count } = db
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
  const row = db
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
  const stmt = db.prepare(
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

  const insert = db.transaction((rows: Array<{ meterId: string; units: number; cost: number; sourceTopic?: string | null }>) => {
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
    const queued = db
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
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const rows = db
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
  return db
    .prepare("SELECT * FROM usage_events WHERE id = ?")
    .get(id) as UsageEventRecord | undefined;
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

    db.prepare(
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
    ).run(attemptedAt, hash, attemptedAt, id);

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

    db.prepare(
      `
        UPDATE usage_events
        SET status = ?,
            attempt_count = ?,
            last_attempt_at = ?,
            last_error = ?,
            on_chain_tx_hash = NULL
        WHERE id = ?
      `
    ).run(
      finalStatus,
      nextAttemptCount,
      attemptedAt,
      error instanceof Error ? error.message : String(error),
      id
    );

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
  const events = db
    .prepare(
      `SELECT * FROM usage_events
       WHERE status = 'failed'
       ORDER BY last_attempt_at DESC, id DESC
       LIMIT ? OFFSET ?`,
    )
    .all(limit, offset) as UsageEventRecord[];

  const { count } = db
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

  db.prepare(
    `UPDATE usage_events
     SET status = 'pending',
         attempt_count = 0,
         last_error = NULL,
         last_attempt_at = NULL
     WHERE id = ?`,
  ).run(id);

  logger.info({ eventId: id, meterId: event.meter_id }, 'Dead-lettered event requeued for retry');
  return getUsageEventById(id);
}

/** Purge submitted events older than N days. Returns deleted row count. */
export function purgeSubmittedUsageEvents(olderThanDays: number): number {
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
  const result = db
    .prepare("DELETE FROM usage_events WHERE status = 'submitted' AND received_at < ?")
    .run(cutoff);
  return result.changes;
}

export type UsageCompactionResult = {
  /** Detailed rows rolled into usage_summary and deleted. */
  compactedCount: number;
  /** Distinct (date, meter_id) summary rows touched. */
  summaryRowsTouched: number;
  /** Rows additionally written to a cold-storage archive file before deletion. */
  archivedCount: number;
  archiveFile: string | null;
  vacuumed: boolean;
};

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Write rows to a gzipped JSONL "cold storage" archive file before they're
 * deleted from usage_events. Returns the file path, or null if there was
 * nothing to archive.
 */
function archiveUsageEvents(rows: UsageEventRecord[]): string | null {
  if (rows.length === 0) return null;

  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  const fileName = `usage-events-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl.gz`;
  const filePath = path.join(ARCHIVE_DIR, fileName);

  const jsonl = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
  fs.writeFileSync(filePath, zlib.gzipSync(Buffer.from(jsonl, "utf8")));

  return filePath;
}

/**
 * Retention job (Closes #685): rolls detailed 'submitted' usage_events older
 * than `detailedRetentionDays` (default 90) into daily per-meter summaries in
 * usage_summary, archives events older than `archiveRetentionDays` (default
 * 365) to a gzipped JSONL file under USAGE_ARCHIVE_DIR, deletes the now-
 * redundant detail rows, and reclaims disk space with VACUUM.
 *
 * Only 'submitted' events are touched — 'pending' and 'failed' events are
 * left alone so retry/replay flows keep working regardless of age.
 * Idempotent: running it again with nothing left to compact is a no-op.
 */
export function compactUsageEvents(options?: {
  detailedRetentionDays?: number;
  archiveRetentionDays?: number;
}): UsageCompactionResult {
  const detailedRetentionDays = options?.detailedRetentionDays ?? DETAIL_RETENTION_DAYS;
  const archiveRetentionDays = options?.archiveRetentionDays ?? ARCHIVE_RETENTION_DAYS;
  const detailCutoff = isoDaysAgo(detailedRetentionDays);
  const archiveCutoff = isoDaysAgo(archiveRetentionDays);

  // Archive the oldest slice first (and only) — its rows are also covered by
  // the compaction cutoff below, so they get deleted along with everything
  // else once the archive write has succeeded.
  const toArchive = db
    .prepare("SELECT * FROM usage_events WHERE status = 'submitted' AND received_at < ?")
    .all(archiveCutoff) as UsageEventRecord[];
  const archiveFile = archiveUsageEvents(toArchive);
  if (toArchive.length > 0) {
    usageEventsArchived.inc(toArchive.length);
    logger.info("Archived usage events to cold storage", {
      count: toArchive.length,
      archiveFile,
    });
  }

  const summaryUpsert = db.prepare(`
    INSERT INTO usage_summary (date, meter_id, total_units, total_cost, event_count)
    SELECT
      substr(received_at, 1, 10) AS date,
      meter_id,
      SUM(units) AS total_units,
      SUM(CAST(cost AS INTEGER)) AS total_cost,
      COUNT(*) AS event_count
    FROM usage_events
    WHERE status = 'submitted' AND received_at < ?
    GROUP BY date, meter_id
    ON CONFLICT(date, meter_id) DO UPDATE SET
      total_units = total_units + excluded.total_units,
      total_cost = total_cost + excluded.total_cost,
      event_count = event_count + excluded.event_count
  `);

  const runCompaction = db.transaction((cutoff: string) => {
    const summaryResult = summaryUpsert.run(cutoff);
    const deleteResult = db
      .prepare("DELETE FROM usage_events WHERE status = 'submitted' AND received_at < ?")
      .run(cutoff);
    return { summaryRowsTouched: summaryResult.changes, compactedCount: deleteResult.changes };
  });

  const { summaryRowsTouched, compactedCount } = runCompaction(detailCutoff);

  let vacuumed = false;
  if (compactedCount > 0) {
    usageEventsCompacted.inc(compactedCount);
    db.exec("VACUUM");
    vacuumed = true;
    logger.info("Usage event compaction complete", {
      compactedCount,
      summaryRowsTouched,
      archivedCount: toArchive.length,
      detailedRetentionDays,
      archiveRetentionDays,
    });
  }

  return {
    compactedCount,
    summaryRowsTouched,
    archivedCount: toArchive.length,
    archiveFile,
    vacuumed,
  };
}

/** Aggregated daily usage for a meter (or all meters), most recent first. */
export function getUsageSummary(
  meterId?: string,
  limit = 90,
): Array<{ date: string; meter_id: string; total_units: number; total_cost: number; event_count: number }> {
  if (meterId) {
    return db
      .prepare(
        "SELECT date, meter_id, total_units, total_cost, event_count FROM usage_summary WHERE meter_id = ? ORDER BY date DESC LIMIT ?",
      )
      .all(meterId, limit) as any[];
  }
  return db
    .prepare(
      "SELECT date, meter_id, total_units, total_cost, event_count FROM usage_summary ORDER BY date DESC LIMIT ?",
    )
    .all(limit) as any[];
}

/**
 * Start the daily compaction worker. Runs once at the next 2 AM UTC, then
 * every COMPACTION_INTERVAL_MS (default 24h) thereafter.
 */
export function startUsageCompactionWorker() {
  if (compactionTimer) return;

  const runAndReschedule = () => {
    try {
      compactUsageEvents();
    } catch (err) {
      logger.error("Usage event compaction failed", { err });
    }
    compactionTimer = setTimeout(runAndReschedule, COMPACTION_INTERVAL_MS);
    compactionTimer.unref?.();
  };

  const now = new Date();
  const next2am = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 2, 0, 0, 0),
  );
  if (next2am.getTime() <= now.getTime()) {
    next2am.setUTCDate(next2am.getUTCDate() + 1);
  }
  const initialDelayMs = next2am.getTime() - now.getTime();

  logger.info("Usage event compaction worker scheduled", {
    firstRunAt: next2am.toISOString(),
    intervalMs: COMPACTION_INTERVAL_MS,
  });

  compactionTimer = setTimeout(runAndReschedule, initialDelayMs);
  compactionTimer.unref?.();

  process.on("SIGTERM", () => {
    if (compactionTimer) {
      clearTimeout(compactionTimer);
      compactionTimer = undefined;
      logger.info("Usage event compaction worker stopped on SIGTERM");
    }
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
  const row = db
    .prepare(`SELECT COUNT(*) as count FROM usage_events WHERE status = 'failed'`)
    .get() as { count: number };
  return row.count;
}
