import path from "node:path";
import { mkdirSync } from "node:fs";
import Database from "better-sqlite3";
import { registerDatabase } from "./databaseLifecycle.js";
import { db as usageDb } from "./usageEvents.js";
import { fireWebhook, getWebhookUrls } from "./webhookRegistry.js";
import { logger } from "./logger.js";
import { scoreUsageAnomaly } from "./theftScoring.js";

const DB_PATH = process.env.THEFT_DETECTION_DB_PATH ?? path.resolve(process.cwd(), "data", "theft-detection.sqlite");
const SCAN_INTERVAL_MS = Number(process.env.THEFT_SCAN_INTERVAL_MS ?? 60_000);
const BASELINE_SIZE = 40;
const configuredMinimum = Number(process.env.THEFT_MIN_SPIKE_UNITS ?? 10);
const MIN_SPIKE_UNITS = Number.isFinite(configuredMinimum) && configuredMinimum >= 0 ? configuredMinimum : 10;

export type TheftAlertStatus = "open" | "investigating" | "resolved" | "false_positive";
export type TheftAlert = {
  id: number;
  event_id: number;
  meter_id: string;
  observed_units: number;
  baseline_median: number;
  anomaly_score: number;
  severity: "high" | "critical";
  detected_at: string;
  status: TheftAlertStatus;
  assigned_to: string | null;
  investigation_note: string | null;
  updated_at: string;
};
export type TheftReport = {
  month: string;
  generatedAt: string;
  totalAlerts: number;
  openAlerts: number;
  investigatingAlerts: number;
  resolvedAlerts: number;
  falsePositiveAlerts: number;
  falsePositiveRate: number | null;
  affectedMeters: number;
  meters: Array<{ meterId: string; alerts: number; highestScore: number }>;
};

let database: Database.Database | undefined;
let scanTimer: NodeJS.Timeout | undefined;
let scanRunning = false;
let lastGeneratedMonth = "";

function db(): Database.Database {
  if (!database) {
    mkdirSync(path.dirname(DB_PATH), { recursive: true });
    database = new Database(DB_PATH);
    database.pragma("journal_mode = WAL");
    database.exec(`
      CREATE TABLE IF NOT EXISTS theft_observations (
        event_id INTEGER PRIMARY KEY,
        meter_id TEXT NOT NULL,
        observed_units REAL NOT NULL,
        baseline_median REAL NOT NULL,
        anomaly_score REAL NOT NULL,
        observed_at TEXT NOT NULL,
        is_alert INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_theft_observations_meter_time ON theft_observations (meter_id, observed_at DESC);
      CREATE TABLE IF NOT EXISTS theft_alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id INTEGER NOT NULL UNIQUE,
        meter_id TEXT NOT NULL,
        observed_units REAL NOT NULL,
        baseline_median REAL NOT NULL,
        anomaly_score REAL NOT NULL,
        severity TEXT NOT NULL,
        detected_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        assigned_to TEXT,
        investigation_note TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_theft_alerts_detected ON theft_alerts (detected_at DESC);
      CREATE INDEX IF NOT EXISTS idx_theft_alerts_status ON theft_alerts (status, detected_at DESC);
      CREATE TABLE IF NOT EXISTS theft_investigation_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        alert_id INTEGER NOT NULL,
        action TEXT NOT NULL,
        actor TEXT NOT NULL,
        note TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS theft_monthly_reports (
        month TEXT PRIMARY KEY,
        generated_at TEXT NOT NULL,
        report_json TEXT NOT NULL
      );
    `);
  }
  return database;
}

registerDatabase("theft-detection", () => {
  if (scanTimer) clearInterval(scanTimer);
  database?.close();
  database = undefined;
});

async function notifyAlert(alert: TheftAlert): Promise<void> {
  const body = JSON.stringify({ event: "suspected_energy_theft", alert });
  await Promise.all([...getWebhookUrls()].map(async (url) => {
    try {
      await fireWebhook(url, body);
    } catch (error) {
      logger.warn({ alertId: alert.id, error }, "Theft alert webhook delivery failed");
    }
  }));
}

