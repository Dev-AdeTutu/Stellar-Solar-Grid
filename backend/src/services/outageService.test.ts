import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OutageService } from './outageService.js';

vi.mock('../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../lib/emergencyContacts.js', () => ({
  notifyEmergencyContacts: vi.fn().mockResolvedValue({
    eventType: 'outage',
    userAddress: 'GA...',
    meterId: 'MTR-1',
    notified: [{ contactId: 1, channel: 'email', delivered: true }],
  }),
}));

describe('OutageService', () => {
  let service: OutageService;

  beforeEach(() => {
    service = new OutageService();
  });

  it('creates an outage record and retrieves active outages', () => {
    const outage = service.createOutage({
      region: 'district-north',
      affectedMeters: ['MTR-1', 'MTR-2'],
      affectedUsers: ['GUSER1', 'GUSER2'],
      cause: 'Substation transformer failure',
      severity: 'major',
    });

    expect(outage.id).toBeDefined();
    expect(outage.status).toBe('active');
    expect(outage.region).toBe('district-north');
    expect(outage.affectedMeters).toHaveLength(2);

    const active = service.getActiveOutages();
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(outage.id);
  });

  it('detects outage when multiple meters report zero or collapsed power (< 50V / 0Hz)', () => {
    // Meter 1 reports no voltage
    service.recordReading({
      meterId: 'MTR-10',
      voltage: 0,
      frequency: 0,
      region: 'grid-sector-4',
      userAddress: 'GA_USER10',
    });

    // Single meter failure doesn't immediately flag a regional outage
    let detected = service.evaluateGridReadings();
    expect(detected).toHaveLength(0);

    // Meter 2 in same sector reports collapsed power
    service.recordReading({
      meterId: 'MTR-11',
      voltage: 12, // < 50V
      frequency: 0,
      region: 'grid-sector-4',
      userAddress: 'GA_USER11',
    });

    // Multiple meters collapsed -> Outage detected
    detected = service.evaluateGridReadings();
    expect(detected).toHaveLength(1);
    expect(detected[0].region).toBe('grid-sector-4');
    expect(detected[0].affectedMeters).toContain('MTR-10');
    expect(detected[0].affectedMeters).toContain('MTR-11');
    expect(detected[0].status).toBe('active');
  });

  it('does not trigger outage when voltages are nominal', () => {
    service.recordReading({
      meterId: 'MTR-20',
      voltage: 230,
      frequency: 50,
      region: 'grid-sector-5',
    });
    service.recordReading({
      meterId: 'MTR-21',
      voltage: 228,
      frequency: 50,
      region: 'grid-sector-5',
    });

    const detected = service.evaluateGridReadings();
    expect(detected).toHaveLength(0);
    expect(service.getActiveOutages()).toHaveLength(0);
  });

  it('resolves active outage', () => {
    const outage = service.createOutage({
      region: 'district-south',
      affectedMeters: ['MTR-5'],
    });

    expect(service.getActiveOutages()).toHaveLength(1);

    const resolved = service.resolveOutage(outage.id);
    expect(resolved).toBeDefined();
    expect(resolved?.status).toBe('resolved');
    expect(resolved?.resolvedAt).toBeDefined();

    expect(service.getActiveOutages()).toHaveLength(0);
  });
});
