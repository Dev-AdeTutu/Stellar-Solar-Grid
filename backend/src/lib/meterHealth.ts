/**
 * Meter health monitoring (#834).
 *
 * Meters publish periodic heartbeats on `solargrid/meters/{meterId}/heartbeat`
 * (or via `POST /api/meters/:meterId/heartbeat`). We track the last heartbeat,
 * response time and error counts per meter and classify each meter as:
 *
 *   green  — heartbeat within HEALTH_YELLOW_AFTER_MS (default 1h), error rate < 10%
 *   yellow — heartbeat older than 1h, or error rate >= 10%
 *   red    — no heartbeat for HEALTH_RED_AFTER_MS (default 24h) → alert raised
 */
import { randomUUID } from "node:crypto";
import { logger } from "./logger.js";
import { getDb } from "./db.js";
import { publishCommand } from "./mqttBridge.js";

export type HealthStatus = "green" | "yellow" | "red";

/**
 * Edge runtime status reported by a meter running the edge computing runtime
 * (#1069). Meters include this block in their heartbeat payload so operators
 * can see which meters are running local inference and whether they are
 * currently offline (buffering results until connectivity returns).
 */
export type EdgeStatusInput = {
  modelVersion?: string;
  lastInferenceAt?: number;
  bufferSize?: number;
  offline?: boolean;
};

export type HeartbeatInput = {
  responseTimeMs?: number;
  error?: boolean;
  receivedAt?: number;
  edge?: EdgeStatusInput;
};

type EdgeRuntimeState = {
  modelVersion: string | null;
  lastInferenceAt: number | null;
  bufferSize: number;
  offline: boolean;
  updatedAt: number;
};

type MeterHealthState = {
  meterId: string;
  firstSeen: number;
  lastHeartbeat: number;
  heartbeatCount: number;
  errorCount: number;
  totalResponseTimeMs: number;
  responseSamples: number;
  alerted: boolean;
  edge?: EdgeRuntimeState;
};

export type EdgeRuntimeHealth = {
  modelVersion: string | null;
  lastInferenceAt: string | null;
  secondsSinceInference: number | null;
  bufferSize: number;
  offline: boolean;
  updatedAt: string;
};

export type MeterHealth = {
  meterId: string;
  status: HealthStatus;
  lastHeartbeat: string;
  secondsSinceHeartbeat: number;
  heartbeatCount: number;
  errorRate: number;
  avgResponseTimeMs: number | null;
  uptimePercent: number;
  edge: EdgeRuntimeHealth | null;
};

const YELLOW_AFTER_MS = Number(process.env.HEALTH_YELLOW_AFTER_MS ?? 60 * 60 * 1000);
const RED_AFTER_MS = Number(process.env.HEALTH_RED_AFTER_MS ?? 24 * 60 * 60 * 1000);
const HEARTBEAT_INTERVAL_MS = Number(process.env.HEARTBEAT_INTERVAL_MS ?? 5 * 60 * 1000);
const ERROR_RATE_WARN = 0.1;

const meters = new Map<string, MeterHealthState>();

export function recordHeartbeat(meterId: string, input: HeartbeatInput = {}): MeterHealthState {
  const now = input.receivedAt ?? Date.now();
  let state = meters.get(meterId);
  if (!state) {
    state = {
      meterId,
      firstSeen: now,
      lastHeartbeat: now,
      heartbeatCount: 0,
      errorCount: 0,
      totalResponseTimeMs: 0,
      responseSamples: 0,
      alerted: false,
    };
    meters.set(meterId, state);
  }
  state.lastHeartbeat = Math.max(state.lastHeartbeat, now);
  state.heartbeatCount += 1;
  if (input.error) state.errorCount += 1;
  if (typeof input.responseTimeMs === "number" && input.responseTimeMs >= 0) {
    state.totalResponseTimeMs += input.responseTimeMs;
    state.responseSamples += 1;
  }
  if (input.edge) {
    const prev = state.edge;
    state.edge = {
      modelVersion:
        typeof input.edge.modelVersion === "string"
          ? input.edge.modelVersion
          : (prev?.modelVersion ?? null),
      lastInferenceAt:
        typeof input.edge.lastInferenceAt === "number" && input.edge.lastInferenceAt >= 0
          ? input.edge.lastInferenceAt
          : (prev?.lastInferenceAt ?? null),
      bufferSize:
        typeof input.edge.bufferSize === "number" && input.edge.bufferSize >= 0
          ? Math.floor(input.edge.bufferSize)
          : (prev?.bufferSize ?? 0),
      offline: typeof input.edge.offline === "boolean" ? input.edge.offline : (prev?.offline ?? false),
      updatedAt: now,
    };
  }
  state.alerted = false;
  return state;
}

