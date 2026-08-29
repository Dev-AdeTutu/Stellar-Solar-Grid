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
