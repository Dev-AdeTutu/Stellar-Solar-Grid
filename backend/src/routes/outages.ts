import { Router, Request, Response } from 'express';
import { outageService, GridReading } from '../services/outageService.js';
import { publishCircuitControl } from '../iot/mqttClient.js';

export const outagesRouter = Router();

/**
 * GET /api/outages/current
 * Returns all currently active power outages.
 */
outagesRouter.get('/current', (_req: Request, res: Response) => {
  const active = outageService.getActiveOutages();
  return res.json({
    status: 'success',
    count: active.length,
    outages: active,
  });
});

/**
 * POST /api/outages
 * Create an outage record manually or from monitoring events.
 */
outagesRouter.post('/', (req: Request, res: Response) => {
  const { region, affectedMeters, affectedUsers, estimatedRestorationAt, cause, severity } = req.body;

  if (!region || !Array.isArray(affectedMeters) || affectedMeters.length === 0) {
    return res.status(400).json({
      error: 'Invalid request: region and non-empty affectedMeters array are required.',
    });
  }

  const record = outageService.createOutage({
    region,
    affectedMeters,
    affectedUsers: Array.isArray(affectedUsers) ? affectedUsers : [],
    estimatedRestorationAt,
    cause,
    severity,
  });

  return res.status(201).json({
    status: 'success',
    outage: record,
  });
});

/**
 * POST /api/outages/telemetry
 * Ingest IoT voltage/frequency telemetry and auto-evaluate grid health.
 */
outagesRouter.post('/telemetry', (req: Request, res: Response) => {
  const { meterId, voltage, frequency, region, userAddress } = req.body;

  if (!meterId || typeof voltage !== 'number' || typeof frequency !== 'number') {
    return res.status(400).json({
      error: 'Invalid telemetry: meterId, voltage, and frequency are required.',
    });
  }

  const reading: GridReading = {
    meterId,
    voltage,
    frequency,
    region: region || 'default-grid',
    userAddress,
  };

  outageService.recordReading(reading);
  const detected = outageService.evaluateGridReadings();

  return res.json({
    status: 'success',
    recorded: reading,
    newOutagesDetected: detected.length,
    detectedOutages: detected,
  });
});

/**
 * GET /api/outages/:id
 * Retrieve details for a specific outage.
 */
outagesRouter.get('/:id', (req: Request, res: Response) => {
  const outage = outageService.getOutageById(req.params.id);
  if (!outage) {
    return res.status(404).json({ error: 'Outage not found' });
  }
  return res.json({ status: 'success', outage });
});

/**
 * POST /api/outages/:id/resolve
 * Mark an outage as resolved.
 */
outagesRouter.post('/:id/resolve', (req: Request, res: Response) => {
  const resolved = outageService.resolveOutage(req.params.id);
  if (!resolved) {
    return res.status(404).json({ error: 'Outage not found' });
  }
  return res.json({ status: 'success', outage: resolved });
});

/**
 * POST /api/outages/circuits/:meterId/:circuitId
 * Control circuit state via IoT MQTT command (#977).
 */
outagesRouter.post('/circuits/:meterId/:circuitId', async (req: Request, res: Response) => {
  const { meterId, circuitId } = req.params;
  const { action } = req.body; // 'shed' | 'restore'

  if (action !== 'shed' && action !== 'restore') {
    return res.status(400).json({ error: "Action must be 'shed' or 'restore'" });
  }

  try {
    await publishCircuitControl(meterId, parseInt(circuitId, 10), action);
    return res.json({
      status: 'success',
      meterId,
      circuitId: parseInt(circuitId, 10),
      action,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: `Failed to publish circuit command: ${message}` });
  }
});