function processUsageRow(row: { id: number; meter_id: string; units: number; received_at: string }): TheftAlert | null {
  const history = usageDb().prepare(
    "SELECT units FROM usage_events WHERE meter_id = ? AND id < ? ORDER BY id DESC LIMIT ?",
  ).all(row.meter_id, row.id, BASELINE_SIZE) as Array<{ units: number }>;
  const values = history.map((entry) => Number(entry.units)).filter(Number.isFinite);
  const result = scoreUsageAnomaly(Number(row.units), values, MIN_SPIKE_UNITS);
  db().prepare(
    "INSERT OR IGNORE INTO theft_observations (event_id, meter_id, observed_units, baseline_median, anomaly_score, observed_at, is_alert) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(row.id, row.meter_id, row.units, result.baseline, result.score, row.received_at, result.anomalous ? 1 : 0);
  if (!result.anomalous) return null;

  const now = new Date().toISOString();
  const severity = result.score >= 12 ? "critical" : "high";
  const inserted = db().prepare(
    "INSERT OR IGNORE INTO theft_alerts (event_id, meter_id, observed_units, baseline_median, anomaly_score, severity, detected_at, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)",
  ).run(row.id, row.meter_id, row.units, result.baseline, result.score, severity, now, now);
  if (!inserted.changes) return null;
  const alert = db().prepare("SELECT * FROM theft_alerts WHERE id = ?").get(inserted.lastInsertRowid) as TheftAlert;
  return alert;
}

export async function scanRecentUsage(): Promise<number> {
  if (scanRunning) return 0;
  scanRunning = true;
  try {
    const rows = usageDb().prepare(
      `SELECT e.id, e.meter_id, e.units, e.received_at
         FROM usage_events e
         LEFT JOIN theft_observations o ON o.event_id = e.id
        WHERE o.event_id IS NULL AND e.received_at >= datetime('now', '-1 hour')
        ORDER BY e.id ASC LIMIT 1000`,
    ).all() as Array<{ id: number; meter_id: string; units: number; received_at: string }>;
    let created = 0;
    for (const row of rows) {
      const alert = processUsageRow(row);
      if (alert) {
        created++;
        void notifyAlert(alert);
      }
    }
    return created;
  } finally {
    scanRunning = false;
  }
}

export function startTheftMonitor(): void {
  if (scanTimer) return;
  const generatePreviousMonth = () => {
    const now = new Date();
    if (now.getUTCDate() !== 1) return;
    const previous = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
    if (previous === lastGeneratedMonth) return;
    generateTheftMonthlyReport(previous);
    lastGeneratedMonth = previous;
  };
  void scanRecentUsage().catch((error) => logger.error({ error }, "Theft scan failed"));
  generatePreviousMonth();
  scanTimer = setInterval(() => {
    void scanRecentUsage().catch((error) => logger.error({ error }, "Theft scan failed"));
    generatePreviousMonth();
  }, SCAN_INTERVAL_MS);
}

export function listTheftAlerts(options: { status?: TheftAlertStatus; limit?: number; offset?: number } = {}): { alerts: TheftAlert[]; total: number } {
  const limit = Math.min(200, Math.max(1, Math.trunc(options.limit ?? 50)));
  const offset = Math.max(0, Math.trunc(options.offset ?? 0));
  const statusClause = options.status ? "WHERE status = ?" : "";
  const args = options.status ? [options.status] : [];
  const alerts = db().prepare(
    `SELECT * FROM theft_alerts ${statusClause} ORDER BY detected_at DESC LIMIT ? OFFSET ?`,
  ).all(...args, limit, offset) as TheftAlert[];
  const { count } = db().prepare(`SELECT COUNT(*) AS count FROM theft_alerts ${statusClause}`).get(...args) as { count: number };
  return { alerts, total: count };
}

export function updateTheftInvestigation(input: {
  alertId: number;
  status: TheftAlertStatus;
  actor: string;
  assignedTo?: string | null;
  note?: string | null;
}): TheftAlert | undefined {
  const existing = db().prepare("SELECT * FROM theft_alerts WHERE id = ?").get(input.alertId) as TheftAlert | undefined;
  if (!existing) return undefined;
  const now = new Date().toISOString();
  const nextAssignee = input.assignedTo === undefined ? existing.assigned_to : input.assignedTo;
  const nextNote = input.note?.trim() ? input.note.trim().slice(0, 2000) : existing.investigation_note;
  db().prepare(
    "UPDATE theft_alerts SET status = ?, assigned_to = ?, investigation_note = ?, updated_at = ? WHERE id = ?",
  ).run(input.status, nextAssignee, nextNote, now, input.alertId);
  db().prepare(
    "INSERT INTO theft_investigation_events (alert_id, action, actor, note, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(input.alertId, input.status, input.actor, input.note?.trim() || null, now);
  return db().prepare("SELECT * FROM theft_alerts WHERE id = ?").get(input.alertId) as TheftAlert;
}

export function getTheftInvestigationHistory(alertId: number): Array<{ action: string; actor: string; note: string | null; created_at: string }> {
  return db().prepare(
    "SELECT action, actor, note, created_at FROM theft_investigation_events WHERE alert_id = ? ORDER BY id ASC",
  ).all(alertId) as Array<{ action: string; actor: string; note: string | null; created_at: string }>;
}

export function generateTheftMonthlyReport(month: string): TheftReport | null {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return null;
  const start = `${month}-01T00:00:00.000Z`;
  const [year, monthNumber] = month.split("-").map(Number);
  const end = new Date(Date.UTC(year, monthNumber, 1)).toISOString();
  const rows = db().prepare(
    "SELECT meter_id, status, anomaly_score FROM theft_alerts WHERE detected_at >= ? AND detected_at < ?",
  ).all(start, end) as Array<{ meter_id: string; status: TheftAlertStatus; anomaly_score: number }>;
  const count = (status: TheftAlertStatus) => rows.filter((row) => row.status === status).length;
  const closed = count("resolved") + count("false_positive");
  const grouped = new Map<string, { alerts: number; highestScore: number }>();
  for (const row of rows) {
    const current = grouped.get(row.meter_id) ?? { alerts: 0, highestScore: 0 };
    current.alerts++;
    current.highestScore = Math.max(current.highestScore, row.anomaly_score);
    grouped.set(row.meter_id, current);
  }
  const report: TheftReport = {
    month,
    generatedAt: new Date().toISOString(),
    totalAlerts: rows.length,
    openAlerts: count("open"),
    investigatingAlerts: count("investigating"),
    resolvedAlerts: count("resolved"),
    falsePositiveAlerts: count("false_positive"),
    falsePositiveRate: closed ? count("false_positive") / closed : null,
    affectedMeters: grouped.size,
    meters: [...grouped].map(([meterId, values]) => ({ meterId, ...values })).sort((a, b) => b.alerts - a.alerts),
  };
  db().prepare("INSERT OR REPLACE INTO theft_monthly_reports (month, generated_at, report_json) VALUES (?, ?, ?)")
    .run(month, report.generatedAt, JSON.stringify(report));
  return report;
}