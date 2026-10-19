/**
 * Structured audit log for admin-invoked write operations.
 *
 * Every action that passes through requireAdminKey emits a structured entry
 * to a dedicated audit log stream (separate from the general request log).
 * This gives a queryable, exportable trail of who (IP) invoked which
 * privileged action and when.
 *
 * Format: one JSON object per line — compatible with log-aggregation tooling
 * (Loki, CloudWatch Logs Insights, jq, etc.).
 *
 * Storage:
 *   - In production: writes to AUDIT_LOG_PATH (default: logs/audit.jsonl)
 *     in addition to emitting via the structured logger.
 *   - In all environments: the entry is also emitted at INFO level through
 *     the standard winston logger (tagged with `audit: true`) so it appears
 *     in any log shipper already pointed at stdout.
 *
 * Export:
 *   - GET /api/admin/audit-logs              — paginated JSON query (closes #744)
 *   - GET /api/admin/audit-logs/export?format=csv|json — bulk download (closes #744)
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { logger } from "./logger.js";

export type AuditEntry = {
  /** ISO-8601 timestamp */
  timestamp: string;
  /** HTTP method, e.g. "POST" */
  method: string;
  /** Route path, e.g. "/api/allowlist" */
  path: string;
  /** Request body (params, address, etc.) — secrets are never included */
  params: unknown;
  /** Requester IP — x-forwarded-for first, then socket.remoteAddress */
  ip: string;
  /** Optional: admin key identity hint (last 4 chars) for multi-key setups */
  keyHint: string;
};

// ── File sink (optional) ──────────────────────────────────────────────────────

const AUDIT_LOG_PATH =
  process.env.AUDIT_LOG_PATH ??
  path.resolve(process.cwd(), "logs", "audit.jsonl");

let auditStream: fs.WriteStream | null = null;

function getAuditStream(): fs.WriteStream | null {
  if (auditStream) return auditStream;
  if (process.env.AUDIT_LOG_DISABLE === "true") return null;

  try {
    fs.mkdirSync(path.dirname(AUDIT_LOG_PATH), { recursive: true });
    auditStream = fs.createWriteStream(AUDIT_LOG_PATH, { flags: "a" });
    auditStream.on("error", (err) => {
      logger.error("Audit log write error", { err: err.message });
    });
    return auditStream;
  } catch (err: any) {
    logger.error("Failed to open audit log file", {
      path: AUDIT_LOG_PATH,
      err: err.message,
    });
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Emit a structured audit entry for an admin-gated action.
 *
 * Call this inside requireAdminKey (or any admin-only handler) after
 * authentication has been confirmed.
 */
export function auditLog(entry: AuditEntry): void {
  const record = { audit: true, ...entry };

  // 1. Emit via the standard logger (stdout / log shipper)
  logger.info(record, "admin action audited");

  // 2. Append to the dedicated audit log file (if configured)
  const stream = getAuditStream();
  if (stream) {
    stream.write(JSON.stringify(record) + "\n");
  }
}

/**
 * Build an AuditEntry from an Express request object.
 * Must only be called after authentication has passed (key is valid).
 */
export function buildAuditEntry(
  req: {
    method: string;
    path: string;
    body?: unknown;
    headers: Record<string, string | string[] | undefined>;
    socket?: { remoteAddress?: string };
    ip?: string;
  },
): AuditEntry {
  // Prefer x-forwarded-for (set by reverse proxies) over socket IP
  const forwardedFor = req.headers["x-forwarded-for"];
  const ip =
    (Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor)?.split(",")[0]?.trim() ??
    req.ip ??
    req.socket?.remoteAddress ??
    "unknown";

  // Produce a short identity hint from the last 4 chars of the provided key
  const rawKey = req.headers["x-admin-key"];
  const keyStr = Array.isArray(rawKey) ? rawKey[0] : rawKey ?? "";
  const keyHint = keyStr.length >= 4 ? `...${keyStr.slice(-4)}` : "****";

  return {
    timestamp: new Date().toISOString(),
    method: req.method,
    path: req.path,
    params: req.body ?? null,
    ip,
    keyHint,
  };
}

// ── Query / export helpers (closes #744) ─────────────────────────────────────

export interface AuditQueryOptions {
  /** Inclusive lower bound (ISO-8601). */
  start?: string;
  /** Inclusive upper bound (ISO-8601). */
  end?: string;
  /** Filter by event path substring (e.g. "/api/meters"). */
  eventType?: string;
  /** Max entries to return. Defaults to 500. */
  limit?: number;
  /** Number of entries to skip (for pagination). Defaults to 0. */
  offset?: number;
}

/**
 * Read the JSONL audit log file line-by-line and return matching entries.
 *
 * Parsing is streaming (readline) so large log files do not load entirely
 * into memory. The function resolves once the end of file is reached.
 *
 * Closes #744.
 */
export async function queryAuditLog(
  opts: AuditQueryOptions = {},
): Promise<{ entries: (AuditEntry & { audit?: true })[]; total: number }> {
  const { start, end, eventType, limit = 500, offset = 0 } = opts;
  const startMs = start ? new Date(start).getTime() : -Infinity;
  const endMs = end ? new Date(end).getTime() : Infinity;

  if (!fs.existsSync(AUDIT_LOG_PATH)) {
    return { entries: [], total: 0 };
  }

  const matching: (AuditEntry & { audit?: true })[] = [];

  await new Promise<void>((resolve, reject) => {
    const fileStream = fs.createReadStream(AUDIT_LOG_PATH, { encoding: "utf8" });
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    fileStream.on("error", reject);
    rl.on("error", reject);
    rl.on("close", resolve);

    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const record = JSON.parse(trimmed) as AuditEntry & { audit?: true };
        if (!record.timestamp) return;

        const ts = new Date(record.timestamp).getTime();
        if (ts < startMs || ts > endMs) return;
        if (eventType && !record.path.includes(eventType)) return;

        matching.push(record);
      } catch {
        // Skip malformed lines
      }
    });
  });

  const total = matching.length;
  const entries = matching.slice(offset, offset + limit);
  return { entries, total };
}

