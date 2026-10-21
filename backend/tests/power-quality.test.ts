I'll analyze the existing test structure and the power quality module to create comprehensive tests.

Looking at the requirements, I need to create tests for a power quality monitoring module. Since I don't have the actual source file content, I'll create tests based on the expected API surface described in the step, following the structure of `meter-health.test.ts`.

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the notification services before importing the module under test
vi.mock('../src/services/notifications', () => ({
  sendPushToOwner: vi.fn().mockResolvedValue(undefined),
  sendNotificationEmail: vi.fn().mockResolvedValue(undefined),
}));

import {
  recordPowerQualitySample,
  getPowerQualityHistory,
  analyzePowerQuality,
  getPowerQualitySummary,
  _resetPowerQuality,
} from '../src/services/powerQuality';

import {
  sendPushToOwner,
  sendNotificationEmail,
} from '../src/services/notifications';

const mockSendPushToOwner = vi.mocked(sendPushToOwner);
const mockSendNotificationEmail = vi.mocked(sendNotificationEmail);

describe('power quality monitoring', () => {
  const METER_ID = 'meter-pq-001';

  beforeEach(() => {
    _resetPowerQuality();
    vi.clearAllMocks();
    delete process.env.POWER_QUALITY_VOLTAGE_MIN;
    delete process.env.POWER_QUALITY_VOLTAGE_MAX;
    delete process.env.POWER_QUALITY_FREQUENCY_MIN;
    delete process.env.POWER_QUALITY_FREQUENCY_MAX;
    delete process.env.POWER_QUALITY_THD_MAX;
    delete process.env.POWER_QUALITY_ALERT_DEBOUNCE_MS;
  });

  describe('recordPowerQualitySample / getPowerQualityHistory', () => {
    it('persists a sample and returns it from history', () => {
      const sample = recordPowerQualitySample(METER_ID, {
        voltage: 230,
        frequency: 50,
        thd: 2.5,
      });

      expect(sample).toBeDefined();
      expect(sample.meterId).toBe(METER_ID);
      expect(sample.voltage).toBe(230);
      expect(sample.frequency).toBe(50);
      expect(sample.thd).toBe(2.5);
      expect(sample.timestamp).toBeDefined();

      const history = getPowerQualityHistory(METER_ID);
      expect(history).toHaveLength(1);
      expect(history[0].voltage).toBe(230);
    });

    it('returns history in time order', () => {
      const first = recordPowerQualitySample(METER_ID, {
        voltage: 230,
        frequency: 50,
        thd: 2.0,
      });
      const second = recordPowerQualitySample(METER_ID, {
        voltage: 231,
        frequency: 50,
        thd: 2.1,
      });
      const third = recordPowerQualitySample(METER_ID, {
        voltage: 229,
        frequency: 50,
        thd: 2.2,
      });

      const history = getPowerQualityHistory(METER_ID);
      expect(history).toHaveLength(3);
      expect(history[0].timestamp).toBe(first.timestamp);
      expect(history[1].timestamp).toBe(second.timestamp);
      expect(history[2].timestamp).toBe(third.timestamp);

      // Ensure timestamps are non-decreasing
      for (let i = 1; i < history.length; i++) {
        expect(
          new Date(history[i].timestamp).getTime(),
        ).toBeGreaterThanOrEqual(new Date(history[i - 1].timestamp).getTime());
      }
    });

    it('keeps history isolated per meter', () => {
      recordPowerQualitySample(METER_ID, {
        voltage: 230,
        frequency: 50,
        thd: 2.0,
      });
      recordPowerQualitySample('other-meter', {
        voltage: 240,
        frequency: 60,
        thd: 3.0,
      });

      expect(getPowerQualityHistory(METER_ID)).toHaveLength(1);
      expect(getPowerQualityHistory('other-meter')).toHaveLength(1);
      expect(getPowerQualityHistory('unknown-meter')).toHaveLength(0);
    });
  });

  describe('analyzePowerQuality', () => {
    it('classifies a low-voltage sample as a sag', () => {
      const result = analyzePowerQuality({
        voltage: 180,
        frequency: 50,
        thd: 2.0,
      });

      expect(result.issues).toBeDefined();
      expect(result.issues.length).toBeGreaterThan(0);
      const sag = result.issues.find((i: any) => i.type === 'sag');
      expect(sag).toBeDefined();
      expect(sag.severity).toBeDefined();
    });

    it('classifies a high-voltage sample as a swell', () => {
      const result = analyzePowerQuality({
        voltage: 280,
        frequency: 50,
        thd: 2.0,
      });

      expect(result.issues.length).toBeGreaterThan(0);
      const swell = result.issues.find((i: any) => i.type === 'swell');
      expect(swell).toBeDefined();
      expect(swell.severity).toBeDefined();
    });

    it('classifies a high-THD sample as a harmonic issue', () => {
      const result = analyzePowerQuality({
        voltage: 230,
        frequency: 50,
        thd: 12.0,
      });

      expect(result.issues.length).toBeGreaterThan(0);
      const harmonic = result.issues.find((i: any) => i.type === 'harmonic');
      expect(harmonic).toBeDefined();
      expect(harmonic.severity).toBeDefined();
    });

    it('classifies an out-of-range frequency as a frequency issue', () => {
      const result = analyzePowerQuality({
        voltage: 230,
        frequency: 45,
        thd: 2.0,
      });

      expect(result.issues.length).toBeGreaterThan(0);
      const freq = result.issues.find((i: any) => i.type === 'frequency');
      expect(freq).toBeDefined();
    });

    it('returns no issues for in-range values', () => {
      const result = analyzePowerQuality({
        voltage: 230,
        frequency: 50,
        thd: 2.0,
      });

      expect(result.issues).toEqual([]);
      expect(result.healthy).toBe(true);
    });
  });

  describe('threshold env overrides', () => {
    it('respects POWER_QUALITY_VOLTAGE_MIN override', () => {
      process.env.POWER_QUALITY_VOLTAGE_MIN = '200';

      // 195 would be a sag under default thresholds but not under override
      const result = analyzePowerQuality({
        voltage: 195,
        frequency: 50,
        thd: 2.0,
      });

      const sag = result.issues.find((i: any) => i.type === 'sag');
      expect(sag).toBeUndefined();
    });

    it('respects POWER_QUALITY_VOLTAGE_MAX override', () => {
      process.env.POWER_QUALITY_VOLTAGE_MAX = '300';

      const result = analyzePowerQuality({
        voltage: 280,
        frequency: 50,
        thd: 2.0,
      });

      const swell = result.issues.find((i: any) => i.type === 'swell');
      expect(swell).toBeUndefined();
    });

    it('respects POWER_QUALITY_THD_MAX override', () => {
      process.env.POWER_QUALITY_THD_MAX = '15';

      const result = analyzePowerQuality({
        voltage: 230,
        frequency: 50,
        thd: 12.0,
      });

      const harmonic = result.issues.find((i: any) => i.type === 'harmonic');
      expect(harmonic).toBeUndefined();
    });

    it('respects POWER_QUALITY_FREQUENCY_MIN/MAX overrides', () => {
      process.env.POWER_QUALITY_FREQUENCY_MIN = '40';
      process.env.POWER_QUALITY_FREQUENCY_MAX = '70';

      const result = analyzePowerQuality({
        voltage: 230,
        frequency: 45,
        thd: 2.0,
      });

      const freq = result.issues.find((i: any) => i.type === 'frequency');
      expect(freq).toBeUndefined();
    });
  });

  describe('alerting', () => {
    it('triggers alerts when quality drops below thresholds', async () => {
      recordPowerQualitySample(METER_ID, {
        voltage: 180,
        frequency: 50,
        thd: 2.0,
      });

      // Allow any async alert dispatch to flush
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));

      const pushCalled = mockSendPushToOwner.mock.calls.length > 0;
      const emailCalled = mockSendNotificationEmail.mock.calls.length > 0;
      expect(pushCalled || emailCalled).toBe(true);
    });

    it('debounces repeated bad samples', async () => {
      process.env.POWER_QUALITY_ALERT_DEBOUNCE_MS = '60000';

      recordPowerQualitySample(METER_ID, {
        voltage: 180,
        frequency: 50,
        thd: 2.0,
      });
      await new Promise((r) => setTimeout(r, 0));
      const callsAfterFirst =
        mockSendPushToOwner.mock.calls.length +
        mockSendNotificationEmail.mock.calls.length;

      recordPowerQualitySample(METER_ID, {
        voltage: 181,
        frequency: 50,
        thd: 2.0,
      });
      await new Promise((r) => setTimeout(r, 0));
      const callsAfterSecond =
        mockSendPushToOwner.mock.calls.length +
        mockSendNotificationEmail.mock.calls.length;

      // Second bad sample within debounce window should not add new alerts
      expect(callsAfterSecond).toBe(callsAfterFirst);
    });

    it('does not alert for healthy samples', async () => {
      recordPowerQualitySample(METER_ID, {
        voltage: 230,
        frequency: 50,
        thd: 2.0,
      });

      await new Promise((r) => setTimeout(r, 0));

      expect(mockSendPushToOwner).not.toHaveBeenCalled();
      expect(mockSendNotificationEmail).not.toHaveBeenCalled();
    });
  });

  describe('getPowerQualitySummary', () => {
    it('returns current, issues, and history', () => {
      recordPowerQualitySample(METER_ID, {
        voltage: 230,
        frequency: 50,
        thd: 2.0,
      });
      recordPowerQualitySample(METER_ID, {
        voltage: 180,
        frequency: 50,
        thd: 2.0,
      });

      const summary = getPowerQualitySummary(METER_ID);

      expect(summary).toBeDefined();
      expect(summary.current).toBeDefined();
      expect(summary.current.voltage).toBe(180);
      expect(Array.isArray(summary.issues)).toBe(true);
      expect(summary.issues.length).toBeGreaterThan(0);
      expect(Array.isArray(summary.history)).toBe(true);
      expect(summary.history).toHaveLength(2);
    });

    it('returns an empty summary for an unknown meter', () => {
      const summary = getPowerQualitySummary('unknown-meter');

      expect(summary).toBeDefined();
      expect(summary.current).toBeNull();
      expect(summary.issues).toEqual([]);
      expect(summary.history).toEqual([]);
    });
  });

  describe('_resetPowerQuality', () => {
    it('clears state between tests', () => {
      recordPowerQualitySample(METER_ID, {
        voltage: 230,
        frequency: 50,
        thd: 2.0,
      });
      expect(getPowerQualityHistory(METER_ID)).toHaveLength(1);

      _resetPowerQuality();

      expect(getPowerQualityHistory(METER_ID)).toHaveLength(0);
      const summary = getPowerQualitySummary(METER_ID);
      expect(summary.current).toBeNull();
      expect(summary.issues).toEqual([]);
      expect(summary.history).toEqual([]);
    });
  });
});