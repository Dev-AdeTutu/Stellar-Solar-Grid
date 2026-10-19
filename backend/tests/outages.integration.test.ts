import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OutageService } from '../src/services/outageService.js';

vi.mock('../src/lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../src/lib/emergencyContacts.js', () => ({
  notifyEmergencyContacts: vi.fn().mockResolvedValue({
    eventType: 'outage',
    userAddress: 'GA...',
    meterId: 'MTR-1',
    notified: [{ contactId: 1, channel: 'email', delivered: true }],
  }),
}));

describe('Grid Outage Detection & Management (#976)', () => {
  let service: OutageService;

  beforeEach(() => {
    service = new OutageService();
  });

  it('creates an outage record with estimated restoration', () => {
    const outage = service.createOutage({
      region: 'zone-east',
      affectedMeters: ['MTR-A', 'MTR-B'],
      affectedUsers: ['G_USER_A'],
      cause: 'Storm damage to transmission lines',
      severity: 'major',
    });

    expect(outage.id).toMatch(/^outage-/);
    expect(outage.status).toBe('active');
    expect(outage.region).toBe('zone-east');
    expect(outage.affectedMeters).toEqual(['MTR-A', 'MTR-B']);
    expect(outage.estimatedRestorationAt).toBeDefined();

    const active = service.getActiveOutages();
    expect(active.some((o) => o.id === outage.id)).toBe(true);
  });

  it('detects outage when multiple IoT meters report zero power', () => {
    // Reading 1: normal
    service.recordReading({
      meterId: 'MTR-OK',
      voltage: 230,
      frequency: 50,
      region: 'sector-1',
    });
    expect(service.evaluateGridReadings()).toHaveLength(0);

    // Reading 2: meter failed in sector 1
    service.recordReading({
      meterId: 'MTR-FAIL-1',
      voltage: 0,
      frequency: 0,
      region: 'sector-1',
    });
    // Single failure does not trigger regional outage
    expect(service.evaluateGridReadings()).toHaveLength(0);

    // Reading 3: second meter failed in sector 1
    service.recordReading({
      meterId: 'MTR-FAIL-2',
      voltage: 24, // < 50V
      frequency: 0,
      region: 'sector-1',
    });

    // Multiple failures in same region triggers outage
    const detected = service.evaluateGridReadings();
    expect(detected).toHaveLength(1);
    expect(detected[0].region).toBe('sector-1');
    expect(detected[0].affectedMeters).toContain('MTR-FAIL-1');
    expect(detected[0].affectedMeters).toContain('MTR-FAIL-2');
  });

  it('resolves active outage', () => {
    const outage = service.createOutage({
      region: 'zone-west',
      affectedMeters: ['MTR-W'],
    });

    expect(service.getActiveOutages()).toHaveLength(1);

    const resolved = service.resolveOutage(outage.id);
    expect(resolved?.status).toBe('resolved');
    expect(resolved?.resolvedAt).toBeDefined();
    expect(service.getActiveOutages()).toHaveLength(0);
  });
});
