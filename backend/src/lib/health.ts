export type DependencyStatus = 'up' | 'down' | 'degraded';

export interface DependencyCheck {
  status: DependencyStatus;
  latency_ms?: number;
  connected?: boolean;
  size_mb?: number;
  last_call?: string;
  error?: string;
}

export interface HealthResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  uptime: number;
  checks: Record<string, DependencyCheck>;
  deadLetterEvents: number;
}

/** Aggregate dependency checks using 503 for a critical failure and 207 for partial degradation. */
export function buildHealthResponse(
  checks: Record<string, DependencyCheck>,
  startedAt: number,
  deadLetterEvents: number,
  now = Date.now(),
): { body: HealthResponse; httpStatus: 200 | 207 | 503 } {
  const values = Object.values(checks);
  const hasDown = values.some((check) => check.status === 'down');
  const hasDegraded = values.some((check) => check.status === 'degraded');
  const status = hasDown ? 'unhealthy' : hasDegraded ? 'degraded' : 'healthy';

  return {
    httpStatus: hasDown ? 503 : hasDegraded ? 207 : 200,
    body: {
      status,
      timestamp: new Date(now).toISOString(),
      uptime: Math.max(0, Math.floor((now - startedAt) / 1000)),
      checks,
      deadLetterEvents,
    },
  };
}

export type IncidentStatus = 'investigating' | 'identified' | 'monitoring' | 'resolved';
export type IncidentImpact = 'none' | 'minor' | 'major' | 'critical';

export interface IncidentUpdate {
  status: IncidentStatus;
  message: string;
  timestamp: string;
}

export interface Incident {
  id: string;
  title: string;
  impact: IncidentImpact;
  status: IncidentStatus;
  createdAt: string;
  updatedAt: string;
  updates: IncidentUpdate[];
}

/** Overall platform status shown on the public status page. */
export type PlatformStatus = 'operational' | 'degraded' | 'partial_outage' | 'major_outage';

export interface UptimeWindow {
  /** ISO date (YYYY-MM-DD) the window covers. */
  date: string;
  /** Uptime percentage for the window, 0-100. */
  uptimePct: number;
  /** Total observed seconds in the window. */
  totalSeconds: number;
  /** Seconds the platform was considered down. */
  downSeconds: number;
}

export interface StatusPageSnapshot {
  status: PlatformStatus;
  timestamp: string;
  uptime: number;
  checks: Record<string, DependencyCheck>;
  incidents: Incident[];
  /** Rolling historical uptime windows, most recent last. */
  history: UptimeWindow[];
  /** Target uptime percentage the platform is tracked against. */
  uptimeTargetPct: number;
  /** Whether the rolling uptime meets the target. */
  meetsUptimeTarget: boolean;
}

/** Uptime target tracked on the public status page. */
export const UPTIME_TARGET_PCT = 99.9;

/** Map aggregated health status to the public-facing platform status. */
export function toPlatformStatus(status: HealthResponse['status']): PlatformStatus {
  switch (status) {
    case 'healthy':
      return 'operational';
    case 'degraded':
      return 'degraded';
    case 'unhealthy':
      return 'major_outage';
    default:
      return 'operational';
  }
}

/** Compute the uptime percentage across a set of historical windows. */
export function computeUptimePct(history: UptimeWindow[]): number {
  const totalSeconds = history.reduce((sum, window) => sum + window.totalSeconds, 0);
  if (totalSeconds <= 0) return 100;
  const downSeconds = history.reduce((sum, window) => sum + window.downSeconds, 0);
  const pct = ((totalSeconds - downSeconds) / totalSeconds) * 100;
  return Math.max(0, Math.min(100, Number(pct.toFixed(3))));
}

/**
 * Build the public status page snapshot from live health checks, incidents and
 * historical uptime windows. This is intentionally auth-free so the status page
 * can be served publicly.
 */
export function buildStatusPageSnapshot(
  health: HealthResponse,
  incidents: Incident[],
  history: UptimeWindow[],
  now = Date.now(),
): StatusPageSnapshot {
  const uptimePct = computeUptimePct(history);
  return {
    status: toPlatformStatus(health.status),
    timestamp: new Date(now).toISOString(),
    uptime: health.uptime,
    checks: health.checks,
    incidents: incidents.filter((incident) => incident.status !== 'resolved'),
    history,
    uptimeTargetPct: UPTIME_TARGET_PCT,
    meetsUptimeTarget: uptimePct >= UPTIME_TARGET_PCT,
  };
}