/**
 * Serialise audit entries as a CSV string.
 * Columns: timestamp, method, path, ip, keyHint, params
 *
 * Closes #744.
 */
export function auditEntriesToCsv(
  entries: (AuditEntry & { audit?: true })[],
): string {
  const header = "timestamp,method,path,ip,keyHint,params";
  const rows = entries.map((e) => {
    const params = JSON.stringify(e.params ?? null).replace(/"/g, '""');
    return `${e.timestamp},${e.method},${e.path},${e.ip},${e.keyHint},"${params}"`;
  });
  return [header, ...rows].join("\n");
}

// ── Energy data export (closes #905) ─────────────────────────────────────────

/** Supported export serialisation formats. */
export type ExportFormat = "csv" | "json" | "xml";

/** A single energy transaction record included in a personal data export. */
export interface EnergyTransaction {
  /** ISO-8601 timestamp of the transaction. */
  timestamp: string;
  /** Meter identifier the transaction belongs to. */
  meterId: string;
  /** Transaction type, e.g. "production" | "consumption" | "trade". */
  type: string;
  /** Energy amount in kWh. */
  amountKwh: number;
  /** Optional monetary value associated with the transaction. */
  value?: number;
  /** Optional free-form metadata. */
  metadata?: Record<string, unknown>;
}

/** Options controlling which transactions are included in an export. */
export interface EnergyExportOptions {
  /** Inclusive lower bound (ISO-8601). */
  start?: string;
  /** Inclusive upper bound (ISO-8601). */
  end?: string;
  /** Filter by meter identifier. */
  meterId?: string;
  /** Filter by transaction type. */
  type?: string;
}

/**
 * Filter a user's energy transactions by date range and optional
 * meter/type filters. Used by the personal data export endpoint (#905).
 */
export function filterEnergyTransactions(
  transactions: EnergyTransaction[],
  opts: EnergyExportOptions = {},
): EnergyTransaction[] {
  const { start, end, meterId, type } = opts;
  const startMs = start ? new Date(start).getTime() : -Infinity;
  const endMs = end ? new Date(end).getTime() : Infinity;

  return transactions.filter((tx) => {
    const ts = new Date(tx.timestamp).getTime();
    if (Number.isNaN(ts) || ts < startMs || ts > endMs) return false;
    if (meterId && tx.meterId !== meterId) return false;
    if (type && tx.type !== type) return false;
    return true;
  });
}

/** Escape a value for safe inclusion in an XML text node. */
function escapeXml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Serialise energy transactions as CSV.
 * Columns: timestamp, meterId, type, amountKwh, value, metadata
 */
export function energyTransactionsToCsv(transactions: EnergyTransaction[]): string {
  const header = "timestamp,meterId,type,amountKwh,value,metadata";
  const rows = transactions.map((tx) => {
    const metadata = JSON.stringify(tx.metadata ?? null).replace(/"/g, '""');
    return `${tx.timestamp},${tx.meterId},${tx.type},${tx.amountKwh},${tx.value ?? ""},"${metadata}"`;
  });
  return [header, ...rows].join("\n");
}

/**
 * Serialise energy transactions as XML.
 */
export function energyTransactionsToXml(transactions: EnergyTransaction[]): string {
  const items = transactions
    .map((tx) => {
      const metadata = tx.metadata
        ? `<metadata>${escapeXml(JSON.stringify(tx.metadata))}</metadata>`
        : "";
      return (
        "  <transaction>" +
        `<timestamp>${escapeXml(tx.timestamp)}</timestamp>` +
        `<meterId>${escapeXml(tx.meterId)}</meterId>` +
        `<type>${escapeXml(tx.type)}</type>` +
        `<amountKwh>${escapeXml(tx.amountKwh)}</amountKwh>` +
        (tx.value !== undefined ? `<value>${escapeXml(tx.value)}</value>` : "") +
        metadata +
        "</transaction>"
      );
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<energyExport>\n${items}\n</energyExport>`;
}

/**
 * Serialise energy transactions in the requested format.
 *
 * Closes #905 — supports CSV, JSON, and XML output for GDPR data exports.
 */
export function serializeEnergyExport(
  transactions: EnergyTransaction[],
  format: ExportFormat,
): string {
  switch (format) {
    case "csv":
      return energyTransactionsToCsv(transactions);
    case "xml":
      return energyTransactionsToXml(transactions);
    case "json":
    default:
      return JSON.stringify({ transactions }, null, 2);
  }
}