function parseEdgeStatus(body: Record<string, unknown>): EdgeStatusInput | undefined {
  const raw = body.edge;
  if (!raw || typeof raw !== "object") return undefined;
  const edge = raw as Record<string, unknown>;
  const result: EdgeStatusInput = {};
  if (typeof edge.modelVersion === "string") result.modelVersion = edge.modelVersion;
  if (typeof edge.lastInferenceAt === "number") result.lastInferenceAt = edge.lastInferenceAt;
  else if (typeof edge.lastInferenceAt === "string") {
    const parsed = Date.parse(edge.lastInferenceAt);
    if (!Number.isNaN(parsed)) result.lastInferenceAt = parsed;
  }
  if (typeof edge.bufferSize === "number") result.bufferSize = edge.bufferSize;
  if (typeof edge.offline === "boolean") result.offline = edge.offline;
  return result;
}

/** Parse an MQTT heartbeat payload (JSON, optional fields) and record it. */
export function handleHeartbeatMessage(meterId: string | undefined, payload: Buffer): void {
  if (!meterId) return;
  let body: Record<string, unknown> = {};
  try {
    const text = payload.toString().trim();
    if (text) body = JSON.parse(text);
  } catch {
    logger.warn({ meterId }, "Malformed heartbeat payload; recording as bare heartbeat");
  }
  recordHeartbeat(meterId, {
    responseTimeMs: typeof body.responseTimeMs === "number" ? body.responseTimeMs : undefined,
    error: body.error === true || body.status === "error",
    edge: parseEdgeStatus(body),
  });
}

export function classify(state: MeterHealthState, now = Date.now()): HealthStatus {
  const age = now - state.lastHeartbeat;
  if (age >= RED_AFTER_MS) return "red";
  const errorRate = state.heartbeatCount ? state.errorCount / state.heartbeatCount : 0;
  if (age >= YELLOW_AFTER_MS || errorRate >= ERROR_RATE_WARN) return "yellow";
  return "green";
}

function toEdgeHealth(edge: EdgeRuntimeState, now: number): EdgeRuntimeHealth {
  return {
    modelVersion: edge.modelVersion,
    lastInferenceAt:
      edge.lastInferenceAt !== null ? new Date(edge.lastInferenceAt).toISOString() : null,
    secondsSinceInference:
      edge.lastInferenceAt !== null
        ? Math.max(0, Math.floor((now - edge.lastInferenceAt) / 1000))
        : null,
    bufferSize: edge.bufferSize,
    offline: edge.offline,
    updatedAt: new Date(edge.updatedAt).toISOString(),
  };
}

function toHealth(state: MeterHealthState, now = Date.now()): MeterHealth {
  const expected = Math.max(1, Math.floor((now - state.firstSeen) / HEARTBEAT_INTERVAL_MS) + 1);
  return {
    meterId: state.meterId,
    status: classify(state, now),
    lastHeartbeat: new Date(state.lastHeartbeat).toISOString(),
    secondsSinceHeartbeat: Math.max(0, Math.floor((now - state.lastHeartbeat) / 1000)),
    heartbeatCount: state.heartbeatCount,
    errorRate: state.heartbeatCount ? state.errorCount / state.heartbeatCount : 0,
    avgResponseTimeMs: state.responseSamples
      ? state.totalResponseTimeMs / state.responseSamples
      : null,
    uptimePercent: Math.min(100, (state.heartbeatCount / expected) * 100),
    edge: state.edge ? toEdgeHealth(state.edge, now) : null,
  };
}

export function getMeterHealth(meterId: string, now = Date.now()): MeterHealth | undefined {
  const state = meters.get(meterId);
  return state ? toHealth(state, now) : undefined;
}

export function getAllMeterHealth(now = Date.now()) {
  const all = [...meters.values()].map((s) => toHealth(s, now));
  const summary = { green: 0, yellow: 0, red: 0 } as Record<HealthStatus, number>;
  for (const m of all) summary[m.status] += 1;
  const edge = {
    withEdge: 0,
    offline: 0,
    buffering: 0,
  };
  for (const m of all) {
    if (!m.edge) continue;
    edge.withEdge += 1;
    if (m.edge.offline) edge.offline += 1;
    if (m.edge.bufferSize > 0) edge.buffering += 1;
  }
  return { summary, edge, meters: all };
}

