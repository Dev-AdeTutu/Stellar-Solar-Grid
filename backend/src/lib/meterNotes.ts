import path from "node:path";
import { registerDatabase } from "./databaseLifecycle.js";
import { sanitizeUserHtml } from "./sanitize.js";
import { SqlitePool, type SqlitePoolStatus } from "./sqlitePool.js";
import type Database from "better-sqlite3";

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

// ── #735: connection pooling ─────────────────────────────────────────────────
// All meter-note access goes through a bounded pool (min/max warm connections,
// idle eviction, acquire timeout). Reads use the stable primary handle; writes
// borrow a pooled connection so concurrent note creation reuses warm handles.
const pool = new SqlitePool({
  filename: DB_PATH,
  min: Number(process.env.METER_NOTES_POOL_MIN ?? 2),
  max: Number(process.env.METER_NOTES_POOL_MAX ?? 10),
  idleTimeout: Number(process.env.SQLITE_POOL_IDLE_TIMEOUT_MS ?? 30_000),
  acquireTimeout: Number(process.env.SQLITE_POOL_ACQUIRE_TIMEOUT_MS ?? 10_000),
  onOpen: applyMeterNotesSchema,
});

function applyMeterNotesSchema(database: Database): void {
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
}

registerDatabase("meter-notes", () => {
  pool.drain();
});

// Warm the primary connection so the schema bootstraps at startup (no-op for
// :memory: DBs in tests, where the first primaryDb() call initializes it).
pool.warm();

/** Read-path accessor — stable primary connection. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function db(): any {
  return pool.primaryDb();
}

export function initMeterNotesStore() {
  return pool.primaryDb();
}

/** Close the meter-notes store during graceful application shutdown. */
export function closeMeterNotesStore(): void {
  pool.drain();
}

/** Expose pool status for health checks / monitoring (#735). */
export function getMeterNotesPoolStatus(): SqlitePoolStatus {
  return pool.status();
}

export function addMeterNote(meterId: string, text: string, authorIp?: string): MeterNoteRecord {
  const createdAt = new Date().toISOString();
  // #738 — sanitize at the single write choke point before persistence so a
  // malicious `<script>`/`onerror` payload is stored (and later rendered) as
  // inert text rather than executable markup.
  const sanitized = sanitizeUserHtml(text);
  const id = pool.withConnection((database) =>
    Number(
      database
        .prepare(
          `INSERT INTO meter_notes (meter_id, author_ip, text, created_at) VALUES (?, ?, ?, ?)`,
        )
        .run(meterId, authorIp ?? null, sanitized, createdAt).lastInsertRowid,
    ),
  );

  return {
    id,
    meter_id: meterId,
    author_ip: authorIp ?? null,
    text: sanitized,
    created_at: createdAt,
  };
}

export function getLatestMeterNotes(meterId: string, limit = 5): MeterNoteRecord[] {
  return db()
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
  const notes = db()
    .prepare(
      `SELECT id, meter_id, author_ip, text, created_at
       FROM meter_notes WHERE meter_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ? OFFSET ?`,
    )
    .all(meterId, pageSize, offset) as MeterNoteRecord[];

  const { count } = db()
    .prepare(`SELECT COUNT(*) as count FROM meter_notes WHERE meter_id = ?`)
    .get(meterId) as { count: number };

  return { notes, total: count, page, pageSize, hasMore: offset + pageSize < count };
}

export function deleteMeterNote(noteId: number): boolean {
  return pool.withConnection((database) => {
    const result = database.prepare(`DELETE FROM meter_notes WHERE id = ?`).run(noteId);
    return (result.changes as number) > 0;
  });
}
