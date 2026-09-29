/**
 * Contract event indexer (#896)
 *
 * Polls Soroban RPC `getEvents` for the SolarGrid contract and stores every
 * event in a dedicated SQLite table so queries never hit the RPC node.
 *
 *  - Historical backfill: starts from EVENT_INDEXER_START_LEDGER (or the
 *    oldest ledger the RPC retains) and pages forward via cursors.
 *  - Real-time sync: polls every EVENT_INDEXER_POLL_MS (default 5s, well under
 *    the 30s delay target).
 *  - Monitoring: exposes lag / last-sync status and logs an alert when the
 *    indexer falls behind EVENT_INDEXER_ALERT_LAG_MS (default 30s).
 */
import path from "node:path";
import Database from "better-sqlite3";
import * as StellarSdk from "@stellar/stellar-sdk";
import { rpcPool } from "./stellar.js";
import { logger } from "./logger.js";

const DB_PATH =
  process.env.EVENT_INDEX_DB_PATH ??
  path.resolve(process.cwd(), "data", "contract-events.sqlite");
const POLL_MS = Number(process.env.EVENT_INDEXER_POLL_MS ?? 5_000);
const ALERT_LAG_MS = Number(process.env.EVENT_INDEXER_ALERT_LAG_MS ?? 30_000);
const START_LEDGER = Number(process.env.EVENT_INDEXER_START_LEDGER ?? 0);
const PAGE_LIMIT = 200;

export interface IndexedEvent {
  id: string;
  ledger: number;
  ledgerClosedAt: string;
  contractId: string;
  txHash: string;
  topic0: string | null;
  topic1: string | null;
  subject: string | null;
  topics: string[];
  value: unknown;
}

export interface IndexerStatus {
  running: boolean;
  lastLedger: number;
  lastSyncAt: string | null;
  lagMs: number | null;
  totalEvents: number;
  lastError: string | null;
  alerting: boolean;
}

let database: Database.Database | undefined;
let timer: NodeJS.Timeout | undefined;
let syncing = false;
const state = { lastSyncAt: null as number | null, lastError: null as string | null, alerting: false };

