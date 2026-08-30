import { describe, expect, it } from 'vitest';
import { buildHealthResponse } from './health.js';

describe('buildHealthResponse', () => {
  const checks = {
    stellar_rpc: { status: 'up' as const, latency_ms: 12 },
    mqtt_broker: { status: 'up' as const, connected: true },
    database: { status: 'up' as const, size_mb: 1.5 },
  };

  it('returns 200 for healthy dependencies', () => {
    const result = buildHealthResponse(checks, 10_000, 0, 25_000);
    expect(result.httpStatus).toBe(200);
    expect(result.body.status).toBe('healthy');
    expect(result.body.uptime).toBe(15);
  });

  it('returns 207 when a dependency is degraded', () => {
    const result = buildHealthResponse(
      { ...checks, mqtt_broker: { status: 'degraded', connected: false } },
      0,
      2,
      61_000,
    );
    expect(result.httpStatus).toBe(207);
    expect(result.body.status).toBe('degraded');
    expect(result.body.deadLetterEvents).toBe(2);
  });

  it('returns 503 when a dependency is down', () => {
    const result = buildHealthResponse(
      { ...checks, stellar_rpc: { status: 'down', error: 'timeout' } },
      0,
      0,
      1_000,
    );
    expect(result.httpStatus).toBe(503);
    expect(result.body.status).toBe('unhealthy');
  });
});
