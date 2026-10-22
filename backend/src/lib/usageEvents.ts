import path from "node:path";
import fs from "node:fs";
import zlib from "node:zlib";
import * as StellarSdk from "@stellar/stellar-sdk";
import { adminInvoke } from "./stellar.js";
import { recordAudit } from "./auditTrail.js";
import { logger } from "./logger.js";
import { deadLetterEvents, usageEvents } from "./metrics.js";
import { registerDatabase } from "./databaseLifecycle.js";
import { getUTCTimestampDaysAgo } from "./dateUtils.js";
import { SqlitePool, type SqlitePoolStatus } from "./sqlitePool.js";
import type Database from "better-sqlite3";

const usageEventsCompacted = { inc: (_n?: number) => {} };
const usageEventsArchived = { inc: (_n?: number) => {} };

const DB_PATH =
  process.env.USAGE_EVENTS_DB_PATH ??
  path.resolve(process.cwd(), "data", "usage-events.sqlite");
const RETRY_INTERVAL_MS = Number(
  process.env.RETRY_INTERVAL_MS ?? process.env.USAGE_RETRY_INTERVAL_MS ?? 30_000,
);
const MAX_RETRY_ATTEMPTS = Number(process.env.MAX_RETRY_ATTEMPTS ?? 5);
const MAX_RETRIES = MAX_RETRY_ATTEMPTS;

// ── #1045: state channels for off-chain usage micro-transactions ────────────
//
// Instead of submitting an on-chain `update_usage` transaction for every usage
// update, a meter (or user) opens a payment channel with the contract. Usage
// updates are accumulated off-chain into a monotonically increasing channel
// state, each state update is signed by the channel participant, and only the
// final balance is settled on-chain periodically. Disputes can be raised
// against the last settled state and resolved by submitting the highest signed
// state (the contract verifies the signature and nonce).
const CHANNEL_SETTLEMENT_INTERVAL_MS = Number(
  process.env.CHANNEL_SETTLEMENT_INTERVAL_MS ?? 15 * 60 * 1000,
);
const CHANNEL_DISPUTE_WINDOW_MS = Number(
  process.env.CHANNEL_DISPUTE_WINDOW_MS ?? 24 * 60 * 60 * 1000,
);
const CHANNEL_SIGNING_SECRET =
  process.env.CHANNEL_SIGNING_SECRET ?? "dev-channel-signing-secret";
let channelSettlementTimer: NodeJS.Timeout | undefined;
let channelSettlementInFlight = false;

export type ChannelStatus = "open" | "closing" | "settled" | "disputed";

export type ChannelState = {
  channelId: string;
  meterId: string;
  /** Monotonic off-chain nonce; each signed update increments it by one. */
  nonce: number;
  /** Cumulative units accumulated off-chain since channel open. */
  units: number;
  /** Cumulative cost (stroops) accumulated off-chain since channel open. */
  cost: string;
  /** Last nonce that was settled on-chain. */
  settledNonce: number;
  /** Last cost that was settled on-chain. */
  settledCost: string;
  status: ChannelStatus;
  openedAt: string;
  updatedAt: string;
  settledAt: string | null;
  disputeRaisedAt: string | null;
  disputeReason: string | null;
  /** Signature over the latest off-chain state (hex). */
  signature: string | null;
  /** On-chain tx hash of the most recent settlement. */
  settlementTxHash: string | null;
};

type ChannelStateRow = {
  channel_id: string;
  meter_id: string;
  nonce: number;
  units: number;
  cost: string;
  settled_nonce: number;
  settled_cost: string;
  status: ChannelStatus;
  opened_at: string;
  updated_at: string;
  settled_at: string | null;
  dispute_raised_at: string | null;
  dispute_reason: string | null;
  signature: string | null;
  settlement_tx_hash: string | null;
};

function rowToChannelState(row: ChannelStateRow): ChannelState {
  return {
    channelId: row.channel_id,
    meterId: row.meter_id,
    nonce: Number(row.nonce),
    units: Number(row.units),
    cost: row.cost,
    settledNonce: Number(row.settled_nonce),
    settledCost: row.settled_cost,
    status: row.status,
    openedAt: row.opened_at,
    updatedAt: row.updated_at,
    settledAt: row.settled_at,
    disputeRaisedAt: row.dispute_raised_at,
    disputeReason: row.dispute_reason,
    signature: row.signature,
    settlementTxHash: row.settlement_tx_hash,
  };
}

