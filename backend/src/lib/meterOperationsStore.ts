import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

let db: Database | undefined;
/** Same SQLite/WAL deployment pattern as usageEvents; deliberately separate from billing. */
export function operationsDb(): Database {
  if (db) return db;
  const filename = process.env.METER_OPERATIONS_DB_PATH ?? path.resolve(process.cwd(), "data", "meter-operations.sqlite");
  if (filename !== ":memory:") fs.mkdirSync(path.dirname(filename), { recursive: true });
  db = new Database(filename);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS meter_observations (
      meter_id TEXT NOT NULL, sequence INTEGER NOT NULL, received_at INTEGER NOT NULL,
      load_watts REAL NOT NULL, available INTEGER NOT NULL, active INTEGER NOT NULL,
      PRIMARY KEY(meter_id, sequence)
    );
    CREATE INDEX IF NOT EXISTS observations_time ON meter_observations(meter_id, received_at);
    CREATE TABLE IF NOT EXISTS load_rules (id TEXT PRIMARY KEY, json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS load_commands (
      id TEXT PRIMARY KEY, group_id TEXT NOT NULL, controller_id TEXT NOT NULL,
      from_id TEXT NOT NULL, to_id TEXT NOT NULL, watts REAL NOT NULL,
      created_at INTEGER NOT NULL, deadline INTEGER NOT NULL, status TEXT NOT NULL,
      command_json TEXT NOT NULL, reason TEXT, acknowledged_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS commands_group ON load_commands(group_id, created_at);
    CREATE TABLE IF NOT EXISTS sla_targets (
      meter_id TEXT PRIMARY KEY, json TEXT NOT NULL, configured_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sla_reports (
      meter_id TEXT NOT NULL, bucket INTEGER NOT NULL, json TEXT NOT NULL,
      PRIMARY KEY(meter_id, bucket)
    );
    CREATE TABLE IF NOT EXISTS sla_states (
      meter_id TEXT NOT NULL, metric TEXT NOT NULL, breached INTEGER NOT NULL,
      PRIMARY KEY(meter_id, metric)
    );
    CREATE TABLE IF NOT EXISTS sla_alerts (
      id TEXT PRIMARY KEY, meter_id TEXT NOT NULL, metric TEXT NOT NULL,
      event TEXT NOT NULL, created_at INTEGER NOT NULL, json TEXT NOT NULL
    );
  `);
  return db;
}

export type Observation = {
  meter_id: string; sequence: number; received_at: number;
  load_watts: number; available: number; active: number;
};
export function latestObservation(meterId: string): Observation | undefined {
  return operationsDb().prepare("SELECT * FROM meter_observations WHERE meter_id=? ORDER BY sequence DESC LIMIT 1").get(meterId) as Observation | undefined;
}
