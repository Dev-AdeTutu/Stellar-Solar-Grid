import request from 'supertest';
import express from 'express';
import { BatteryService } from '../src/services/batteryService';
import { handleBatteryTelemetry } from '../src/iot/batteryTelemetry';
import { createBatteryRouter } from '../src/routes/batteryRoutes';

// ---------------------------------------------------------------------------
// In-memory fake persistence layer used by the tests.
// ---------------------------------------------------------------------------

interface StoredReading {
  meterId: string;
  voltage: number;
  current: number;
  soc: number;
  temperature?: number;
  timestamp: Date;
}

interface StoredBattery {
  meterId: string;
  capacityAh: number;
  health: number;
  cycles: number;
  soc: number;
  voltage: number;
  current: number;
  lastUpdated: Date;
  replacementDate: Date | null;
}

class FakeBatteryRepository {
  public readings: StoredReading[] = [];
  public batteries = new Map<string, StoredBattery>();
  public alerts: Array<{ meterId: string; type: string; message: string }> = [];

  async saveReading(reading: StoredReading): Promise<void> {
    this.readings.push(reading);
  }

  async getReadings(meterId: string): Promise<StoredReading[]> {
    return this.readings.filter((r) => r.meterId === meterId);
  }

  async getBattery(meterId: string): Promise<StoredBattery | undefined> {
    return this.batteries.get(meterId);
  }

  async upsertBattery(battery: StoredBattery): Promise<void> {
    this.batteries.set(battery.meterId, battery);
  }

