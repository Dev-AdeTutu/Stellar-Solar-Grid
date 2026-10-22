import { TheftDetectionService } from '../src/services/theftDetectionService';
import { getMeterTheftAnalysisHandler } from '../src/routes/theftAnalysisRoutes';

describe('Meter Energy Theft Detection (#1012)', () => {
  test('trains normal consumption baseline and detects sudden drops and bypass anomalies', () => {
    const service = new TheftDetectionService();
    const meterId = 'MTR-TEST-01';

    service.trainNormalPatternModel(meterId, [
      { timestamp: '2026-10-10T09:00:00Z', kwh: 5.0 },
      { timestamp: '2026-10-11T09:00:00Z', kwh: 4.8 },
      { timestamp: '2026-10-12T09:00:00Z', kwh: 5.2 },
    ]);

    const analysis = service.analyzeMeterTheft(meterId, [
      { timestamp: '2026-10-16T09:00:00Z', kwh: 0.01 }, // Bypass
      { timestamp: '2026-10-16T09:15:00Z', kwh: 0.02 }, // Bypass
      { timestamp: '2026-10-16T09:30:00Z', kwh: 1.1 },  // Sudden drop
    ]);

    expect(analysis.riskScore).toBeGreaterThanOrEqual(70);
    expect(analysis.status).toBe('HIGH_THEFT_PROBABILITY');
    expect(analysis.alert).not.toBeNull();
    expect(analysis.alert?.notifiedProvider).toBe(true);
    expect(analysis.investigationReport.anomalies.length).toBeGreaterThanOrEqual(2);
  });

  test('GET /api/meters/:meterId/theft-analysis returns risk score and report', () => {
    let statusCode = 0;
    let bodyPayload: any = null;

    getMeterTheftAnalysisHandler(
      { params: { meterId: 'MTR-API-99' } },
      {
        status(code: number) {
          statusCode = code;
          return this;
        },
        json(payload: unknown) {
          bodyPayload = payload;
        },
      }
    );

    expect(statusCode).toBe(200);
    expect(bodyPayload.meterId).toBe('MTR-API-99');
    expect(typeof bodyPayload.riskScore).toBe('number');
    expect(bodyPayload.investigationReport).toBeDefined();
  });
});
