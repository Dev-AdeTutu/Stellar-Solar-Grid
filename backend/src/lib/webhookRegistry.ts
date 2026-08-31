import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import { logger } from "./logger.js";
import { webhookDeliveries, webhookDeliveryFailures } from "./metrics.js";
import { getReqId } from "./requestContext.js";
import { registerDatabase } from "./databaseLifecycle.js";

const DB_PATH =
  process.env.WEBHOOKS_DB_PATH ??
  path.resolve(process.cwd(), "data", "webhooks.sqlite");

interface WebhookQueueItem {
  url: string;
  payload: string;
  attempt: number;
  nextRetryAt: number;
  /** X-Request-ID to forward on delivery for tracing */
  correlationId?: string;
}

export interface WebhookRecord {
  id: number;
  provider_id: string;
  url: string;
  created_at: string;
  last_triggered_at: string | null;
  failure_count: number;
}

export interface WebhookDelivery {
  id: number;
  webhook_id: number;
  attempted_at: string;
  status: string;
  http_status: number | null;
  error: string | null;
}

const MAX_RETRIES = 5;
const retryQueue: WebhookQueueItem[] = [];
let retryTimerHandle: NodeJS.Timeout | null = null;
let isShuttingDown = false;
let db: any;

// ── Circuit breaker ──────────────────────────────────────────────────────────
// After CIRCUIT_FAILURE_THRESHOLD consecutive delivery failures to a given
// URL, stop attempting deliveries to it for CIRCUIT_COOLDOWN_MS. This avoids
// hammering an endpoint that's known to be down and lets it recover.
const CIRCUIT_FAILURE_THRESHOLD = 10;
const CIRCUIT_COOLDOWN_MS = 5 * 60 * 1000;

const consecutiveFailures = new Map<string, number>();
const circuitOpenUntil = new Map<string, number>();

/** True if the circuit for `url` is currently open (deliveries paused). */
function isCircuitOpen(url: string): boolean {
  const openUntil = circuitOpenUntil.get(url);
  if (openUntil === undefined) return false;
  if (Date.now() >= openUntil) {
    // Cooldown elapsed — close the circuit and give the endpoint a fresh start.
    circuitOpenUntil.delete(url);
    consecutiveFailures.set(url, 0);
    return false;
  }
  return true;
}

function recordDeliverySuccess(url: string): void {
  consecutiveFailures.set(url, 0);
  circuitOpenUntil.delete(url);
}

function recordDeliveryFailure(url: string): void {
  const count = (consecutiveFailures.get(url) ?? 0) + 1;
  consecutiveFailures.set(url, count);
  if (count >= CIRCUIT_FAILURE_THRESHOLD && !circuitOpenUntil.has(url)) {
    const openUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
    circuitOpenUntil.set(url, openUntil);
    logger.error("Webhook circuit breaker opened after consecutive failures", {
      url,
      consecutiveFailures: count,
      cooldownMs: CIRCUIT_COOLDOWN_MS,
      resumesAt: new Date(openUntil).toISOString(),
    });
  }
}

/** Exposed for observability/tests. */
export function getCircuitBreakerState(url: string): {
  open: boolean;
  consecutiveFailures: number;
  openUntil: string | null;
} {
  return {
    open: isCircuitOpen(url),
    consecutiveFailures: consecutiveFailures.get(url) ?? 0,
    openUntil: circuitOpenUntil.has(url)
      ? new Date(circuitOpenUntil.get(url)!).toISOString()
      : null,
  };
}

/** Reset all circuit breaker state. Exposed for tests. */
export function resetCircuitBreakers(): void {
  consecutiveFailures.clear();
  circuitOpenUntil.clear();
}

function openDatabase() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const database = new Database(DB_PATH);
  database.pragma("journal_mode = WAL");
  database.exec(`
    CREATE TABLE IF NOT EXISTS webhooks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_id TEXT NOT NULL,
      url TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(provider_id, url)
    );

    CREATE INDEX IF NOT EXISTS idx_webhooks_provider_id
      ON webhooks (provider_id);

    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      webhook_id INTEGER NOT NULL,
      attempted_at TEXT NOT NULL,
      status TEXT NOT NULL,
      http_status INTEGER,
      error TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook_id
      ON webhook_deliveries (webhook_id);
  `);

  // Safe migration: add columns only if they don't exist yet
  const cols = (database.pragma("table_info(webhooks)") as any[]).map((c: any) => c.name);
  if (!cols.includes("last_triggered_at")) {
    database.exec("ALTER TABLE webhooks ADD COLUMN last_triggered_at TEXT");
  }
  if (!cols.includes("failure_count")) {
    database.exec("ALTER TABLE webhooks ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0");
  }

  registerDatabase("webhooks", () => {
    const closableDatabase = database as any;
    if (closableDatabase.open) closableDatabase.close();
  });
  return database;
}

