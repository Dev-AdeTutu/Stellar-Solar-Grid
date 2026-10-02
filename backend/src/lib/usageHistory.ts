import path from "node:path";
import { registerDatabase } from "./databaseLifecycle.js";
import { SqlitePool, type SqlitePoolStatus } from "./sqlitePool.js";
import type Database from "better-sqlite3";

const DB_PATH =
  process.env.USAGE_HISTORY_DB_PATH ??
  path.resolve(process.cwd(), "data", "usage-history.sqlite");

export type UsageHistoryRecord = {
  id: number;
  meter_id: string;
  units: number;
  timestamp: string;
  balance_before: number;
  balance_after: number;
};

export type AddUsageHistoryInput = {
  meter_id: string;
  units: number;
  balance_before: number;
  balance_after: number;
  timestamp?: string;
};

export type GetUsageHistoryOptions = {
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
  page?: number;
};

export type PaginatedUsageHistory = {
  history: UsageHistoryRecord[];
  total: number;
  limit: number;
  offset: number;
  page: number;
  pages: number;
};

const pool = new SqlitePool({
  filename: DB_PATH,
  min: Number(process.env.USAGE_HISTORY_POOL_MIN ?? 2),
  max: Number(process.env.USAGE_HISTORY_POOL_MAX ?? 10),
  idleTimeout: Number(process.env.SQLITE_POOL_IDLE_TIMEOUT_MS ?? 30_000),
  acquireTimeout: Number(process.env.SQLITE_POOL_ACQUIRE_TIMEOUT_MS ?? 10_000),
  onOpen: applyUsageHistorySchema,
});

function applyUsageHistorySchema(database: Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS usage_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meter_id TEXT NOT NULL,
      units REAL NOT NULL,
      timestamp TEXT NOT NULL,
      balance_before REAL NOT NULL,
      balance_after REAL NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_usage_history_meter_timestamp
      ON usage_history (meter_id, timestamp DESC);
  `);
}

registerDatabase("usage-history", () => {
  pool.drain();
});

pool.warm();

export function initUsageHistoryStore() {
  return pool.primaryDb();
}

export function closeUsageHistoryStore(): void {
  pool.drain();
}

export function getUsageHistoryPoolStatus(): SqlitePoolStatus {
  return pool.status();
}

export function addUsageHistory(entry: AddUsageHistoryInput): UsageHistoryRecord {
  const timestamp = entry.timestamp ?? new Date().toISOString();
  const id = pool.withConnection((database) => {
    const stmt = database.prepare(`
      INSERT INTO usage_history (meter_id, units, timestamp, balance_before, balance_after)
      VALUES (?, ?, ?, ?, ?)
    `);
    const info = stmt.run(
      entry.meter_id,
      entry.units,
      timestamp,
      entry.balance_before,
      entry.balance_after,
    );
    return Number(info.lastInsertRowid);
  });

  return {
    id,
    meter_id: entry.meter_id,
    units: entry.units,
    timestamp,
    balance_before: entry.balance_before,
    balance_after: entry.balance_after,
  };
}

export function getUsageHistory(
  meterId: string,
  options: GetUsageHistoryOptions = {},
): PaginatedUsageHistory {
  const limit = Math.min(100, Math.max(1, options.limit ?? 50));
  const page = Math.max(1, options.page ?? 1);
  const offset =
    options.offset !== undefined ? Math.max(0, options.offset) : (page - 1) * limit;

  return pool.withConnection((database) => {
    let whereClause = "WHERE meter_id = ?";
    const params: unknown[] = [meterId];

    if (options.from) {
      whereClause += " AND timestamp >= ?";
      params.push(options.from);
    }
    if (options.to) {
      whereClause += " AND timestamp <= ?";
      params.push(options.to);
    }

    const countStmt = database.prepare(
      `SELECT COUNT(*) as total FROM usage_history ${whereClause}`,
    );
    const totalRow = countStmt.get(...params) as { total: number } | undefined;
    const total = totalRow?.total ?? 0;

    const dataStmt = database.prepare(`
      SELECT id, meter_id, units, timestamp, balance_before, balance_after
      FROM usage_history
      ${whereClause}
      ORDER BY timestamp DESC
      LIMIT ? OFFSET ?
    `);
    const history = dataStmt.all(...params, limit, offset) as UsageHistoryRecord[];

    return {
      history,
      total,
      limit,
      offset,
      page,
      pages: Math.ceil(total / limit) || 1,
    };
  });
}

export function deleteUsageHistory(meterId: string): number {
  return pool.withConnection(
    (database) => database.prepare("DELETE FROM usage_history WHERE meter_id = ?").run(meterId).changes,
  );
}
