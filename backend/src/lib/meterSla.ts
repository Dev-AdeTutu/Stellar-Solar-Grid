import { randomUUID } from "node:crypto";
import { z } from "zod";
import { DeviceIdSchema } from "../iot/telemetrySchemas.js";
import { operationsDb, type Observation } from "./meterOperationsStore.js";
import type { Publisher } from "./loadBalancing.js";

export const SlaTargetSchema = z.object({
  uptimePct: z.number().min(0).max(100).default(99.5),
  responseP95Ms: z.number().finite().positive().max(60_000).default(1000),
  responseSuccessPct: z.number().min(0).max(100).default(99),
  mtbfMs: z.number().finite().positive().max(365 * 86_400_000).default(86_400_000),
  heartbeatTimeoutMs: z.number().int().min(1000).max(3_600_000).default(60_000),
  probeTimeoutMs: z.number().int().min(1000).max(60_000).default(5000),
  windowMs: z.number().int().min(60_000).max(30 * 86_400_000).default(86_400_000),
}).strict();
export type SlaTarget = z.infer<typeof SlaTargetSchema>;
export const SlaPongSchema = z.object({ version: z.literal(1), cmd: z.literal("SLA_PONG"), probeId: z.string().uuid() }).strict();
export type SlaProbe = { id: string; meter_id: string; sent_at: number; deadline: number; acknowledged_at: number | null; status: string };
export type TargetRecord = { meterId: string; target: SlaTarget; configuredAt: number };

function slaDb() {
  const db = operationsDb();
  db.exec(`CREATE TABLE IF NOT EXISTS sla_probes (
    id TEXT PRIMARY KEY, meter_id TEXT NOT NULL, sent_at INTEGER NOT NULL, deadline INTEGER NOT NULL,
    acknowledged_at INTEGER, status TEXT NOT NULL
  ); CREATE INDEX IF NOT EXISTS sla_probes_meter ON sla_probes(meter_id,sent_at);`);
  return db;
}
export function slaTargets(): TargetRecord[] {
  return (slaDb().prepare("SELECT * FROM sla_targets ORDER BY meter_id").all() as Array<{ meter_id: string; json: string; configured_at: number }>).map(r => ({ meterId: r.meter_id, target: SlaTargetSchema.parse(JSON.parse(r.json)), configuredAt: r.configured_at }));
}
export function saveSlaTarget(meterId: string, input: unknown, now = Date.now()) {
  DeviceIdSchema.parse(meterId);
  const target = SlaTargetSchema.parse(input);
  // Policy changes start a new measurement epoch; historical reports remain immutable.
  slaDb().prepare("INSERT INTO sla_targets(meter_id,json,configured_at) VALUES(?,?,?) ON CONFLICT(meter_id) DO UPDATE SET json=excluded.json, configured_at=excluded.configured_at").run(meterId, JSON.stringify(target), now);
  return { meterId, target, configuredAt: now };
}

/** Integrate actual covered time, never average sparse online samples. All windows are [since, until). */
export function calculateSla(observations: Observation[], probes: SlaProbe[], target: SlaTarget, since: number, until: number) {
  if (until <= since) throw new Error("SLA window must have positive duration");
  const ordered = [...observations].filter(o => o.received_at < until).sort((a, b) => a.received_at - b.received_at || a.sequence - b.sequence);
  const intervals: Array<[number, number]> = [];
  for (let i = 0; i < ordered.length; i++) {
    const o = ordered[i];
    if (!o.active || !o.available) continue;
    const start = Math.max(since, o.received_at);
    const end = Math.min(until, o.received_at + target.heartbeatTimeoutMs, ordered[i + 1]?.received_at ?? until);
    if (end <= start) continue;
    const previous = intervals[intervals.length - 1];
    if (previous && previous[1] >= start) previous[1] = Math.max(previous[1], end);
    else intervals.push([start, end]);
  }
  const uptimeMs = intervals.reduce((sum, [a, b]) => sum + b - a, 0);
  // A failure is an observed online -> unavailable transition (including silence), not initial unknown time.
  const failures = intervals.filter(([, end]) => end < until).length;
  const evaluated = probes.filter(p => p.sent_at >= since && p.sent_at < until &&
    (p.status === "acknowledged" && p.acknowledged_at !== null && p.acknowledged_at < until || p.deadline < until));
  const rtts = evaluated.filter(p => p.status === "acknowledged" && p.acknowledged_at !== null && p.acknowledged_at < until && p.acknowledged_at <= p.deadline)
    .map(p => p.acknowledged_at! - p.sent_at).sort((a, b) => a - b);
  const metrics = {
    uptimePct: uptimeMs * 100 / (until - since), uptimeMs, downtimeMs: until - since - uptimeMs, failures,
    responseP95Ms: rtts.length ? rtts[Math.ceil(rtts.length * 0.95) - 1] : null,
    responseSuccessPct: evaluated.length ? rtts.length * 100 / evaluated.length : null,
    responseSamples: evaluated.length, mtbfMs: failures ? uptimeMs / failures : null,
  };
  const compliance = {
    uptimePct: metrics.uptimePct >= target.uptimePct ? "met" : "breached",
    responseP95Ms: metrics.responseP95Ms === null ? "insufficient_data" : metrics.responseP95Ms <= target.responseP95Ms ? "met" : "breached",
    responseSuccessPct: metrics.responseSuccessPct === null ? "insufficient_data" : metrics.responseSuccessPct >= target.responseSuccessPct ? "met" : "breached",
    mtbfMs: metrics.mtbfMs === null ? "insufficient_data" : metrics.mtbfMs >= target.mtbfMs ? "met" : "breached",
  } as const;
  return { since, until, target, metrics, compliance };
}