export function closeWebhookStore(): void {
  if (db?.open) db.close();
  db = undefined;
}

function initDatabase() {
  if (!db) {
    db = openDatabase();
  }
  return db;
}

export function registerWebhook(providerId: string, url: string): WebhookRecord {
  initDatabase();
  const createdAt = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO webhooks (provider_id, url, created_at, failure_count)
    VALUES (?, ?, ?, 0)
  `);
  stmt.run(providerId, url, createdAt);

  const result = db.prepare(
    "SELECT id, provider_id, url, created_at, last_triggered_at, failure_count FROM webhooks WHERE provider_id = ? AND url = ?"
  ).get(providerId, url) as WebhookRecord;

  return result;
}

export function getAllWebhooks(): WebhookRecord[] {
  initDatabase();
  return db.prepare(
    "SELECT id, provider_id, url, created_at, last_triggered_at, failure_count FROM webhooks ORDER BY created_at DESC"
  ).all() as WebhookRecord[];
}

export function getWebhookDeliveries(webhookId: number): WebhookDelivery[] {
  initDatabase();
  return db.prepare(
    "SELECT id, webhook_id, attempted_at, status, http_status, error FROM webhook_deliveries WHERE webhook_id = ? ORDER BY attempted_at DESC LIMIT 50"
  ).all(webhookId) as WebhookDelivery[];
}

export function unregisterWebhook(providerId: string, url: string): boolean {
  initDatabase();
  const stmt = db.prepare(
    "DELETE FROM webhooks WHERE provider_id = ? AND url = ?"
  );
  const result = stmt.run(providerId, url);
  return result.changes > 0;
}

export function getWebhookUrls(providerId?: string): ReadonlySet<string> {
  initDatabase();
  let urls: string[];

  if (providerId) {
    urls = db.prepare(
      "SELECT url FROM webhooks WHERE provider_id = ?"
    ).all(providerId).map((row: any) => row.url);
  } else {
    urls = db.prepare(
      "SELECT url FROM webhooks"
    ).all().map((row: any) => row.url);
  }

  return new Set(urls);
}

export function getWebhooksByProvider(providerId: string): WebhookRecord[] {
  initDatabase();
  return db.prepare(
    "SELECT id, provider_id, url, created_at, last_triggered_at, failure_count FROM webhooks WHERE provider_id = ? ORDER BY created_at DESC"
  ).all(providerId) as WebhookRecord[];
}

/**
 * Fire a webhook with automatic retry on failure.
 * Implements exponential backoff: 1s, 2s, 4s, 8s, 16s (max 5 retries)
 *
 * @param correlationId Optional X-Request-ID to forward on the outbound request for tracing.
 */
export async function fireWebhook(url: string, payload: string, correlationId?: string): Promise<void> {
  return fireWebhookInternal(url, payload, 0, correlationId);
}

async function fireWebhookInternal(
  url: string,
  payload: string,
  attempt: number,
  correlationId?: string,
): Promise<void> {
  // Fall back to the current async context's request ID when not explicitly supplied
  const effectiveCorrelationId = correlationId ?? getReqId();

  if (isCircuitOpen(url)) {
    logger.warn("Webhook circuit breaker open, skipping delivery", {
      url,
      attempt: attempt + 1,
      attemptedAt: new Date().toISOString(),
      correlationId: effectiveCorrelationId,
    });
    return;
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (effectiveCorrelationId) {
    headers["X-Request-ID"] = effectiveCorrelationId;
  }

  const attemptedAt = new Date().toISOString();

  // Resolve the registered webhook row so we can write delivery records
  let webhookId: number | null = null;
  if (db) {
    const row = db.prepare("SELECT id FROM webhooks WHERE url = ?").get(url) as { id: number } | undefined;
    webhookId = row?.id ?? null;
  }

  let httpStatus: number | null = null;
  let deliveryError: string | null = null;
  let succeeded = false;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: payload,
      signal: AbortSignal.timeout(10_000),
    });

    httpStatus = response.status;

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    succeeded = true;
    recordDeliverySuccess(url);
    webhookDeliveries.inc({ status: "success", attempt: String(attempt + 1) });

    if (attempt > 0) {
      logger.info("Webhook delivery succeeded after retry", { url, attempt, correlationId: effectiveCorrelationId });
    }
  } catch (err: any) {
    deliveryError = err.message;
    recordDeliveryFailure(url);
    webhookDeliveries.inc({ status: "failure", attempt: String(attempt + 1) });
    logger.warn("Webhook delivery failed", {
      url,
      attempt: attempt + 1,
      maxRetries: MAX_RETRIES,
      attemptedAt,
      httpStatus,
      error: err.message,
      correlationId: effectiveCorrelationId,
    });

    if (attempt < MAX_RETRIES) {
      const backoffMs = Math.pow(2, attempt) * 1000;
      const nextRetryAt = Date.now() + backoffMs;
      retryQueue.push({ url, payload, attempt: attempt + 1, nextRetryAt, correlationId: effectiveCorrelationId });
      scheduleRetryProcessor();
    } else {
      const urlHash = crypto.createHash("sha256").update(url).digest("hex").slice(0, 12);
      webhookDeliveryFailures.inc({ url_hash: urlHash });
      logger.error("Webhook delivery failed permanently after max retries", {
        url,
        attempts: MAX_RETRIES + 1,
        httpStatus,
        correlationId: effectiveCorrelationId,
      });
    }
  }

  // Persist delivery record and update webhook audit columns
  if (webhookId !== null && db) {
    db.prepare(
      "INSERT INTO webhook_deliveries (webhook_id, attempted_at, status, http_status, error) VALUES (?, ?, ?, ?, ?)"
    ).run(webhookId, attemptedAt, succeeded ? "success" : "failed", httpStatus, deliveryError);

    db.prepare("UPDATE webhooks SET last_triggered_at = ? WHERE id = ?").run(attemptedAt, webhookId);

    if (!succeeded) {
      db.prepare("UPDATE webhooks SET failure_count = failure_count + 1 WHERE id = ?").run(webhookId);
    }
  }
}

/**
 * Process retry queue - fires webhooks that are ready to retry
 */
function processRetryQueue(): void {
  if (retryQueue.length === 0) {
    retryTimerHandle = null;
    return;
  }

  const now = Date.now();
  const readyItems: WebhookQueueItem[] = [];
  const remainingItems: WebhookQueueItem[] = [];

  // Partition queue into ready and not-ready items
  for (const item of retryQueue) {
    if (item.nextRetryAt <= now) {
      readyItems.push(item);
    } else {
      remainingItems.push(item);
    }
  }

  // Update queue
  retryQueue.length = 0;
  retryQueue.push(...remainingItems);

  // Fire ready webhooks
  for (const item of readyItems) {
    fireWebhookInternal(item.url, item.payload, item.attempt, item.correlationId).catch(() => {
      // Errors are handled inside fireWebhookInternal
    });
  }

  // Schedule next processing run
  scheduleRetryProcessor();
}

/**
 * Schedule the next retry processor run
 */
function scheduleRetryProcessor(): void {
  if (retryTimerHandle) return; // Already scheduled
  if (retryQueue.length === 0) return; // Nothing to process

  // Find the earliest retry time
  const nextRetry = Math.min(...retryQueue.map((item) => item.nextRetryAt));
  const delay = Math.max(0, nextRetry - Date.now());

  retryTimerHandle = setTimeout(() => {
    retryTimerHandle = null;
    processRetryQueue();
  }, delay);
}

/**
 * Drain the retry queue on shutdown.
 * Attempts to deliver all pending webhooks immediately.
 */
export async function drainWebhookQueue(): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  if (retryTimerHandle) {
    clearTimeout(retryTimerHandle);
    retryTimerHandle = null;
  }

  if (retryQueue.length === 0) {
    logger.info("Webhook queue empty, nothing to drain");
    return;
  }

  logger.info("Draining webhook retry queue", { pending: retryQueue.length });

  // Fire all pending webhooks immediately (don't retry on failure during shutdown)
  const promises = retryQueue.map((item) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (item.correlationId) {
      headers["X-Request-ID"] = item.correlationId;
    }
    return fetch(item.url, {
      method: "POST",
      headers,
      body: item.payload,
      signal: AbortSignal.timeout(5_000), // Shorter timeout during shutdown
    }).catch((err) => {
      logger.warn("Failed to deliver webhook during shutdown drain", {
        url: item.url,
        attempt: item.attempt,
        error: err.message,
        correlationId: item.correlationId,
      });
    });
  });

  await Promise.allSettled(promises);
  retryQueue.length = 0;
  logger.info("Webhook queue drained");
}

// Register SIGTERM handler to drain queue on shutdown
process.on("SIGTERM", async () => {
  logger.info("SIGTERM received, draining webhook queue");
  await drainWebhookQueue();
});
