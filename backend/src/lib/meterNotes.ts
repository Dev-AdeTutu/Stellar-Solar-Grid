import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const DB_PATH =
  process.env.METER_NOTES_DB_PATH ??
  path.resolve(process.cwd(), "data", "meter-notes.sqlite");

export type MeterNoteRecord = {
  id: number;
  meter_id: string;
  text: string;
  created_at: string;
};

// Cast needed: `moduleResolution: node16` resolves better-sqlite3's export= type
// such that the instance type loses its namespace-declared methods at this call site.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = openDatabase() as any;

function openDatabase() {
  if (DB_PATH !== ":memory:") {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  }
  const database = new Database(DB_PATH);
  database.pragma("journal_mode = WAL");
  database.exec(`
    CREATE TABLE IF NOT EXISTS meter_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meter_id TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_meter_notes_meter_created
      ON meter_notes (meter_id, created_at DESC);
  `);
  return database;
}

export function initMeterNotesStore() {
  return db;
}

export function addMeterNote(meterId: string, text: string): MeterNoteRecord {
  const createdAt = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO meter_notes (meter_id, text, created_at) VALUES (?, ?, ?)`,
    )
    .run(meterId, text, createdAt);

  return {
    id: Number(result.lastInsertRowid),
    meter_id: meterId,
    text,
    created_at: createdAt,
  };
}

export function getLatestMeterNotes(
  meterId: string,
  limit = 5,
): MeterNoteRecord[] {
  const rows = db
    .prepare(
      `SELECT id, meter_id, text, created_at
       FROM meter_notes
       WHERE meter_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    )
    .all(meterId, limit) as MeterNoteRecord[];

  return rows;
}
