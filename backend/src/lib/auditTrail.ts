import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import Database from "better-sqlite3";

const DB_PATH =
  process.env.AUDIT_DB_PATH ??
  path.resolve(process.cwd(), "data", "audit.sqlite");

export type AuditEntry = {
  id: number;
  timestamp: string;
  action: string;
  actor: string | null;
  meter_id: string | null;
  amount: string | null;
  tx_hash: string | null;
  details: string | null;
  prev_hash: string;
  hash: string;
};

export type AuditInput = {
  action: string;
  actor?: string | null;
  meterId?: string | null;
  amount?: string | number | null;
  txHash?: string | null;
  details?: unknown;
};

export type AuditFilter = {
  action?: string;
  actor?: string;
  meterId?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
};

const GENESIS = "0".repeat(64);

const db = (() => {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const d = new Database(DB_PATH);
  d.pragma("journal_mode = WAL");
  d.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      action TEXT NOT NULL,
      actor TEXT,
      meter_id TEXT,
      amount TEXT,
      tx_hash TEXT,
      details TEXT,
      prev_hash TEXT NOT NULL,
      hash TEXT NOT NULL UNIQUE
    );
    CREATE INDEX IF NOT EXISTS idx_audit_meter ON audit_log (meter_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log (action, timestamp);
    -- Append-only: block updates and deletes at the storage layer.
    CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_log
      BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_log
      BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
  `);
  return d;
})();

function computeHash(e: Omit<AuditEntry, "id" | "hash">): string {
  const payload = [
    e.prev_hash, e.timestamp, e.action, e.actor ?? "", e.meter_id ?? "",
    e.amount ?? "", e.tx_hash ?? "", e.details ?? "",
  ].join("|");
  return crypto.createHash("sha256").update(payload).digest("hex");
}

/** Append a hash-chained entry. Each hash commits to the previous one. */
export const recordAudit = db.transaction((input: AuditInput): AuditEntry => {
  const last = db
    .prepare("SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1")
    .get() as { hash: string } | undefined;
  const base = {
    timestamp: new Date().toISOString(),
    action: input.action,
    actor: input.actor ?? null,
    meter_id: input.meterId ?? null,
    amount: input.amount == null ? null : String(input.amount),
    tx_hash: input.txHash ?? null,
    details: input.details == null ? null : JSON.stringify(input.details),
    prev_hash: last?.hash ?? GENESIS,
  };
  const hash = computeHash(base);
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO audit_log (timestamp, action, actor, meter_id, amount, tx_hash, details, prev_hash, hash)
       VALUES (@timestamp, @action, @actor, @meter_id, @amount, @tx_hash, @details, @prev_hash, @hash)`,
    )
    .run({ ...base, hash });
  return { id: Number(lastInsertRowid), ...base, hash };
});

export function queryAudit(f: AuditFilter = {}): AuditEntry[] {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (f.action) { where.push("action = @action"); params.action = f.action; }
  if (f.actor) { where.push("actor = @actor"); params.actor = f.actor; }
  if (f.meterId) { where.push("meter_id = @meterId"); params.meterId = f.meterId; }
  if (f.from) { where.push("timestamp >= @from"); params.from = f.from; }
  if (f.to) { where.push("timestamp <= @to"); params.to = f.to; }
  params.limit = Math.min(Math.max(f.limit ?? 100, 1), 10_000);
  params.offset = Math.max(f.offset ?? 0, 0);
  const sql = `SELECT * FROM audit_log ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY id ASC LIMIT @limit OFFSET @offset`;
  return db.prepare(sql).all(params) as AuditEntry[];
}

/** Walk the full chain and report the first broken link, if any. */
export function verifyAuditChain(): { valid: boolean; checked: number; brokenAt?: number } {
  let prev = GENESIS;
  let checked = 0;
  for (const row of db.prepare("SELECT * FROM audit_log ORDER BY id ASC").iterate() as Iterable<AuditEntry>) {
    const { id, hash, ...rest } = row;
    if (row.prev_hash !== prev || computeHash(rest) !== hash) {
      return { valid: false, checked, brokenAt: id };
    }
    prev = hash;
    checked++;
  }
  return { valid: true, checked };
}

export function complianceReport(from?: string, to?: string) {
  const params = { from: from ?? "0000", to: to ?? "9999" };
  const byAction = db
    .prepare(
      `SELECT action, COUNT(*) AS count, SUM(CAST(amount AS REAL)) AS total_amount,
              SUM(tx_hash IS NOT NULL) AS on_chain
       FROM audit_log WHERE timestamp BETWEEN @from AND @to GROUP BY action`,
    )
    .all(params);
  return {
    period: { from: from ?? null, to: to ?? null },
    generatedAt: new Date().toISOString(),
    integrity: verifyAuditChain(),
    byAction,
  };
}

const CSV_COLUMNS: (keyof AuditEntry)[] = [
  "id", "timestamp", "action", "actor", "meter_id", "amount", "tx_hash", "details", "prev_hash", "hash",
];

export function toCsv(rows: AuditEntry[]): string {
  const esc = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [CSV_COLUMNS.join(","), ...rows.map((r) => CSV_COLUMNS.map((c) => esc(r[c])).join(","))].join("\n");
}

/** Minimal dependency-free PDF (Helvetica, one line per entry, paginated). */
export function toPdf(rows: AuditEntry[], title = "Energy Audit Trail"): Buffer {
  const pdfEsc = (s: string) => s.replace(/[\\()]/g, "\\$&").replace(/[^\x20-\x7e]/g, "?");
  const lines = [
    title,
    `Generated ${new Date().toISOString()} - ${rows.length} entries`,
    "",
    ...rows.map((r) =>
      `#${r.id} ${r.timestamp} ${r.action} meter=${r.meter_id ?? "-"} amt=${r.amount ?? "-"} tx=${(r.tx_hash ?? "-").slice(0, 16)} hash=${r.hash.slice(0, 16)}`,
    ),
  ];
  const perPage = 60;
  const pages: string[][] = [];
  for (let i = 0; i < lines.length; i += perPage) pages.push(lines.slice(i, i + perPage));
  if (!pages.length) pages.push([title]);

  const objs: string[] = [];
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  const kids: string[] = [];
  pages.forEach((pageLines, i) => {
    const pageId = 4 + i * 2;
    const contentId = pageId + 1;
    kids.push(`${pageId} 0 R`);
    const text = pageLines.map((l) => `(${pdfEsc(l)}) Tj T*`).join("\n");
    const stream = `BT /F1 8 Tf 10 TL 30 810 Td\n${text}\nET`;
    objs[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`;
    objs[contentId] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`;
  });
  objs[2] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages.length} >>`;

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 1; i < objs.length; i++) {
    offsets[i] = Buffer.byteLength(out);
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, "latin1");
}
