import { ConsumptionReading, theftDetectionService } from '../services/theftDetectionService';

export interface RequestLike {
  params: { meterId: string };
  query?: { readings?: string };
  body?: { readings?: ConsumptionReading[] };
}

export interface ResponseLike {
  status: (code: number) => ResponseLike;
  json: (payload: unknown) => void;
}

/**
 * GET /api/meters/:meterId/theft-analysis
 * Returns ML theft risk score, detected anomalies, provider alert status, and investigation report.
 */
export function getMeterTheftAnalysisHandler(req: RequestLike, res: ResponseLike): void {
  const { meterId } = req.params;
  if (!meterId) {
    res.status(400).json({ error: 'meterId parameter is required' });
    return;
  }

  const sampleReadings: ConsumptionReading[] = req.body?.readings || [
    { timestamp: '2026-10-16T08:00:00Z', kwh: 4.4 },
    { timestamp: '2026-10-16T09:00:00Z', kwh: 0.02 },
    { timestamp: '2026-10-16T10:00:00Z', kwh: 0.01 },
    { timestamp: '2026-10-16T11:00:00Z', kwh: 0.9 },
  ];

  const analysis = theftDetectionService.analyzeMeterTheft(meterId, sampleReadings);
  res.status(200).json(analysis);
}

export function registerTheftAnalysisRoutes(app: {
  get: (path: string, handler: (req: RequestLike, res: ResponseLike) => void) => void;
}): void {
  app.get('/api/meters/:meterId/theft-analysis', getMeterTheftAnalysisHandler);
}