export function meterSlaReport(meterId: string, now = Date.now()) {
  const config = slaTargets().find(t => t.meterId === meterId);
  if (!config) return null;
  const since = Math.max(config.configuredAt, now - config.target.windowMs);
  if (since >= now) return { meterId, configuredAt: config.configuredAt, report: null };
  const db = slaDb();
  const observations = db.prepare("SELECT * FROM meter_observations WHERE meter_id=? AND received_at>=? AND received_at<? ORDER BY received_at,sequence").all(meterId, since - config.target.heartbeatTimeoutMs, now) as Observation[];
  const probes = db.prepare("SELECT * FROM sla_probes WHERE meter_id=? AND sent_at>=? AND sent_at<?").all(meterId, since, now) as SlaProbe[];
  return { meterId, configuredAt: config.configuredAt, report: calculateSla(observations, probes, config.target, since, now) };
}

export async function sendSlaProbes(publish: Publisher, clock?: number) {
  const db = slaDb();
  db.prepare("UPDATE sla_probes SET status='timeout' WHERE status='pending' AND deadline<=?").run(clock ?? Date.now());
  for (const config of slaTargets()) {
    const now = clock ?? Date.now();
    if (db.prepare("SELECT id FROM sla_probes WHERE meter_id=? AND status='pending'").get(config.meterId)) continue;
    const previous = db.prepare("SELECT sent_at FROM sla_probes WHERE meter_id=? ORDER BY sent_at DESC LIMIT 1").get(config.meterId) as { sent_at: number } | undefined;
    if (previous && now - previous.sent_at < 30_000) continue;
    const id = randomUUID();
    db.prepare("INSERT INTO sla_probes(id,meter_id,sent_at,deadline,status) VALUES(?,?,?,?,'pending')").run(id, config.meterId, now, now + config.target.probeTimeoutMs);
    try {
      await publish(`solargrid/meters/${config.meterId}/control`, JSON.stringify({ version: 1, cmd: "SLA_PING", probeId: id, expiresAt: now + config.target.probeTimeoutMs }));
    } catch {
      // Probe failure includes backend/broker transport: this is end-to-end service RTT, not pure device latency.
      db.prepare("UPDATE sla_probes SET status='timeout' WHERE id=? AND status='pending'").run(id);
    }
  }
}
export function acknowledgeSlaProbe(meterId: string, input: unknown, now = Date.now()): boolean {
  const pong = SlaPongSchema.parse(input);
  return slaDb().prepare("UPDATE sla_probes SET status='acknowledged', acknowledged_at=? WHERE id=? AND meter_id=? AND status='pending' AND sent_at<=? AND deadline>=?").run(now, pong.probeId, meterId, now, now).changes > 0;
}

export function slaTrends(meterId: string, limit = 30) {
  return (slaDb().prepare("SELECT json FROM sla_reports WHERE meter_id=? ORDER BY bucket DESC LIMIT ?").all(meterId, limit) as Array<{ json: string }>).map(r => JSON.parse(r.json));
}
export function slaAlerts(meterId?: string) {
  const rows = meterId ? slaDb().prepare("SELECT json FROM sla_alerts WHERE meter_id=? ORDER BY created_at DESC LIMIT 100").all(meterId)
    : slaDb().prepare("SELECT json FROM sla_alerts ORDER BY created_at DESC LIMIT 100").all();
  return (rows as Array<{ json: string }>).map(r => JSON.parse(r.json));
}

/** Store reports once/hour and dedupe alert transitions durably, including across restarts. */
export function evaluateSla(now = Date.now()) {
  const db = slaDb();
  const alerts: Array<Record<string, unknown>> = [];
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const config of slaTargets()) {
      const result = meterSlaReport(config.meterId, now);
      if (!result?.report) continue;
      db.prepare("INSERT OR IGNORE INTO sla_reports(meter_id,bucket,json) VALUES(?,?,?)").run(config.meterId, Math.floor(now / 3_600_000), JSON.stringify(result));
      for (const [metric, state] of Object.entries(result.report.compliance)) {
        if (state === "insufficient_data") continue; // unknown must never falsely recover a breach
        const previous = db.prepare("SELECT breached FROM sla_states WHERE meter_id=? AND metric=?").get(config.meterId, metric) as { breached: number } | undefined;
        const breached = state === "breached" ? 1 : 0;
        if (breached !== (previous?.breached ?? 0)) {
          const id = randomUUID();
          const alert = { id, event: breached ? "sla_breach" : "sla_recovery", meterId: config.meterId, metric, timestamp: new Date(now).toISOString(), report: result.report };
          db.prepare("INSERT INTO sla_alerts(id,meter_id,metric,event,created_at,json) VALUES(?,?,?,?,?,?)").run(id, config.meterId, metric, alert.event, now, JSON.stringify(alert));
          alerts.push(alert);
        }
        db.prepare("INSERT INTO sla_states(meter_id,metric,breached) VALUES(?,?,?) ON CONFLICT(meter_id,metric) DO UPDATE SET breached=excluded.breached").run(config.meterId, metric, breached);
      }
    }
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return alerts;
}
