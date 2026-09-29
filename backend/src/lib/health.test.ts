import { describe, expect, it } from 'vitest';
import { buildHealthResponse, buildStatusPage } from './health.js';

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

describe('buildStatusPage', () => {
  const checks = {
    stellar_rpc: { status: 'up' as const, latency_ms: 12 },
    mqtt_broker: { status: 'up' as const, connected: true },
    database: { status: 'up' as const, size_mb: 1.5 },
  };

  it('renders a public status page with current system status', () => {
    const page = buildStatusPage(checks, 10_000, 0, 25_000);
    expect(page.status).toBe('operational');
    expect(page.components).toHaveLength(3);
    expect(page.components.every((c) => c.status === 'operational')).toBe(true);
  });

  it('reflects degraded and down dependencies', () => {
    const page = buildStatusPage(
      {
        ...checks,
        mqtt_broker: { status: 'degraded', connected: false },
        stellar_rpc: { status: 'down', error: 'timeout' },
      },
      0,
      0,
      1_000,
    );
    expect(page.status).toBe('major_outage');
    expect(page.components.find((c) => c.name === 'mqtt_broker')?.status).toBe(
      'degraded',
    );
    expect(page.components.find((c) => c.name === 'stellar_rpc')?.status).toBe(
      'down',
    );
  });

  it('tracks the 99.9% uptime target against historical data', () => {
    const page = buildStatusPage(checks, 10_000, 0, 25_000, {
      uptimePercent: 99.95,
      history: [
        { date: '2024-01-01', uptimePercent: 100 },
        { date: '2024-01-02', uptimePercent: 99.9 },
      ],
    });
    expect(page.uptimeTarget).toBe(99.9);
    expect(page.uptimePercent).toBe(99.95);
    expect(page.meetsUptimeTarget).toBe(true);
    expect(page.history).toHaveLength(2);
  });

  it('flags when uptime falls below the target', () => {
    const page = buildStatusPage(checks, 10_000, 0, 25_000, {
      uptimePercent: 98.5,
      history: [],
    });
    expect(page.meetsUptimeTarget).toBe(false);
  });

  it('lists active incidents for incident management', () => {
    const page = buildStatusPage(checks, 10_000, 0, 25_000, {
      uptimePercent: 100,
      history: [],
      incidents: [
        {
          id: 'inc-1',
          title: 'RPC latency',
          status: 'investigating',
          impact: 'minor',
          createdAt: '2024-01-02T00:00:00.000Z',
        },
      ],
    });
    expect(page.incidents).toHaveLength(1);
    expect(page.incidents[0].status).toBe('investigating');
  });
});