function db(): Database.Database {
  if (database) return database;
  database = new Database(DB_PATH);
  database.pragma("journal_mode = WAL");
  database.exec(`
    CREATE TABLE IF NOT EXISTS contract_events (
      id TEXT PRIMARY KEY,
      ledger INTEGER NOT NULL,
      ledger_closed_at TEXT NOT NULL,
      contract_id TEXT NOT NULL,
      tx_hash TEXT NOT NULL,
      topic0 TEXT,
      topic1 TEXT,
      subject TEXT,
      topics TEXT NOT NULL,
      value TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_events_ledger ON contract_events(ledger);
    CREATE INDEX IF NOT EXISTS idx_events_action ON contract_events(topic1, ledger);
    CREATE INDEX IF NOT EXISTS idx_events_subject ON contract_events(subject, ledger);
    CREATE INDEX IF NOT EXISTS idx_events_tx ON contract_events(tx_hash);
    CREATE TABLE IF NOT EXISTS indexer_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  return database;
}

function getState(key: string): string | null {
  const row = db().prepare("SELECT value FROM indexer_state WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

function setState(key: string, value: string) {
  db().prepare("INSERT OR REPLACE INTO indexer_state (key, value) VALUES (?, ?)").run(key, value);
}

function scvalToString(v: StellarSdk.xdr.ScVal): string {
  try {
    const native = StellarSdk.scValToNative(v);
    return typeof native === "string" ? native : JSON.stringify(native, bigintReplacer);
  } catch {
    return v.toXDR("base64");
  }
}

function bigintReplacer(_k: string, v: unknown) {
  return typeof v === "bigint" ? v.toString() : v;
}

function storeEvents(events: StellarSdk.SorobanRpc.Api.EventResponse[]) {
  const insert = db().prepare(`
    INSERT OR IGNORE INTO contract_events
      (id, ledger, ledger_closed_at, contract_id, tx_hash, topic0, topic1, subject, topics, value)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  db().transaction(() => {
    for (const e of events) {
      const topics = e.topic.map(scvalToString);
      let value: string | null = null;
      try {
        value = JSON.stringify(StellarSdk.scValToNative(e.value), bigintReplacer);
      } catch {
        value = JSON.stringify(e.value.toXDR("base64"));
      }
      insert.run(
        e.id, e.ledger, e.ledgerClosedAt, String(e.contractId ?? ""), e.txHash,
        topics[0] ?? null, topics[1] ?? null, topics[2] ?? null, JSON.stringify(topics), value,
      );
    }
  })();
}

/** Run one sync pass: backfill/catch up until the RPC has no newer events. */
export async function syncOnce(): Promise<number> {
  const contractId = process.env.CONTRACT_ID;
  if (!contractId || syncing) return 0;
  syncing = true;
  let indexed = 0;
  try {
    const server = rpcPool.createProxy();
    let cursor = getState("cursor");
    for (;;) {
      const filters = [{ type: "contract" as const, contractIds: [contractId] }];
      let req: StellarSdk.SorobanRpc.Server.GetEventsRequest;
      if (cursor) {
        req = { filters, cursor, limit: PAGE_LIMIT };
      } else {
        const latest = await server.getLatestLedger();
        const startLedger = START_LEDGER > 0 ? START_LEDGER : Math.max(1, latest.sequence - 17_280 * 7);
        req = { filters, startLedger, limit: PAGE_LIMIT };
      }
      const res = await server.getEvents(req);
      if (res.events.length) {
        storeEvents(res.events);
        indexed += res.events.length;
        const last = res.events[res.events.length - 1];
        cursor = last.pagingToken ?? last.id;
        setState("cursor", cursor);
        setState("last_ledger", String(last.ledger));
      }
      setState("latest_ledger", String(res.latestLedger));
      if (res.events.length < PAGE_LIMIT) break;
    }
    state.lastSyncAt = Date.now();
    state.lastError = null;
  } catch (err) {
    state.lastError = err instanceof Error ? err.message : String(err);
    logger.error({ err }, "Event indexer sync failed");
  } finally {
    syncing = false;
    checkLag();
  }
  return indexed;
}

function checkLag() {
  const lag = state.lastSyncAt ? Date.now() - state.lastSyncAt : null;
  const behind = lag === null || lag > ALERT_LAG_MS;
  if (behind && !state.alerting) {
    logger.warn({ lagMs: lag, lastError: state.lastError }, "ALERT: contract event indexer is lagging");
  } else if (!behind && state.alerting) {
    logger.info("Contract event indexer recovered");
  }
  state.alerting = behind;
}

export function startEventIndexer() {
  if (timer || !process.env.CONTRACT_ID) return;
  db();
  void syncOnce();
  timer = setInterval(() => void syncOnce(), POLL_MS);
  timer.unref?.();
}

export function stopEventIndexer() {
  if (timer) clearInterval(timer);
  timer = undefined;
}

export function getIndexerStatus(): IndexerStatus {
  const total = (db().prepare("SELECT COUNT(*) AS n FROM contract_events").get() as { n: number }).n;
  return {
    running: Boolean(timer),
    lastLedger: Number(getState("last_ledger") ?? 0),
    lastSyncAt: state.lastSyncAt ? new Date(state.lastSyncAt).toISOString() : null,
    lagMs: state.lastSyncAt ? Date.now() - state.lastSyncAt : null,
    totalEvents: total,
    lastError: state.lastError,
    alerting: state.alerting,
  };
}

export interface EventQuery {
  action?: string;
  subject?: string;
  txHash?: string;
  fromLedger?: number;
  toLedger?: number;
  limit?: number;
  before?: number;
}

/** Indexed query — every filter maps onto an index so responses stay < 100ms. */
export function queryEvents(q: EventQuery): IndexedEvent[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.action) { where.push("topic1 = ?"); params.push(q.action); }
  if (q.subject) { where.push("subject = ?"); params.push(q.subject); }
  if (q.txHash) { where.push("tx_hash = ?"); params.push(q.txHash); }
  if (q.fromLedger) { where.push("ledger >= ?"); params.push(q.fromLedger); }
  if (q.toLedger) { where.push("ledger <= ?"); params.push(q.toLedger); }
  if (q.before) { where.push("ledger < ?"); params.push(q.before); }
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 500);
  const rows = db()
    .prepare(
      `SELECT * FROM contract_events ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY ledger DESC, id DESC LIMIT ?`,
    )
    .all(...params, limit) as Array<Record<string, string | number | null>>;
  return rows.map((r) => ({
    id: String(r.id),
    ledger: Number(r.ledger),
    ledgerClosedAt: String(r.ledger_closed_at),
    contractId: String(r.contract_id),
    txHash: String(r.tx_hash),
    topic0: r.topic0 as string | null,
    topic1: r.topic1 as string | null,
    subject: r.subject as string | null,
    topics: JSON.parse(String(r.topics)),
    value: r.value ? JSON.parse(String(r.value)) : null,
  }));
}
