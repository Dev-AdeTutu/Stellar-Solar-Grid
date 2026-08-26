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
 */

import fs from "node:fs";
import path from "node:path";
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
