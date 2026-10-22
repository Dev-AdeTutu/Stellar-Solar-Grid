/**
 * Grid resilience scoring (#941).
 *
 * The score (0-100) is a weighted mix of metrics derived from live meter
 * health (see meterHealth.ts):
 *
 *   availability  30%  share of meters that are not red
 *   uptime        25%  mean heartbeat uptime
 *   reliability   20%  1 - mean error rate
 *   latency       10%  mean response time vs. LATENCY_TARGET_MS
 *   redundancy    15%  number of reporting meters vs. REDUNDANCY_TARGET
 *
 * Each computation detects vulnerabilities, maps them to recommendations and
 * snapshots into an in-memory history for trend analysis. A background timer
 * refreshes the score so it stays current without requests.
 */
import { getAllMeterHealth } from "./meterHealth.js";
import { getBatteryStatus } from "./battery.js";
import { getTradingState } from "./p2pTrading.js";

export type Severity = "low" | "medium" | "high" | "critical";
export type Vulnerability = { id: string; severity: Severity; metric: string; message: string; meterIds?: string[] };
export type Recommendation = { vulnerabilityId: string; priority: Severity; action: string };
export type ResilienceMetrics = Record<"availability" | "uptime" | "reliability" | "latency" | "redundancy", number>;
export type ResilienceScore = {
  score: number;
  grade: "A" | "B" | "C" | "D" | "F";
  metrics: ResilienceMetrics;
  meterCount: number;
  vulnerabilities: Vulnerability[];
  recommendations: Recommendation[];
  computedAt: string;
};
export type ResilienceSnapshot = { at: string; score: number; metrics: ResilienceMetrics };

// ---------------------------------------------------------------------------
// Micro-grid island mode (#1041)
// ---------------------------------------------------------------------------
export type IslandState = "grid-connected" | "islanded" | "resyncing";
export type GridSignal = { meterId: string; frequencyHz: number; voltageV: number; at: number };
export type IslandEvent = { at: string; from: IslandState; to: IslandState; reason: string };
export type IslandStatus = {
  state: IslandState;
  since: string;
  members: string[];
  localGenerationKw: number;
  storageSocPercent: number;
  p2pEnabled: boolean;
  lastEvent: IslandEvent | null;
  events: IslandEvent[];
};

const NOMINAL_FREQ_HZ = Number(process.env.ISLAND_NOMINAL_FREQ_HZ ?? 50);
const NOMINAL_VOLTAGE_V = Number(process.env.ISLAND_NOMINAL_VOLTAGE_V ?? 230);
const FREQ_TOLERANCE_HZ = Number(process.env.ISLAND_FREQ_TOLERANCE_HZ ?? 0.5);
const VOLTAGE_TOLERANCE_V = Number(process.env.ISLAND_VOLTAGE_TOLERANCE_V ?? 20);
const SIGNAL_STALE_MS = Number(process.env.ISLAND_SIGNAL_STALE_MS ?? 30_000);
const RESYNC_STABLE_MS = Number(process.env.ISLAND_RESYNC_STABLE_MS ?? 10_000);
const EVENT_LIMIT = Number(process.env.ISLAND_EVENT_LIMIT ?? 100);

const island: {
  state: IslandState;
  since: number;
  members: string[];
  signals: Map<string, GridSignal>;
  resyncSince: number | null;
  events: IslandEvent[];
} = { state: "grid-connected", since: Date.now(), members: [], signals: new Map(), resyncSince: null, events: [] };

function recordIslandEvent(from: IslandState, to: IslandState, reason: string, now: number): void {
  island.state = to;
  island.since = now;
  island.events.push({ at: new Date(now).toISOString(), from, to, reason });
  if (island.events.length > EVENT_LIMIT) island.events.splice(0, island.events.length - EVENT_LIMIT);
}

/** Ingest a frequency/voltage reading from an IoT meter (called from MQTT handler). */
export function ingestGridSignal(meterId: string, frequencyHz: number, voltageV: number, now = Date.now()): void {
  island.signals.set(meterId, { meterId, frequencyHz, voltageV, at: now });
  if (!island.members.includes(meterId)) island.members.push(meterId);
}

const withinTolerance = (s: GridSignal) =>
  Math.abs(s.frequencyHz - NOMINAL_FREQ_HZ) <= FREQ_TOLERANCE_HZ && Math.abs(s.voltageV - NOMINAL_VOLTAGE_V) <= VOLTAGE_TOLERANCE_V;

/** True when the majority of fresh meter signals are outside nominal tolerances. */
export function detectGridDisconnection(now = Date.now()): boolean {
  const fresh = [...island.signals.values()].filter((s) => now - s.at <= SIGNAL_STALE_MS);
  if (!fresh.length) return false;
  const abnormal = fresh.filter((s) => !withinTolerance(s)).length;
  return abnormal / fresh.length > 0.5;
}

