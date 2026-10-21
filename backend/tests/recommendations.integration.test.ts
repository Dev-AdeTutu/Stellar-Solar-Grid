import request from 'supertest';
import { app } from '../src/app';
import { db } from '../src/db';
import { seedMeter, seedReadings, clearDatabase } from './helpers/seed';

describe('Recommendations integration', () => {
  let meterId: string;

  beforeEach(async () => {
    await clearDatabase(db);
    meterId = await seedMeter(db, { name: 'Home Meter', unit: 'kWh' });
  });

  afterAll(async () => {
    await clearDatabase(db);
    await db.destroy();
  });

  describe('GET /api/meters/:meterId/recommendations', () => {
    it('returns an array of recommendations with the expected response shape', async () => {
      await seedReadings(db, meterId, [
        { timestamp: '2024-01-01T00:00:00.000Z', value: 1.2 },
        { timestamp: '2024-01-01T01:00:00.000Z', value: 1.1 },
        { timestamp: '2024-01-01T02:00:00.000Z', value: 1.0 },
        { timestamp: '2024-01-01T18:00:00.000Z', value: 4.5 },
        { timestamp: '2024-01-01T19:00:00.000Z', value: 4.8 },
        { timestamp: '2024-01-01T20:00:00.000Z', value: 4.6 },
      ]);

      const res = await request(app).get(`/api/meters/${meterId}/recommendations`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('meterId', meterId);
      expect(Array.isArray(res.body.recommendations)).toBe(true);
      expect(res.body.recommendations.length).toBeGreaterThan(0);

      const rec = res.body.recommendations[0];
      expect(rec).toEqual(
        expect.objectContaining({
          id: expect.any(String),
          type: expect.any(String),
          title: expect.any(String),
          description: expect.any(String),
          priority: expect.any(String),
          potentialSavings: expect.any(Number),
          currency: expect.any(String),
          adopted: expect.any(Boolean),
        })
      );
      expect(['high', 'medium', 'low']).toContain(rec.priority);
      expect(rec.potentialSavings).toBeGreaterThanOrEqual(0);
    });

    it('returns 404 for an unknown meter', async () => {
      const res = await request(app).get(
        '/api/meters/00000000-0000-0000-0000-000000000000/recommendations'
      );

      expect(res.status).toBe(404);
    });

    it('returns an empty recommendation list when there is insufficient data', async () => {
      await seedReadings(db, meterId, [
        { timestamp: '2024-01-01T00:00:00.000Z', value: 1.0 },
      ]);

      const res = await request(app).get(`/api/meters/${meterId}/recommendations`);

      expect(res.status).toBe(200);
      expect(res.body.recommendations).toEqual([]);
    });
  });

  describe('pattern analysis', () => {
    it('generates a peak-shifting recommendation from peak usage patterns', async () => {
      const readings = [];
      for (let hour = 0; hour < 24; hour++) {
        const isPeak = hour >= 18 && hour <= 21;
        readings.push({
          timestamp: `2024-01-01T${String(hour).padStart(2, '0')}:00:00.000Z`,
          value: isPeak ? 5.0 : 1.0,
        });
      }
      await seedReadings(db, meterId, readings);

      const res = await request(app).get(`/api/meters/${meterId}/recommendations`);

      expect(res.status).toBe(200);
      const peakRec = res.body.recommendations.find(
        (r: { type: string }) => r.type === 'shift_load'
      );
      expect(peakRec).toBeDefined();
      expect(peakRec.title).toMatch(/peak/i);
      expect(peakRec.potentialSavings).toBeGreaterThan(0);
    });

    it('generates an anomaly recommendation when usage spikes are detected', async () => {
      const readings = [];
      for (let day = 1; day <= 10; day++) {
        readings.push({
          timestamp: `2024-01-${String(day).padStart(2, '0')}T12:00:00.000Z`,
          value: 2.0,
        });
      }
      readings.push({ timestamp: '2024-01-11T12:00:00.000Z', value: 40.0 });
      await seedReadings(db, meterId, readings);

      const res = await request(app).get(`/api/meters/${meterId}/recommendations`);

      expect(res.status).toBe(200);
      const anomalyRec = res.body.recommendations.find(
        (r: { type: string }) => r.type === 'anomaly'
      );
      expect(anomalyRec).toBeDefined();
      expect(anomalyRec.priority).toBe('high');
    });

    it('generates an efficiency recommendation when usage trends upward', async () => {
      const readings = [];
      for (let day = 1; day <= 14; day++) {
        readings.push({
          timestamp: `2024-01-${String(day).padStart(2, '0')}T12:00:00.000Z`,
          value: 1.0 + day * 0.5,
        });
      }
      await seedReadings(db, meterId, readings);

      const res = await request(app).get(`/api/meters/${meterId}/recommendations`);

      expect(res.status).toBe(200);
      const trendRec = res.body.recommendations.find(
        (r: { type: string }) => r.type === 'upgrade_appliance'
      );
      expect(trendRec).toBeDefined();
      expect(trendRec.potentialSavings).toBeGreaterThan(0);
    });
  });

  describe('priority ordering and savings calculation', () => {
    it('orders recommendations by priority (high before medium before low)', async () => {
      const readings = [];
      for (let day = 1; day <= 14; day++) {
        readings.push({
          timestamp: `2024-01-${String(day).padStart(2, '0')}T12:00:00.000Z`,
          value: 1.0 + day * 0.5,
        });
      }
      for (let hour = 0; hour < 24; hour++) {
        const isPeak = hour >= 18 && hour <= 21;
        readings.push({
          timestamp: `2024-01-15T${String(hour).padStart(2, '0')}:00:00.000Z`,
          value: isPeak ? 5.0 : 1.0,
        });
      }
      readings.push({ timestamp: '2024-01-16T12:00:00.000Z', value: 60.0 });
      await seedReadings(db, meterId, readings);

      const res = await request(app).get(`/api/meters/${meterId}/recommendations`);

      expect(res.status).toBe(200);
      const priorities = res.body.recommendations.map((r: { priority: string }) => r.priority);
      const rank: Record<string, number> = { high: 0, medium: 1, low: 2 };
      for (let i = 1; i < priorities.length; i++) {
        expect(rank[priorities[i]]).toBeGreaterThanOrEqual(rank[priorities[i - 1]]);
      }
    });

    it('calculates potential savings as a non-negative number for each recommendation', async () => {
      const readings = [];
      for (let hour = 0; hour < 24; hour++) {
        const isPeak = hour >= 18 && hour <= 21;
        readings.push({
          timestamp: `2024-01-01T${String(hour).padStart(2, '0')}:00:00.000Z`,
          value: isPeak ? 5.0 : 1.0,
        });
      }
      await seedReadings(db, meterId, readings);

      const res = await request(app).get(`/api/meters/${meterId}/recommendations`);

      expect(res.status).toBe(200);
      for (const rec of res.body.recommendations) {
        expect(typeof rec.potentialSavings).toBe('number');
        expect(rec.potentialSavings).toBeGreaterThanOrEqual(0);
        expect(Number.isFinite(rec.potentialSavings)).toBe(true);
      }
    });
  });

  describe('adoption and impact tracking', () => {
    it('marks a recommendation as adopted and records its impact', async () => {
      const readings = [];
      for (let hour = 0; hour < 24; hour++) {
        const isPeak = hour >= 18 && hour <= 21;
        readings.push({
          timestamp: `2024-01-01T${String(hour).padStart(2, '0')}:00:00.000Z`,
          value: isPeak ? 5.0 : 1.0,
        });
      }
      await seedReadings(db, meterId, readings);

      const listRes = await request(app).get(`/api/meters/${meterId}/recommendations`);
      expect(listRes.status).toBe(200);
      const rec = listRes.body.recommendations[0];
      expect(rec.adopted).toBe(false);

      const adoptRes = await request(app)
        .post(`/api/meters/${meterId}/recommendations/${rec.id}/adopt`)
        .send({});

      expect(adoptRes.status).toBe(200);
      expect(adoptRes.body).toEqual(
        expect.objectContaining({
          id: rec.id,
          adopted: true,
          adoptedAt: expect.any(String),
        })
      );

      const afterRes = await request(app).get(`/api/meters/${meterId}/recommendations`);
      const updated = afterRes.body.recommendations.find(
        (r: { id: string }) => r.id === rec.id
      );
      expect(updated.adopted).toBe(true);
      expect(updated.adoptedAt).toEqual(expect.any(String));
    });

    it('records realized impact for an adopted recommendation', async () => {
      const readings = [];
      for (let hour = 0; hour < 24; hour++) {
        const isPeak = hour >= 18 && hour <= 21;
        readings.push({
          timestamp: `2024-01-01T${String(hour).padStart(2, '0')}:00:00.000Z`,
          value: isPeak ? 5.0 : 1.0,
        });
      }
      await seedReadings(db, meterId, readings);

      const listRes = await request(app).get(`/api/meters/${meterId}/recommendations`);
      const rec = listRes.body.recommendations[0];

      await request(app)
        .post(`/api/meters/${meterId}/recommendations/${rec.id}/adopt`)
        .send({});

      const impactRes = await request(app)
        .post(`/api/meters/${meterId}/recommendations/${rec.id}/impact`)
        .send({ realizedSavings: 12.5 });

      expect(impactRes.status).toBe(200);
      expect(impactRes.body).toEqual(
        expect.objectContaining({
          id: rec.id,
          realizedSavings: 12.5,
        })
      );

      const afterRes = await request(app).get(`/api/meters/${meterId}/recommendations`);
      const updated = afterRes.body.recommendations.find(
        (r: { id: string }) => r.id === rec.id
      );
      expect(updated.realizedSavings).toBe(12.5);
    });

    it('returns 404 when adopting a recommendation that does not exist', async () => {
      const res = await request(app)
        .post(`/api/meters/${meterId}/recommendations/nonexistent-id/adopt`)
        .send({});

      expect(res.status).toBe(404);
    });
  });
});