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
import { logger } from "./logger.js";

export type HealthStatus = "green" | "yellow" | "red";

export type HeartbeatInput = {
  responseTimeMs?: number;
  error?: boolean;
  receivedAt?: number;
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
  state.alerted = false;
  return state;
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
  });
}

export function classify(state: MeterHealthState, now = Date.now()): HealthStatus {
  const age = now - state.lastHeartbeat;
  if (age >= RED_AFTER_MS) return "red";
  const errorRate = state.heartbeatCount ? state.errorCount / state.heartbeatCount : 0;
  if (age >= YELLOW_AFTER_MS || errorRate >= ERROR_RATE_WARN) return "yellow";
  return "green";
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
  return { summary, meters: all };
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
