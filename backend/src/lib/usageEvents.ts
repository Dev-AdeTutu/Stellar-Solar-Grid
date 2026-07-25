import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import * as StellarSdk from "@stellar/stellar-sdk";
import { adminInvoke } from "./stellar.js";
import { logger } from "./logger.js";

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

    return getUsageEventById(id);
  } catch (error) {
    const nextAttemptCount = event.attempt_count + 1;
    const finalStatus: UsageEventStatus =
      nextAttemptCount >= MAX_RETRIES ? "failed" : "pending";

    if (finalStatus === "failed") {
      logger.warn({ eventId: id, meterId: event.meter_id, attempts: nextAttemptCount }, 'Usage event dead-lettered after max retries');
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

    throw error;
  } finally {
    activeSubmissionIds.delete(id);
  }
}