/** True when all fresh signals are back within nominal tolerances. */
export function isGridStable(now = Date.now()): boolean {
  const fresh = [...island.signals.values()].filter((s) => now - s.at <= SIGNAL_STALE_MS);
  return fresh.length > 0 && fresh.every(withinTolerance);
}

function localResources(): { localGenerationKw: number; storageSocPercent: number } {
  let localGenerationKw = 0;
  let storageSocPercent = 0;
  try {
    const battery = getBatteryStatus();
    localGenerationKw = Number(battery?.chargeRateKw ?? 0);
    storageSocPercent = Number(battery?.socPercent ?? 0);
  } catch {
    /* battery module unavailable */
  }
  return { localGenerationKw, storageSocPercent };
}

function p2pEnabled(): boolean {
  try {
    return getTradingState().enabled !== false;
  } catch {
    return false;
  }
}

/**
 * Advance the island state machine based on current grid signals.
 * grid-connected -> islanded on disconnection detection;
 * islanded -> resyncing once the grid is stable;
 * resyncing -> grid-connected after RESYNC_STABLE_MS of stability.
 */
export function evaluateIslandMode(now = Date.now()): IslandStatus {
  if (island.state === "grid-connected") {
    if (detectGridDisconnection(now)) recordIslandEvent("grid-connected", "islanded", "main grid disconnection detected", now);
  } else if (island.state === "islanded") {
    if (isGridStable(now)) {
      island.resyncSince = now;
      recordIslandEvent("islanded", "resyncing", "grid signals stable; synchronizing frequency/phase", now);
    }
  } else if (island.state === "resyncing") {
    if (!isGridStable(now)) {
      island.resyncSince = null;
      recordIslandEvent("resyncing", "islanded", "grid instability during resync", now);
    } else if (island.resyncSince !== null && now - island.resyncSince >= RESYNC_STABLE_MS) {
      island.resyncSince = null;
      recordIslandEvent("resyncing", "grid-connected", "frequency/phase synchronized; reconnected to main grid", now);
    }
  }
  return getIslandStatus(now);
}

export function getIslandStatus(now = Date.now()): IslandStatus {
  const { localGenerationKw, storageSocPercent } = localResources();
  return {
    state: island.state,
    since: new Date(island.since).toISOString(),
    members: [...island.members],
    localGenerationKw,
    storageSocPercent,
    p2pEnabled: island.state !== "grid-connected" && p2pEnabled(),
    lastEvent: island.events.at(-1) ?? null,
    events: [...island.events],
  };
}

/** P2P energy sharing is only permitted between members while islanded. */
export function canShareEnergy(fromMeterId: string, toMeterId: string): boolean {
  if (island.state !== "islanded") return false;
  return island.members.includes(fromMeterId) && island.members.includes(toMeterId);
}

export function _resetIslandMode(): void {
  island.state = "grid-connected";
  island.since = Date.now();
  island.members = [];
  island.signals.clear();
  island.resyncSince = null;
  island.events = [];
}

const WEIGHTS: ResilienceMetrics = { availability: 0.3, uptime: 0.25, reliability: 0.2, latency: 0.1, redundancy: 0.15 };
const LATENCY_TARGET_MS = Number(process.env.RESILIENCE_LATENCY_TARGET_MS ?? 500);
const REDUNDANCY_TARGET = Number(process.env.RESILIENCE_REDUNDANCY_TARGET ?? 10);
const HISTORY_LIMIT = Number(process.env.RESILIENCE_HISTORY_LIMIT ?? 288);

const history: ResilienceSnapshot[] = [];

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const round = (n: number) => Math.round(n * 10) / 10;

function grade(score: number): ResilienceScore["grade"] {
  return score >= 90 ? "A" : score >= 75 ? "B" : score >= 60 ? "C" : score >= 40 ? "D" : "F";
}

const ACTIONS: Record<string, { action: string }> = {
  "offline-meters": { action: "Dispatch field maintenance to offline meters and verify power/network connectivity." },
  "degraded-meters": { action: "Investigate degraded meters for intermittent connectivity or firmware faults." },
  "high-error-rate": { action: "Review error logs for affected meters and roll out firmware or configuration fixes." },
  "high-latency": { action: "Add MQTT broker capacity or edge gateways closer to meters to reduce response times." },
  "low-redundancy": { action: "Onboard additional meters or backup supply to remove single points of failure." },
  "low-uptime": { action: "Enable heartbeat retries and battery backup on meters with poor uptime." },
};

