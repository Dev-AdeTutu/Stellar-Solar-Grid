import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const DB_PATH =
  process.env.METER_NOTES_DB_PATH ??
  path.resolve(process.cwd(), "data", "meter-notes.sqlite");

export type MeterNoteRecord = {
  id: number;
  meter_id: string;
  author_ip: string | null;
  text: string;
  created_at: string;
};

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
      author_ip TEXT,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_meter_notes_meter_created
      ON meter_notes (meter_id, created_at DESC);
  `);

  // Migrate existing tables that lack the author_ip column
  const cols = database.pragma("table_info(meter_notes)") as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "author_ip")) {
    database.exec(`ALTER TABLE meter_notes ADD COLUMN author_ip TEXT`);
  }

  return database;
}

export function initMeterNotesStore() {
  return db;
}

export function addMeterNote(meterId: string, text: string, authorIp?: string): MeterNoteRecord {
  const createdAt = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO meter_notes (meter_id, author_ip, text, created_at) VALUES (?, ?, ?, ?)`,
    )
    .run(meterId, authorIp ?? null, text, createdAt);

  return {
    id: Number(result.lastInsertRowid),
    meter_id: meterId,
    author_ip: authorIp ?? null,
    text,
    created_at: createdAt,
  };
}

export function getLatestMeterNotes(meterId: string, limit = 5): MeterNoteRecord[] {
  return db
    .prepare(
      `SELECT id, meter_id, author_ip, text, created_at
       FROM meter_notes
       WHERE meter_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    )
    .all(meterId, limit) as MeterNoteRecord[];
}

export function getAllMeterNotes(
  meterId: string,
  page: number,
  pageSize: number,
): { notes: MeterNoteRecord[]; total: number; page: number; pageSize: number; hasMore: boolean } {
  const offset = (page - 1) * pageSize;
  const notes = db
    .prepare(
      `SELECT id, meter_id, author_ip, text, created_at
       FROM meter_notes WHERE meter_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ? OFFSET ?`,
    )
    .all(meterId, pageSize, offset) as MeterNoteRecord[];

  const { count } = db
    .prepare(`SELECT COUNT(*) as count FROM meter_notes WHERE meter_id = ?`)
    .get(meterId) as { count: number };

  return { notes, total: count, page, pageSize, hasMore: offset + pageSize < count };
}

export function deleteMeterNote(noteId: number): boolean {
  const result = db.prepare(`DELETE FROM meter_notes WHERE id = ?`).run(noteId);
  return (result.changes as number) > 0;
}
