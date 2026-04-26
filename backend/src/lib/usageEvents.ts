import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import * as StellarSdk from "@stellar/stellar-sdk";
import { adminInvoke } from "./stellar.js";

const DB_PATH =
  process.env.USAGE_EVENTS_DB_PATH ??
  path.resolve(process.cwd(), "data", "usage-events.sqlite");
const RETRY_INTERVAL_MS = Number(process.env.USAGE_RETRY_INTERVAL_MS ?? 10_000);
const MAX_RETRIES = 3;

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

const db = openDatabase();
let retryTimer: NodeJS.Timeout | undefined;
let retryInFlight = false;
const activeSubmissionIds = new Set<number>();

function openDatabase() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const database = new Database(DB_PATH);
  database.pragma("journal_mode = WAL");
  database.exec(`
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
  data: UsageEventRecord[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
} {
  const totalRow = db
    .prepare("SELECT COUNT(*) as total FROM usage_events WHERE meter_id = ?")
    .get(meterId) as { total: number };
  const total = totalRow.total;
  const offset = (page - 1) * pageSize;
  const data = db
    .prepare(
      `
        SELECT *
        FROM usage_events
        WHERE meter_id = ?
        ORDER BY received_at DESC, id DESC
        LIMIT ? OFFSET ?
      `
    )
    .all(meterId, pageSize, offset) as UsageEventRecord[];

  return {
    data,
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    },
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

export function startUsageEventRetryWorker() {
  if (retryTimer) {
    return;
  }

  retryTimer = setInterval(() => {
    void retryQueuedUsageEvents();
  }, RETRY_INTERVAL_MS);
  retryTimer.unref?.();
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
