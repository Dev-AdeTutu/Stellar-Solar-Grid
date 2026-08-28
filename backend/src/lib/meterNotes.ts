import path from "node:path";
import { registerDatabase } from "./databaseLifecycle.js";
import { sqlitePool } from "./metrics.js";
import { createSqlitePool, type SqliteConnection } from "./sqlitePool.js";

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

// ── HTML sanitization (Issue #738) ───────────────────────────────────────────
// Admin-entered note text is treated as plain text: the five HTML-significant
// characters are entity-encoded on the backend before storage so a note can
// never be interpreted as markup/script by a browser rendering it.

const HTML_ENTITY_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escape the HTML-significant characters (`< > & " '`) in a note. */
export function encodeHtmlEntities(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => HTML_ENTITY_MAP[ch]);
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/**
 * Decode the small entity set produced by `encodeHtmlEntities` so that
 * `encode(decode(x))` is a stable round-trip. This lets us re-sanitize rows on
 * read without double-encoding notes that were already sanitized on write,
 * while still neutralizing legacy rows that predate this fix.
 */
export function decodeHtmlEntities(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|apos|#(?:39|0*39));/gi, (match, name: string) => {
    const key = String(name).toLowerCase();
    if (key.startsWith("#")) return "'";
    return NAMED_ENTITIES[key] ?? match;
  });
}

/**
 * Neutralize HTML/JS in a note. Applied on write (before storage) and again on
 * read (defence-in-depth for rows written before this fix shipped).
 */
export function sanitiseMeterNoteText(value: string): string {
  return encodeHtmlEntities(decodeHtmlEntities(value));
}

const notesPool = createSqlitePool({
  filename: DB_PATH,
  onCreate(database) {
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
  },
});

// Primary handle is used for schema lifecycle, admin queries that reuse the raw
// connection, and as the sole connection for in-memory pools.
const db = notesPool.primary();
registerDatabase("meter-notes", () => {
  notesPool.drain();
});

export function initMeterNotesStore() {
  return db;
}

/** Close the meter-notes store during graceful application shutdown. */
export function closeMeterNotesStore(): void {
  notesPool.drain();
  updateNotePoolMetrics();
}

/** Run a synchronous operation against a pooled SQLite connection. */
function withNoteConnection<T>(fn: (database: SqliteConnection) => T): T {
  const connection = notesPool.acquire();
  try {
    return fn(connection);
  } finally {
    notesPool.release(connection);
    updateNotePoolMetrics();
  }
}

function updateNotePoolMetrics(): void {
  const stats = notesPool.getStats();
  sqlitePool.set({ database: "meter-notes", dimension: "size" }, stats.size);
  sqlitePool.set({ database: "meter-notes", dimension: "active" }, stats.active);
  sqlitePool.set({ database: "meter-notes", dimension: "idle" }, stats.idle);
}

export function addMeterNote(meterId: string, text: string, authorIp?: string): MeterNoteRecord {
  const createdAt = new Date().toISOString();
  // Sanitize before storage so raw HTML/JavaScript never reaches the database.
  const safeText = sanitiseMeterNoteText(text);

  const result = withNoteConnection((connection) =>
    connection
      .prepare(
        `INSERT INTO meter_notes (meter_id, author_ip, text, created_at) VALUES (?, ?, ?, ?)`,
      )
      .run(meterId, authorIp ?? null, safeText, createdAt),
  );

  return {
    id: Number(result.lastInsertRowid),
    meter_id: meterId,
    author_ip: authorIp ?? null,
    text: safeText,
    created_at: createdAt,
  };
}

function sanitiseNoteRows(rows: MeterNoteRecord[]): MeterNoteRecord[] {
  return rows.map((row) => ({ ...row, text: sanitiseMeterNoteText(row.text) }));
}

export function getLatestMeterNotes(meterId: string, limit = 5): MeterNoteRecord[] {
  const rows = withNoteConnection((connection) =>
    connection
      .prepare(
        `SELECT id, meter_id, author_ip, text, created_at
         FROM meter_notes
         WHERE meter_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(meterId, limit),
  ) as MeterNoteRecord[];

  return sanitiseNoteRows(rows);
}

export function getAllMeterNotes(
  meterId: string,
  page: number,
  pageSize: number,
): { notes: MeterNoteRecord[]; total: number; page: number; pageSize: number; hasMore: boolean } {
  const offset = (page - 1) * pageSize;

  const { rows, count } = withNoteConnection((connection) => {
    const result = connection
      .prepare(
        `SELECT id, meter_id, author_ip, text, created_at
         FROM meter_notes WHERE meter_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(meterId, pageSize, offset) as MeterNoteRecord[];

    const { count: total } = connection
      .prepare(`SELECT COUNT(*) as count FROM meter_notes WHERE meter_id = ?`)
      .get(meterId) as { count: number };

    return { rows: result, count: total };
  });

  return { notes: sanitiseNoteRows(rows), total: count, page, pageSize, hasMore: offset + pageSize < count };
}

export function deleteMeterNote(noteId: number): boolean {
  const result = withNoteConnection((connection) =>
    connection.prepare(`DELETE FROM meter_notes WHERE id = ?`).run(noteId),
  );
  return (result.changes as number) > 0;
}