export function computeResilience(now = Date.now()): ResilienceScore {
  const { meters } = getAllMeterHealth(now);
  const n = meters.length;
  const latencies = meters.map((m) => m.avgResponseTimeMs).filter((v): v is number => v !== null);
  const avgLatency = mean(latencies);

  const metrics: ResilienceMetrics = {
    availability: n ? meters.filter((m) => m.status !== "red").length / n : 0,
    uptime: n ? mean(meters.map((m) => m.uptimePercent)) / 100 : 0,
    reliability: n ? 1 - mean(meters.map((m) => m.errorRate)) : 0,
    latency: latencies.length ? clamp01(LATENCY_TARGET_MS / Math.max(avgLatency, LATENCY_TARGET_MS)) : n ? 1 : 0,
    redundancy: clamp01(n / REDUNDANCY_TARGET),
  };
  for (const k of Object.keys(metrics) as (keyof ResilienceMetrics)[]) metrics[k] = round(clamp01(metrics[k]) * 100);

  const score = Math.round((Object.keys(WEIGHTS) as (keyof ResilienceMetrics)[]).reduce((s, k) => s + metrics[k] * WEIGHTS[k], 0));

  const vulnerabilities: Vulnerability[] = [];
  const red = meters.filter((m) => m.status === "red").map((m) => m.meterId);
  const yellow = meters.filter((m) => m.status === "yellow").map((m) => m.meterId);
  const erroring = meters.filter((m) => m.errorRate >= 0.1).map((m) => m.meterId);
  const lowUptime = meters.filter((m) => m.uptimePercent < 90).map((m) => m.meterId);
  if (red.length)
    vulnerabilities.push({ id: "offline-meters", severity: red.length / n >= 0.2 ? "critical" : "high", metric: "availability", message: `${red.length} meter(s) offline for 24h+`, meterIds: red });
  if (yellow.length)
    vulnerabilities.push({ id: "degraded-meters", severity: "medium", metric: "availability", message: `${yellow.length} meter(s) degraded`, meterIds: yellow });
  if (erroring.length)
    vulnerabilities.push({ id: "high-error-rate", severity: erroring.length / n >= 0.2 ? "high" : "medium", metric: "reliability", message: `${erroring.length} meter(s) with error rate >= 10%`, meterIds: erroring });
  if (lowUptime.length)
    vulnerabilities.push({ id: "low-uptime", severity: "medium", metric: "uptime", message: `${lowUptime.length} meter(s) below 90% uptime`, meterIds: lowUptime });
  if (latencies.length && avgLatency > LATENCY_TARGET_MS)
    vulnerabilities.push({ id: "high-latency", severity: avgLatency > 2 * LATENCY_TARGET_MS ? "high" : "low", metric: "latency", message: `Average response time ${Math.round(avgLatency)}ms exceeds ${LATENCY_TARGET_MS}ms target` });
  if (n < REDUNDANCY_TARGET)
    vulnerabilities.push({ id: "low-redundancy", severity: n <= 1 ? "critical" : "medium", metric: "redundancy", message: `Only ${n} reporting meter(s); target is ${REDUNDANCY_TARGET}` });

  const order: Severity[] = ["critical", "high", "medium", "low"];
  vulnerabilities.sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));
  const recommendations = vulnerabilities.map((v) => ({ vulnerabilityId: v.id, priority: v.severity, action: ACTIONS[v.id].action }));

  return { score, grade: grade(score), metrics, meterCount: n, vulnerabilities, recommendations, computedAt: new Date(now).toISOString() };
}

/** Compute the current score and append it to the trend history. */
export function snapshotResilience(now = Date.now()): ResilienceScore {
  const result = computeResilience(now);
  history.push({ at: result.computedAt, score: result.score, metrics: result.metrics });
  if (history.length > HISTORY_LIMIT) history.splice(0, history.length - HISTORY_LIMIT);
  return result;
}

export function getResilienceHistory(limit = HISTORY_LIMIT) {
  const points = history.slice(-Math.max(1, limit));
  const first = points[0]?.score ?? 0;
  const last = points.at(-1)?.score ?? 0;
  const change = last - first;
  return {
    points,
    trend: points.length < 2 ? "stable" : change > 2 ? "improving" : change < -2 ? "declining" : "stable",
    change,
    min: points.length ? Math.min(...points.map((p) => p.score)) : null,
    max: points.length ? Math.max(...points.map((p) => p.score)) : null,
  };
}

let timer: NodeJS.Timeout | undefined;
export function startResilienceMonitor(intervalMs = Number(process.env.RESILIENCE_INTERVAL_MS ?? 5 * 60 * 1000)): void {
  if (timer) return;
  snapshotResilience();
  timer = setInterval(() => snapshotResilience(), intervalMs);
  timer.unref?.();
}

export function _resetResilience(): void {
  history.length = 0;
  _resetIslandMode();
}