/** Deterministic channel id for a meter (one active channel per meter). */
export function deriveChannelId(meterId: string): string {
  return crypto.createHash("sha256").update(`channel:${meterId}`).digest("hex").slice(0, 32);
}

/**
 * Sign an off-chain channel state. The signature binds the channel id, nonce,
 * units and cost so a stale or tampered state cannot be replayed on-chain.
 */
export function signChannelState(state: {
  channelId: string;
  nonce: number;
  units: number;
  cost: string;
}): string {
  const payload = `${state.channelId}:${state.nonce}:${state.units}:${state.cost}`;
  return crypto
    .createHmac("sha256", CHANNEL_SIGNING_SECRET)
    .update(payload)
    .digest("hex");
}

/** Verify a channel state signature (used before settlement and in disputes). */
export function verifyChannelStateSignature(state: {
  channelId: string;
  nonce: number;
  units: number;
  cost: string;
  signature: string | null;
}): boolean {
  if (!state.signature) return false;
  const expected = signChannelState(state);
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(state.signature, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function getChannelRow(channelId: string): ChannelStateRow | undefined {
  return db()
    .prepare("SELECT * FROM usage_channels WHERE channel_id = ?")
    .get(channelId) as ChannelStateRow | undefined;
}

export function getChannel(channelId: string): ChannelState | undefined {
  const row = getChannelRow(channelId);
  return row ? rowToChannelState(row) : undefined;
}

export function getChannelByMeter(meterId: string): ChannelState | undefined {
  return getChannel(deriveChannelId(meterId));
}

/**
 * Open a payment channel for a meter. Idempotent: returns the existing open
 * channel if one already exists. The channel is registered on-chain via the
 * contract's `open_channel` entrypoint.
 */
export async function openChannel(meterId: string): Promise<ChannelState> {
  const channelId = deriveChannelId(meterId);
  const existing = getChannel(channelId);
  if (existing && existing.status !== "settled") {
    return existing;
  }

  const now = new Date().toISOString();
  const initialState = { channelId, nonce: 0, units: 0, cost: "0" };
  const signature = signChannelState(initialState);

  let txHash: string | null = null;
  try {
    txHash = await adminInvoke("open_channel", [
      StellarSdk.nativeToScVal(channelId, { type: "string" }),
      StellarSdk.nativeToScVal(meterId, { type: "symbol" }),
    ]);
  } catch (error) {
    logger.warn("Failed to register channel on-chain; keeping local channel", {
      channelId,
      meterId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  pool.withConnection((database) => {
    database
      .prepare(
        `
          INSERT INTO usage_channels (
            channel_id, meter_id, nonce, units, cost, settled_nonce, settled_cost,
            status, opened_at, updated_at, signature, settlement_tx_hash
          ) VALUES (?, ?, 0, 0, '0', 0, '0', 'open', ?, ?, ?, ?)
          ON CONFLICT(channel_id) DO UPDATE SET
            status = 'open',
            nonce = 0,
            units = 0,
            cost = '0',
            settled_nonce = 0,
            settled_cost = '0',
            opened_at = excluded.opened_at,
            updated_at = excluded.updated_at,
            settled_at = NULL,
            dispute_raised_at = NULL,
            dispute_reason = NULL,
            signature = excluded.signature,
            settlement_tx_hash = excluded.settlement_tx_hash
        `,
      )
      .run(channelId, meterId, now, now, signature, txHash);
  });

  recordAudit({
    action: "channel_opened",
    meterId,
    txHash: txHash ?? undefined,
    details: { channelId },
  });

  return getChannel(channelId)!;
}

/**
 * Accumulate a usage update off-chain. No on-chain transaction is submitted;
 * the channel state is advanced and re-signed. Returns the updated channel.
 */
export function accumulateChannelUsage(input: {
  meterId: string;
  units: number;
  cost: number;
}): ChannelState {
  const channelId = deriveChannelId(input.meterId);
  const existing = getChannel(channelId);
  if (!existing) {
    throw new Error(`No open channel for meter ${input.meterId}`);
  }
  if (existing.status === "settled") {
    throw new Error(`Channel ${channelId} is already settled`);
  }
  if (existing.status === "disputed") {
    throw new Error(`Channel ${channelId} is under dispute`);
  }

  const nextNonce = existing.nonce + 1;
  const nextUnits = existing.units + input.units;
  const nextCost = (BigInt(existing.cost) + BigInt(Math.trunc(input.cost))).toString();
  const signature = signChannelState({
    channelId,
    nonce: nextNonce,
    units: nextUnits,
    cost: nextCost,
  });
  const now = new Date().toISOString();

  pool.withConnection((database) => {
    database
      .prepare(
        `
          UPDATE usage_channels
          SET nonce = ?, units = ?, cost = ?, signature = ?, updated_at = ?
          WHERE channel_id = ?
        `,
      )
      .run(nextNonce, nextUnits, nextCost, signature, now, channelId);
  });

  return getChannel(channelId)!;
}

/**
 * Settle a channel's accumulated balance on-chain. Only the delta since the
 * last settlement is submitted, so N off-chain updates cost one on-chain tx.
 */
export async function settleChannel(channelId: string): Promise<ChannelState> {
  const channel = getChannel(channelId);
  if (!channel) {
    throw new Error(`Unknown channel ${channelId}`);
  }
  if (channel.status === "settled") {
    return channel;
  }
  if (channel.nonce <= channel.settledNonce) {
    return channel;
  }
  if (!verifyChannelStateSignature(channel)) {
    throw new Error(`Invalid signature for channel ${channelId}`);
  }

  const deltaCost = (BigInt(channel.cost) - BigInt(channel.settledCost)).toString();
  const deltaUnits = channel.units - (channel.settledNonce === 0 ? 0 : 0);

  const txHash = await adminInvoke("settle_channel", [
    StellarSdk.nativeToScVal(channelId, { type: "string" }),
    StellarSdk.nativeToScVal(BigInt(channel.nonce), { type: "u64" }),
    StellarSdk.nativeToScVal(BigInt(channel.units), { type: "u64" }),
    StellarSdk.nativeToScVal(BigInt(deltaCost), { type: "i128" }),
    StellarSdk.nativeToScVal(channel.signature ?? "", { type: "string" }),
  ]);

  const now = new Date().toISOString();
  pool.withConnection((database) => {
    database
      .prepare(
        `
          UPDATE usage_channels
          SET settled_nonce = ?, settled_cost = ?, settled_at = ?,
              settlement_tx_hash = ?, updated_at = ?
          WHERE channel_id = ?
        `,
      )
      .run(channel.nonce, channel.cost, now, txHash, now, channelId);
  });

  recordAudit({
    action: "channel_settled",
    meterId: channel.meterId,
    amount: deltaCost,
    txHash,
    details: { channelId, nonce: channel.nonce, units: channel.units, deltaUnits },
  });

  return getChannel(channelId)!;
}

/**
 * Raise a dispute against a channel. The channel is frozen (no further
 * off-chain updates) until resolved. The dispute window allows the contract
 * to accept the highest signed state.
 */
export function raiseChannelDispute(channelId: string, reason: string): ChannelState {
  const channel = getChannel(channelId);
  if (!channel) {
    throw new Error(`Unknown channel ${channelId}`);
  }
  if (channel.status === "settled") {
    throw new Error(`Channel ${channelId} is already settled`);
  }

  const now = new Date().toISOString();
  pool.withConnection((database) => {
    database
      .prepare(
        `
          UPDATE usage_channels
          SET status = 'disputed', dispute_raised_at = ?, dispute_reason = ?, updated_at = ?
          WHERE channel_id = ?
        `,
      )
      .run(now, reason, now, channelId);
  });

  recordAudit({
    action: "channel_dispute_raised",
    meterId: channel.meterId,
    details: { channelId, reason, nonce: channel.nonce },
  });

  return getChannel(channelId)!;
}

/**
 * Resolve a dispute by submitting the highest signed state to the contract.
 * The contract verifies the signature and nonce and settles the channel.
 */
export async function resolveChannelDispute(channelId: string): Promise<ChannelState> {
  const channel = getChannel(channelId);
  if (!channel) {
    throw new Error(`Unknown channel ${channelId}`);
  }
  if (channel.status !== "disputed") {
    throw new Error(`Channel ${channelId} is not under dispute`);
  }
  if (!verifyChannelStateSignature(channel)) {
    throw new Error(`Invalid signature for disputed channel ${channelId}`);
  }

  const txHash = await adminInvoke("resolve_dispute", [
    StellarSdk.nativeToScVal(channelId, { type: "string" }),
    StellarSdk.nativeToScVal(BigInt(channel.nonce), { type: "u64" }),
    StellarSdk.nativeToScVal(BigInt(channel.units), { type: "u64" }),
    StellarSdk.nativeToScVal(BigInt(channel.cost), { type: "i128" }),
    StellarSdk.nativeToScVal(channel.signature ?? "", { type: "string" }),
  ]);

  const now = new Date().toISOString();
  pool.withConnection((database) => {
    database
      .prepare(
        `
          UPDATE usage_channels
          SET status = 'settled', settled_nonce = ?, settled_cost = ?,
              settled_at = ?, settlement_tx_hash = ?, updated_at = ?
          WHERE channel_id = ?
        `,
      )
      .run(channel.nonce, channel.cost, now, txHash, now, channelId);
  });

  recordAudit({
    action: "channel_dispute_resolved",
    meterId: channel.meterId,
    amount: channel.cost,
    txHash,
    details: { channelId, nonce: channel.nonce, units: channel.units },
  });

  return getChannel(channelId)!;
}

/**
 * Settle every channel that has unsettled off-chain updates. Called
 * periodically by the settlement worker. Returns the settled channels.
 */
export async function settlePendingChannels(): Promise<ChannelState[]> {
  const rows = db()
    .prepare(
      `SELECT channel_id FROM usage_channels
       WHERE status = 'open' AND nonce > settled_nonce
       ORDER BY updated_at ASC LIMIT 50`,
    )
    .all() as Array<{ channel_id: string }>;

  const settled: ChannelState[] = [];
  for (const { channel_id } of rows) {
    try {
      settled.push(await settleChannel(channel_id));
    } catch (error) {
      logger.error("Channel settlement failed", {
        channelId: channel_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return settled;
}

/**
 * Start the periodic channel settlement worker. Off-chain updates accumulate
 * between runs; each run submits one on-chain settlement per active channel.
 */
export function startChannelSettlementWorker() {
  if (channelSettlementTimer) return;

  logger.info("Channel settlement worker started", {
    intervalMs: CHANNEL_SETTLEMENT_INTERVAL_MS,
    disputeWindowMs: CHANNEL_DISPUTE_WINDOW_MS,
  });

  channelSettlementTimer = setInterval(() => {
    if (channelSettlementInFlight) return;
    channelSettlementInFlight = true;
    void settlePendingChannels()
      .catch((err) => logger.error("Channel settlement run failed", { err }))
      .finally(() => {
        channelSettlementInFlight = false;
      });
  }, CHANNEL_SETTLEMENT_INTERVAL_MS);
  channelSettlementTimer.unref?.();

  process.on("SIGTERM", () => {
    if (channelSettlementTimer) {
      clearInterval(channelSettlementTimer);
      channelSettlementTimer = undefined;
      logger.info("Channel settlement worker stopped on SIGTERM");
    }
  });
}

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
  reading_id?: string | null;
};

type CreateUsageEventInput = {
  meterId: string;
  units: number;
  cost: number;
  sourceTopic?: string | null;
  readingId?: string;
  energySources?: { solar: number; grid: number; battery: number };
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

    -- #990: grid export credit tracking. Each row records a bidirectional
    -- meter reading's export side (kWh delivered to the grid) along with the
    -- credit earned at the configured export rate, so users can be settled.
    CREATE TABLE IF NOT EXISTS grid_exports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meter_id TEXT NOT NULL,
      kwh REAL NOT NULL,
      credit TEXT NOT NULL,
      rate TEXT NOT NULL,
      received_at TEXT NOT NULL,
      on_chain_tx_hash TEXT,
      submitted_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_grid_exports_meter_received_at
      ON grid_exports (meter_id, received_at DESC);

    -- #1045: state channels for off-chain usage micro-transactions. Each row
    -- tracks the latest signed off-chain state and the last settled state.
    CREATE TABLE IF NOT EXISTS usage_channels (
      channel_id TEXT PRIMARY KEY,
      meter_id TEXT NOT NULL,
      nonce INTEGER NOT NULL DEFAULT 0,
      units INTEGER NOT NULL DEFAULT 0,
      cost TEXT NOT NULL DEFAULT '0',
      settled_nonce INTEGER NOT NULL DEFAULT 0,
      settled_cost TEXT NOT NULL DEFAULT '0',
      status TEXT NOT NULL DEFAULT 'open',
      opened_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      settled_at TEXT,
      dispute_raised_at TEXT,
      dispute_reason TEXT,
      signature TEXT,
      settlement_tx_hash TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_usage_channels_meter
      ON usage_channels (meter_id);

    CREATE INDEX IF NOT EXISTS idx_usage_channels_status
      ON usage_channels (status, updated_at);
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
export function db(): any {
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
  if (channelSettlementTimer) {
    clearInterval(channelSettlementTimer);
    channelSettlementTimer = undefined;
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
  if (input.readingId) {
    const receipt = db.prepare("SELECT event_id FROM usage_reading_receipts WHERE meter_id=? AND reading_id=?").get(input.meterId, input.readingId) as { event_id: number } | undefined;
    const existing = receipt ? getUsageEventById(receipt.event_id) as any : undefined;
    // Retention may remove history, but must never allow replay billing of the same reading.
    if (receipt && !existing) throw new Error("Reading already processed; usage history has expired");
    if (existing) {
      // A stable ID must never be rebound to different usage/source data.
      if (existing.units !== input.units || existing.cost !== String(input.cost) ||
          existing.energy_solar !== input.energySources?.solar || existing.energy_grid !== input.energySources?.grid ||
          existing.energy_battery !== input.energySources?.battery) throw new Error("Conflicting readingId");
      return existing as UsageEventRecord;
    }
  }
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

/**
 * Record a usage update through an open state channel (#1045). The update is
 * accumulated off-chain and signed; it is only settled on-chain by the
 * periodic settlement worker (or an explicit settleChannel call). Falls back
 * to the regular on-chain path when no channel is open for the meter.
 */
export function recordChannelUsageEvent(input: CreateUsageEventInput): UsageEventRecord {
  const channel = getChannelByMeter(input.meterId);
  if (!channel || channel.status !== "open") {
    return recordUsageEvent(input);
  }

  accumulateChannelUsage({
    meterId: input.meterId,
    units: input.units,
    cost: input.cost,
  });

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
      ) VALUES (?, ?, ?, ?, ?, 'submitted', 1)
    `);
    return statement.run(
      input.meterId,
      input.units,
      String(input.cost),
      receivedAt,
      input.sourceTopic ?? null,
    ).lastInsertRowid;
  });

  usageEvents.inc({ status: "submitted" });

  return getUsageEventById(Number(id))!;
}

export type GridExportRecord = {
  id: number;
  meter_id: string;
  kwh: number;
  credit: string;
  rate: string;
  received_at: string;
  on_chain_tx_hash: string | null;
  submitted_at: string | null;
};

export type CreateGridExportInput = {
  meterId: string;
  kwh: number;
  credit: number;
  rate: number;
  receivedAt?: string;
  onChainTxHash?: string | null;
  submittedAt?: string | null;
};

/** Persist a grid export reading and the credit earned for it (#990). */
export function recordGridExport(input: CreateGridExportInput): GridExportRecord {
  const receivedAt = input.receivedAt ?? new Date().toISOString();
  const id = pool.withConnection((database) => {
    const statement = database.prepare(`
      INSERT INTO grid_exports (
        meter_id,
        kwh,
        credit,
        rate,
        received_at,
        on_chain_tx_hash,
        submitted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    return statement.run(
      input.meterId,
      input.kwh,
      String(input.credit),
      String(input.rate),
      receivedAt,
      input.onChainTxHash ?? null,
      input.submittedAt ?? null,
    ).lastInsertRowid;
  });

  return db()
    .prepare("SELECT * FROM grid_exports WHERE id = ?")
    .get(Number(id)) as GridExportRecord;
}

/** Paginated export history for a meter, newest first (#990). */
export function getGridExportHistory(
  meterId: string,
  page: number,
  pageSize: number,
): {
  exports: GridExportRecord[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
} {
  const offset = (page - 1) * pageSize;

  const exports = db()
    .prepare(
      "SELECT * FROM grid_exports WHERE meter_id = ? " +
      "ORDER BY received_at DESC, id DESC LIMIT ? OFFSET ?",
    )
    .all(meterId, pageSize, offset) as GridExportRecord[];

  const { count } = db()
    .prepare("SELECT COUNT(*) as count FROM grid_exports WHERE meter_id = ?")
    .get(meterId) as { count: number };

  return {
    exports,
    page,
    pageSize,
    total: count,
    hasMore: offset + pageSize < count,
  };
}

/** Aggregate import/export kWh and export credits for a meter (#990). */
export function getGridExportTotals(meterId: string): {
  importedKwh: number;
  exportedKwh: number;
  totalCredit: number;
  exportCount: number;
} {
  const importRow = db()
    .prepare("SELECT COALESCE(SUM(units), 0) AS units FROM usage_events WHERE meter_id = ?")
    .get(meterId) as { units: number };

  const exportRow = db()
    .prepare(
      "SELECT COALESCE(SUM(kwh), 0) AS kwh, COALESCE(SUM(CAST(credit AS REAL)), 0) AS credit, " +
      "COUNT(*) AS count FROM grid_exports WHERE meter_id = ?",
    )
    .get(meterId) as { kwh: number; credit: number; count: number };

  return {
    importedKwh: Number(importRow?.units ?? 0) / 1000,
    exportedKwh: Number(exportRow?.kwh ?? 0),
    totalCredit: Number(exportRow?.credit ?? 0),
    exportCount: Number(exportRow?.count ?? 0),
  };
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

export type HourlyUsageSample = { timestamp: string; energyKwh: number };

/** Hourly usage totals in kWh; source events store energy in milli-kWh. */
export function getHourlyUsage(meterId: string, days = 90, now = new Date()): HourlyUsageSample[] {
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
  const rows = db()
    .prepare(`
      SELECT substr(received_at, 1, 13) AS hour, SUM(units) AS units
      FROM usage_events
      WHERE meter_id = ? AND status = 'submitted' AND received_at >= ?
      GROUP BY hour ORDER BY hour ASC
    `)
    .all(meterId, cutoff) as Array<{ hour: string; units: number }>;
  const byHour = new Map(rows.map((row) => [row.hour, Number(row.units) / 1000]));
  const first = new Date(now.getTime() - days * 86_400_000);
  first.setUTCMinutes(0, 0, 0);
  const last = new Date(now);
  last.setUTCMinutes(0, 0, 0);
  const samples: HourlyUsageSample[] = [];
  for (let hour = first.getTime(); hour <= last.getTime(); hour += 3_600_000) {
    const timestamp = new Date(hour).toISOString();
    samples.push({
      timestamp,
      energyKwh: byHour.get(timestamp.slice(0, 13)) ?? 0,
    });
  }
  return samples;
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

/** Energy-weighted attribution of locally received usage, including unreported legacy energy. */
export function getEnergyMix(meterId: string, since = "1970-01-01T00:00:00.000Z", until = new Date().toISOString()) {
  const row = db.prepare(`SELECT COUNT(*) AS readings, COALESCE(SUM(units),0) AS total,
    COALESCE(SUM(energy_solar),0) AS solar, COALESCE(SUM(energy_grid),0) AS grid,
    COALESCE(SUM(energy_battery),0) AS battery,
    COALESCE(SUM(CASE WHEN energy_solar IS NULL THEN units ELSE 0 END),0) AS unknown
    FROM usage_events WHERE meter_id=? AND received_at>=? AND received_at<?`).get(meterId, since, until) as Record<string, number>;
  const percentages = Object.fromEntries(["solar", "grid", "battery", "unknown"].map(key => [key, row.total ? row[key] * 100 / row.total : 0]));
  return { meterId, since, until, unit: "milli-kWh", basis: "received_usage", readings: row.readings,
    totalUnits: row.total, units: { solar: row.solar, grid: row.grid, battery: row.battery, unknown: row.unknown },
    percentages, hasData: row.total > 0 };
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

  recordAudit({
    action: "usage_batch_submitted",
    txHash,
    amount: readings.reduce((sum, r) => sum + r.cost, 0),
    details: { count: readings.length, meters: [...new Set(readings.map((r) => r.meterId))] },
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
    // #1045: if an open state channel exists for this meter, accumulate the
    // update off-chain instead of submitting a per-event on-chain tx. The
    // channel's periodic settlement worker will settle the balance on-chain.
    const channel = getChannelByMeter(event.meter_id);
    if (channel && channel.status === "open") {
      accumulateChannelUsage({
        meterId: event.meter_id,
        units: event.units,
        cost: Number(event.cost),
      });
      const offChainHash = `channel:${channel.channelId}`;
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
            `,
          )
          .run(attemptedAt, offChainHash, attemptedAt, id);
      });
      recordAudit({
        action: "usage_accumulated_offchain",
        meterId: event.meter_id,
        amount: event.cost,
        details: { units: event.units, eventId: id, channelId: channel.channelId },
      });
      usageEvents.inc({ status: "submitted" });
      return getUsageEventById(id);
    }

    const hash = await adminInvoke("update_usage", [
      StellarSdk.nativeToScVal(event.meter_id, { type: event.reading_id ? "string" : "symbol" }),
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
    recordAudit({
      action: "usage_submitted",
      meterId: event.meter_id,
      amount: event.cost,
      txHash: hash,
      details: { units: event.units, eventId: id },
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

export type MeterUsageStats = {
  meter_id: string;
  total_units: number;
  total_cost: number;
  event_count: number;
  active_days: number;
  first_seen: string;
};

/** Aggregate per-meter usage totals (used by leaderboards and achievements). */
export function getMeterUsageStats(): MeterUsageStats[] {
  return db()
    .prepare(
      `SELECT meter_id,
              SUM(units) AS total_units,
              SUM(CAST(cost AS REAL)) AS total_cost,
              COUNT(*) AS event_count,
              COUNT(DISTINCT substr(received_at, 1, 10)) AS active_days,
              MIN(received_at) AS first_seen
       FROM usage_events GROUP BY meter_id`,
    )
    .all() as MeterUsageStats[];
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
  const toArchive = db()
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

  const summaryUpsert = db().prepare(`
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

  const runCompaction = db().transaction((cutoff: string) => {
    const summaryResult = summaryUpsert.run(cutoff);
    const deleteResult = db()
      .prepare("DELETE FROM usage_events WHERE status = 'submitted' AND received_at < ?")
      .run(cutoff);
    return { summaryRowsTouched: summaryResult.changes, compactedCount: deleteResult.changes };
  });

  const { summaryRowsTouched, compactedCount } = runCompaction(detailCutoff);

  let vacuumed = false;
  if (compactedCount > 0) {
    usageEventsCompacted.inc(compactedCount);
    db().exec("VACUUM");
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
    return db()
      .prepare(
        "SELECT date, meter_id, total_units, total_cost, event_count FROM usage_summary WHERE meter_id = ? ORDER BY date DESC LIMIT ?",
      )
      .all(meterId, limit) as any[];
  }
  return db()
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
  const row = db()
    .prepare(`SELECT COUNT(*) as count FROM usage_events WHERE status = 'failed'`)
    .get() as { count: number };
  return row.count;
}

/** List channels, optionally filtered by status (#1045). */
export function listChannels(status?: ChannelStatus): ChannelState[] {
  const rows = status
    ? (db()
        .prepare("SELECT * FROM usage_channels WHERE status = ? ORDER BY updated_at DESC")
        .all(status) as ChannelStateRow[])
    : (db()
        .prepare("SELECT * FROM usage_channels ORDER BY updated_at DESC")
        .all() as ChannelStateRow[]);
  return rows.map(rowToChannelState);
}