  async saveAlert(alert: { meterId: string; type: string; message: string }): Promise<void> {
    this.alerts.push(alert);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const METER_ID = 'meter-battery-001';

function buildApp(service: BatteryService) {
  const app = express();
  app.use(express.json());
  app.use('/api/meters', createBatteryRouter(service));
  return app;
}

function makeService(repo: FakeBatteryRepository) {
  return new BatteryService(repo as any);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Battery integration', () => {
  let repo: FakeBatteryRepository;
  let service: BatteryService;

  beforeEach(() => {
    repo = new FakeBatteryRepository();
    service = makeService(repo);
  });

  describe('recording battery readings', () => {
    it('records a reading and computes health and cycle count', async () => {
      await service.recordReading({
        meterId: METER_ID,
        voltage: 12.6,
        current: 2.5,
        soc: 100,
        temperature: 25,
        timestamp: new Date('2024-01-01T00:00:00Z'),
      });

      const battery = await service.getBatteryStats(METER_ID);

      expect(battery).toBeDefined();
      expect(battery!.meterId).toBe(METER_ID);
      expect(battery!.soc).toBeCloseTo(100, 1);
      expect(battery!.health).toBeGreaterThan(0);
      expect(battery!.health).toBeLessThanOrEqual(100);
      expect(battery!.cycles).toBeGreaterThanOrEqual(0);
      expect(repo.readings).toHaveLength(1);
    });

    it('accumulates cycle count across multiple charge/discharge readings', async () => {
      // Simulate a full charge -> discharge -> charge cycle.
      const sequence: Array<{ soc: number; current: number }> = [
        { soc: 100, current: 0 },
        { soc: 50, current: -5 },
        { soc: 0, current: -5 },
        { soc: 50, current: 5 },
        { soc: 100, current: 5 },
      ];

      for (let i = 0; i < sequence.length; i++) {
        await service.recordReading({
          meterId: METER_ID,
          voltage: 12.0,
          current: sequence[i].current,
          soc: sequence[i].soc,
          temperature: 25,
          timestamp: new Date(Date.UTC(2024, 0, 1, i)),
        });
      }

      const battery = await service.getBatteryStats(METER_ID);
      expect(battery!.cycles).toBeGreaterThanOrEqual(1);
    });

    it('degrades health as cycle count increases', async () => {
      // Seed a large number of cycles via many readings.
      for (let i = 0; i < 50; i++) {
        await service.recordReading({
          meterId: METER_ID,
          voltage: 12.0,
          current: i % 2 === 0 ? -5 : 5,
          soc: i % 2 === 0 ? 20 : 90,
          temperature: 25,
          timestamp: new Date(Date.UTC(2024, 0, 1, 0, i)),
        });
      }

      const battery = await service.getBatteryStats(METER_ID);
      expect(battery!.health).toBeLessThan(100);
    });
  });

  describe('predicted replacement date', () => {
    it('projects a replacement date in the future', async () => {
      await service.recordReading({
        meterId: METER_ID,
        voltage: 12.6,
        current: 1,
        soc: 80,
        temperature: 25,
        timestamp: new Date('2024-01-01T00:00:00Z'),
      });

      const battery = await service.getBatteryStats(METER_ID);
      expect(battery!.replacementDate).not.toBeNull();
      expect(battery!.replacementDate!.getTime()).toBeGreaterThan(Date.now());
    });

    it('projects an earlier replacement date for a degraded battery', async () => {
      // Healthy battery baseline.
      await service.recordReading({
        meterId: 'healthy-meter',
        voltage: 12.6,
        current: 1,
        soc: 90,
        temperature: 25,
        timestamp: new Date('2024-01-01T00:00:00Z'),
      });
      const healthy = await service.getBatteryStats('healthy-meter');

      // Degraded battery: many cycles.
      for (let i = 0; i < 200; i++) {
        await service.recordReading({
          meterId: 'degraded-meter',
          voltage: 11.5,
          current: i % 2 === 0 ? -6 : 6,
          soc: i % 2 === 0 ? 10 : 95,
          temperature: 40,
          timestamp: new Date(Date.UTC(2024, 0, 1, 0, i)),
        });
      }
      const degraded = await service.getBatteryStats('degraded-meter');

      expect(degraded!.replacementDate!.getTime()).toBeLessThanOrEqual(
        healthy!.replacementDate!.getTime(),
      );
    });
  });

  describe('health alert', () => {
    it('fires a below-80% health alert exactly once', async () => {
      // Drive health below 80% with a large number of cycles.
      for (let i = 0; i < 500; i++) {
        await service.recordReading({
          meterId: METER_ID,
          voltage: 11.0,
          current: i % 2 === 0 ? -8 : 8,
          soc: i % 2 === 0 ? 5 : 98,
          temperature: 45,
          timestamp: new Date(Date.UTC(2024, 0, 1, 0, i)),
        });
      }

      const battery = await service.getBatteryStats(METER_ID);
      expect(battery!.health).toBeLessThan(80);

      const healthAlerts = repo.alerts.filter(
        (a) => a.meterId === METER_ID && a.type === 'battery_health_low',
      );
      expect(healthAlerts).toHaveLength(1);
    });

    it('does not fire an alert while health stays at or above 80%', async () => {
      await service.recordReading({
        meterId: METER_ID,
        voltage: 12.6,
        current: 1,
        soc: 100,
        temperature: 25,
        timestamp: new Date('2024-01-01T00:00:00Z'),
      });

      const healthAlerts = repo.alerts.filter(
        (a) => a.meterId === METER_ID && a.type === 'battery_health_low',
      );
      expect(healthAlerts).toHaveLength(0);
    });
  });

  describe('handleBatteryTelemetry', () => {
    it('parses a valid MQTT payload and records the reading', async () => {
      const payload = JSON.stringify({
        meterId: METER_ID,
        voltage: 12.4,
        current: 3.1,
        soc: 76,
        temperature: 28,
        timestamp: '2024-02-01T12:00:00Z',
      });

      const result = await handleBatteryTelemetry(payload, service);

      expect(result.ok).toBe(true);
      expect(repo.readings).toHaveLength(1);
      expect(repo.readings[0].meterId).toBe(METER_ID);
      expect(repo.readings[0].soc).toBeCloseTo(76, 1);
    });

    it('rejects malformed JSON payloads', async () => {
      const result = await handleBatteryTelemetry('{not valid json', service);

      expect(result.ok).toBe(false);
      expect(result.error).toBeDefined();
      expect(repo.readings).toHaveLength(0);
    });

    it('rejects payloads missing required fields', async () => {
      const payload = JSON.stringify({ meterId: METER_ID, voltage: 12.4 });

      const result = await handleBatteryTelemetry(payload, service);

      expect(result.ok).toBe(false);
      expect(result.error).toBeDefined();
      expect(repo.readings).toHaveLength(0);
    });

    it('rejects payloads with out-of-range SOC values', async () => {
      const payload = JSON.stringify({
        meterId: METER_ID,
        voltage: 12.4,
        current: 1,
        soc: 150,
        timestamp: '2024-02-01T12:00:00Z',
      });

      const result = await handleBatteryTelemetry(payload, service);

      expect(result.ok).toBe(false);
      expect(repo.readings).toHaveLength(0);
    });
  });

  describe('GET /api/meters/:meterId/battery', () => {
    it('returns battery stats for a known meter', async () => {
      await service.recordReading({
        meterId: METER_ID,
        voltage: 12.6,
        current: 2,
        soc: 88,
        temperature: 26,
        timestamp: new Date('2024-03-01T00:00:00Z'),
      });

      const app = buildApp(service);
      const res = await request(app).get(`/api/meters/${METER_ID}/battery`);

      expect(res.status).toBe(200);
      expect(res.body.meterId).toBe(METER_ID);
      expect(res.body.soc).toBeCloseTo(88, 1);
      expect(res.body.health).toBeGreaterThan(0);
      expect(res.body.cycles).toBeGreaterThanOrEqual(0);
      expect(res.body.replacementDate).toBeDefined();
    });

    it('returns 404 for an unknown meter', async () => {
      const app = buildApp(service);
      const res = await request(app).get('/api/meters/does-not-exist/battery');

      expect(res.status).toBe(404);
    });
  });
});