/** Raise (log) an alert once per meter that has been silent for 24h. Returns alerted IDs. */
export function checkStaleMeters(now = Date.now()): string[] {
  const alerted: string[] = [];
  for (const state of meters.values()) {
    if (!state.alerted && now - state.lastHeartbeat >= RED_AFTER_MS) {
      state.alerted = true;
      alerted.push(state.meterId);
      logger.warn(
        { meterId: state.meterId, lastHeartbeat: new Date(state.lastHeartbeat).toISOString() },
        "ALERT: meter has not reported a heartbeat in 24 hours",
      );

      // #1000 — notify the meter owner's emergency contacts on an extended
      // outage. Best-effort and fire-and-forget: resolve the owning
      // user_address via the device registry and hand off to the pure
      // notification helper; a failure here must never break health
      // monitoring itself.
      void (async () => {
        try {
          const [device] = listDevices({ meterId: state.meterId });
          if (device?.owner) {
            await notifyEmergencyContacts(device.owner, "outage", state.meterId);
          }
        } catch (error) {
          logger.warn({ meterId: state.meterId, error }, "Emergency contact notification failed for meter outage");
        }
      })();
    }
  }
  return alerted;
}

let timer: NodeJS.Timeout | undefined;
export function startHealthMonitor(intervalMs = 15 * 60 * 1000): void {
  if (timer) return;
  timer = setInterval(() => checkStaleMeters(), intervalMs);
  timer.unref?.();
}

export function _resetMeterHealth(): void {
  meters.clear();
}

/* ------------------------------------------------------------------ *
 * Remote diagnostics (#993)
 * ------------------------------------------------------------------ */

export type DiagnosticCommand = "reboot" | "self-test" | "check-connectivity";

export type DiagnosticStatus = "pending" | "success" | "failure";

export type DiagnosticResult = {
  status: DiagnosticStatus;
  output?: string;
  durationMs?: number;
  error?: string;
};

export type DiagnosticLog = {
  id: number;
  meterId: string;
  requestId: string;
  command: DiagnosticCommand;
  status: DiagnosticStatus;
  output: string | null;
  durationMs: number | null;
  error: string | null;
  requestedAt: string;
  completedAt: string | null;
};

export type DiagnosticRequest = {
  meterId: string;
  requestId: string;
  command: DiagnosticCommand;
  status: DiagnosticStatus;
  requestedAt: string;
};

export type ListDiagnosticLogsOptions = {
  limit?: number;
  command?: DiagnosticCommand;
};

const DIAGNOSTIC_COMMANDS: DiagnosticCommand[] = ["reboot", "self-test", "check-connectivity"];

export function isDiagnosticCommand(value: unknown): value is DiagnosticCommand {
  return typeof value === "string" && (DIAGNOSTIC_COMMANDS as string[]).includes(value);
}

function ensureDiagnosticTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS diagnostic_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meter_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      command TEXT NOT NULL,
      status TEXT NOT NULL,
      output TEXT,
      duration_ms INTEGER,
      error TEXT,
      requested_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_diagnostic_logs_meter
      ON diagnostic_logs (meter_id, requested_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_diagnostic_logs_request
      ON diagnostic_logs (request_id);
  `);
}

type DiagnosticRow = {
  id: number;
  meter_id: string;
  request_id: string;
  command: string;
  status: string;
  output: string | null;
  duration_ms: number | null;
  error: string | null;
  requested_at: string;
  completed_at: string | null;
};

function rowToLog(row: DiagnosticRow): DiagnosticLog {
  return {
    id: row.id,
    meterId: row.meter_id,
    requestId: row.request_id,
    command: row.command as DiagnosticCommand,
    status: row.status as DiagnosticStatus,
    output: row.output,
    durationMs: row.duration_ms,
    error: row.error,
    requestedAt: row.requested_at,
    completedAt: row.completed_at,
  };
}

/**
 * Record a pending diagnostic and publish the command to the meter over MQTT.
 * Returns the created request (including the generated requestId).
 */
export function triggerDiagnostic(
  meterId: string,
  command: DiagnosticCommand,
): DiagnosticRequest {
  if (!isDiagnosticCommand(command)) {
    throw new Error(`Unsupported diagnostic command: ${command}`);
  }
  ensureDiagnosticTable();
  const requestId = randomUUID();
  const requestedAt = new Date().toISOString();
  const db = getDb();
  db.prepare(
    `INSERT INTO diagnostic_logs
       (meter_id, request_id, command, status, requested_at)
     VALUES (?, ?, ?, 'pending', ?)`,
  ).run(meterId, requestId, command, requestedAt);

  try {
    publishCommand(meterId, command, { requestId });
  } catch (err) {
    logger.error({ err, meterId, command, requestId }, "Failed to publish diagnostic command");
  }

  logger.info({ meterId, command, requestId }, "Diagnostic command triggered");
  return { meterId, requestId, command, status: "pending", requestedAt };
}

/** Persist the outcome reported by the meter for a previously triggered diagnostic. */
export function recordDiagnosticResult(
  meterId: string,
  requestId: string,
  result: DiagnosticResult,
): DiagnosticLog | undefined {
  ensureDiagnosticTable();
  const db = getDb();
  const completedAt = new Date().toISOString();
  const info = db
    .prepare(
      `UPDATE diagnostic_logs
         SET status = ?, output = ?, duration_ms = ?, error = ?, completed_at = ?
       WHERE meter_id = ? AND request_id = ?`,
    )
    .run(
      result.status,
      result.output ?? null,
      typeof result.durationMs === "number" ? Math.round(result.durationMs) : null,
      result.error ?? null,
      completedAt,
      meterId,
      requestId,
    );

  if (info.changes === 0) {
    logger.warn({ meterId, requestId }, "Diagnostic result for unknown request");
    return undefined;
  }

  logger.info(
    { meterId, requestId, status: result.status, durationMs: result.durationMs },
    "Diagnostic result recorded",
  );
  const row = db
    .prepare(`SELECT * FROM diagnostic_logs WHERE meter_id = ? AND request_id = ?`)
    .get(meterId, requestId) as DiagnosticRow | undefined;
  return row ? rowToLog(row) : undefined;
}

/** Return recent diagnostic results for a meter, newest first. */
export function listDiagnosticLogs(
  meterId: string,
  options: ListDiagnosticLogsOptions = {},
): DiagnosticLog[] {
  ensureDiagnosticTable();
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);
  const db = getDb();
  const rows = options.command
    ? (db
        .prepare(
          `SELECT * FROM diagnostic_logs
             WHERE meter_id = ? AND command = ?
             ORDER BY requested_at DESC, id DESC
             LIMIT ?`,
        )
        .all(meterId, options.command, limit) as DiagnosticRow[])
    : (db
        .prepare(
          `SELECT * FROM diagnostic_logs
             WHERE meter_id = ?
             ORDER BY requested_at DESC, id DESC
             LIMIT ?`,
        )
        .all(meterId, limit) as DiagnosticRow[]);
  return rows.map(rowToLog);
}

export type IssuePattern = {
  id: string;
  description: string;
  match: (result: DiagnosticResult) => boolean;
  suggestedFix: string;
};

/**
 * Knowledge base of common issue signatures observed in diagnostic results,
 * each mapped to a suggested fix for technicians.
 */
export const COMMON_ISSUE_PATTERNS: IssuePattern[] = [
  {
    id: "reboot-failure",
    description: "Meter failed to reboot (repeated reboot failures)",
    match: (r) => r.status === "failure" && /reboot/i.test(r.error ?? r.output ?? ""),
    suggestedFix:
      "Power-cycle the meter locally and verify firmware version; if reboots keep failing, schedule a firmware reflash or hardware replacement.",
  },
  {
    id: "high-latency",
    description: "Diagnostic completed but with high latency",
    match: (r) => typeof r.durationMs === "number" && r.durationMs > 5000,
    suggestedFix:
      "Check network signal strength and SIM data plan; move the meter antenna or switch to a stronger carrier if latency persists.",
  },
  {
    id: "packet-loss",
    description: "Connectivity check reported packet loss",
    match: (r) => /packet\s*loss|timeout|unreachable/i.test(`${r.error ?? ""} ${r.output ?? ""}`),
    suggestedFix:
      "Verify the meter's network route and firewall rules; reset the modem and confirm the broker host is reachable.",
  },
  {
    id: "self-test-failure",
    description: "Self-test reported a hardware or firmware fault",
    match: (r) => r.status === "failure" && /self-?test/i.test(r.error ?? r.output ?? ""),
    suggestedFix:
      "Review the self-test output for the failing subsystem; replace the affected module or escalate to the hardware team.",
  },
  {
    id: "generic-failure",
    description: "Diagnostic failed without a recognised signature",
    match: (r) => r.status === "failure",
    suggestedFix:
      "Retry the diagnostic; if it keeps failing, collect the full log and escalate to the engineering team.",
  },
];

/** Return a suggested fix for a diagnostic result, or undefined if none match. */
export function getSuggestedFix(result: DiagnosticResult): string | undefined {
  return COMMON_ISSUE_PATTERNS.find((p) => p.match(result))?.suggestedFix;
}
