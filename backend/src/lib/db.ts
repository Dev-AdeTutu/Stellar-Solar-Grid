import Database from "better-sqlite3";
import path from "path";

const DB_PATH = process.env.DB_PATH ?? path.join(process.cwd(), "solargrid.db");
const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS usage_events (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    meter_id  TEXT    NOT NULL,
    ledger    INTEGER NOT NULL,
    tx_hash   TEXT    NOT NULL UNIQUE,
    units     INTEGER NOT NULL,
    cost      INTEGER NOT NULL,
    created_at TEXT   NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_usage_meter ON usage_events(meter_id, ledger DESC);
`);

export interface UsageEvent {
  meter_id: string;
  ledger: number;
  tx_hash: string;
  units: number;
  cost: number;
}

const insertStmt = db.prepare<UsageEvent>(`
  INSERT OR IGNORE INTO usage_events (meter_id, ledger, tx_hash, units, cost)
  VALUES (@meter_id, @ledger, @tx_hash, @units, @cost)
`);

export function insertEvent(event: UsageEvent) {
  insertStmt.run(event);
}

export function getHistory(
  meterId: string,
  page: number,
  limit: number
): { rows: UsageEvent[]; total: number } {
  const offset = (page - 1) * limit;
  const rows = db
    .prepare<[string, number, number]>(
      `SELECT meter_id, ledger, tx_hash, units, cost, created_at
       FROM usage_events WHERE meter_id = ? ORDER BY ledger DESC LIMIT ? OFFSET ?`
    )
    .all(meterId, limit, offset) as UsageEvent[];

  const { total } = db
    .prepare<[string]>(`SELECT COUNT(*) as total FROM usage_events WHERE meter_id = ?`)
    .get(meterId) as { total: number };

  return { rows, total };
}
