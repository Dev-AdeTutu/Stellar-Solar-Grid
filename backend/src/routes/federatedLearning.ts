import { Router, Request, Response } from 'express';
import { body, param, validationResult } from 'express-validator';

export interface ModelWeights {
  [layer: string]: number[];
}

export interface FederatedRound {
  id: string;
  status: 'collecting' | 'aggregating' | 'completed' | 'failed';
  createdAt: string;
  completedAt?: string;
  minParticipants: number;
  maxParticipants: number;
  participants: string[];
  updates: Map<string, MeterUpdate>;
  globalModel?: ModelWeights;
  aggregationStrategy: 'fedavg' | 'weighted';
}

export interface MeterUpdate {
  meterId: string;
  roundId: string;
  weights: ModelWeights;
  sampleCount: number;
  loss?: number;
  submittedAt: string;
  privacyBudgetUsed: number;
}

export interface PrivacyBudget {
  epsilon: number;
  delta: number;
  totalEpsilon: number;
  totalDelta: number;
  remainingEpsilon: number;
  remainingDelta: number;
  noiseMechanism: 'gaussian' | 'laplace';
  clippingNorm: number;
}

const rounds = new Map<string, FederatedRound>();
let globalModel: ModelWeights = {
  layer1: [0.1, 0.2, 0.3, 0.4],
  layer2: [0.5, 0.6, 0.7, 0.8],
  output: [0.9, 1.0],
};

const privacyBudget: PrivacyBudget = {
  epsilon: 0.1,
  delta: 1e-5,
  totalEpsilon: 10.0,
  totalDelta: 1e-4,
  remainingEpsilon: 10.0,
  remainingDelta: 1e-4,
  noiseMechanism: 'gaussian',
  clippingNorm: 1.0,
};

const RAW_DATA_KEYS = [
  'readings',
  'rawReadings',
  'raw',
  'samples',
  'data',
  'values',
  'measurements',
  'timeseries',
  'timeSeries',
  'records',
];

function generateRoundId(): string {
  return `round_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
}

function containsRawData(payload: any): boolean {
  if (payload === null || payload === undefined) {
    return false;
  }
  if (Array.isArray(payload)) {
    return payload.some((item) => containsRawData(item));
  }
  if (typeof payload === 'object') {
    for (const key of Object.keys(payload)) {
      if (RAW_DATA_KEYS.includes(key)) {
        return true;
      }
      if (containsRawData(payload[key])) {
        return true;
      }
    }
  }
  return false;
}

function validateWeights(weights: any): string | null {
  if (!weights || typeof weights !== 'object' || Array.isArray(weights)) {
    return 'weights must be an object mapping layer names to numeric arrays';
  }
  const keys = Object.keys(weights);
  if (keys.length === 0) {
    return 'weights must contain at least one layer';
  }
  for (const key of keys) {
    const layer = weights[key];
    if (!Array.isArray(layer)) {
      return `weights.${key} must be an array of numbers`;
    }
    if (layer.length === 0) {
      return `weights.${key} must not be empty`;
    }
    for (const value of layer) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return `weights.${key} must contain only finite numbers`;
      }
    }
  }
  return null;
}

function aggregateWeights(updates: MeterUpdate[], strategy: 'fedavg' | 'weighted'): ModelWeights {
  if (updates.length === 0) {
    return globalModel;
  }

  const layerNames = new Set<string>();
  for (const update of updates) {
    for (const layer of Object.keys(update.weights)) {
      layerNames.add(layer);
    }
  }

  const totalSamples = updates.reduce((sum, u) => sum + u.sampleCount, 0);
  const aggregated: ModelWeights = {};

  for (const layerName of layerNames) {
    const layers = updates
      .map((u) => u.weights[layerName])
      .filter((l): l is number[] => Array.isArray(l));

    if (layers.length === 0) {
      continue;
    }

    const length = Math.min(...layers.map((l) => l.length));
    const result: number[] = new Array(length).fill(0);

    if (strategy === 'weighted' && totalSamples > 0) {
      for (const update of updates) {
        const layer = update.weights[layerName];
        if (!Array.isArray(layer)) {
          continue;
        }
        const weight = update.sampleCount / totalSamples;
        for (let i = 0; i < length; i++) {
          result[i] += layer[i] * weight;
        }
      }
    } else {
      for (const layer of layers) {
        for (let i = 0; i < length; i++) {
          result[i] += layer[i] / layers.length;
        }
      }
    }

    aggregated[layerName] = result;
  }

  return aggregated;
}

const router = Router();

router.post(
  '/rounds',
  body('minParticipants').optional().isInt({ min: 1, max: 1000 }).toInt(),
  body('maxParticipants').optional().isInt({ min: 1, max: 10000 }).toInt(),
  body('aggregationStrategy').optional().isIn(['fedavg', 'weighted']),
  (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    if (containsRawData(req.body)) {
      return res.status(400).json({
        error: 'Raw data is not permitted in federated learning requests',
      });
    }

    const minParticipants = req.body.minParticipants ?? 2;
    const maxParticipants = req.body.maxParticipants ?? 100;
    const aggregationStrategy = req.body.aggregationStrategy ?? 'weighted';

    if (minParticipants > maxParticipants) {
      return res.status(400).json({
        error: 'minParticipants must be less than or equal to maxParticipants',
      });
    }

    const round: FederatedRound = {
      id: generateRoundId(),
      status: 'collecting',
      createdAt: new Date().toISOString(),
      minParticipants,
      maxParticipants,
      participants: [],
      updates: new Map(),
      aggregationStrategy,
    };

    rounds.set(round.id, round);

    return res.status(201).json({
      id: round.id,
      status: round.status,
      createdAt: round.createdAt,
      minParticipants: round.minParticipants,
      maxParticipants: round.maxParticipants,
      aggregationStrategy: round.aggregationStrategy,
      participantCount: 0,
    });
  }
);

router.get(
  '/rounds/:id',
  param('id').isString().notEmpty(),
  (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const round = rounds.get(req.params.id);
    if (!round) {
      return res.status(404).json({ error: 'Round not found' });
    }

    return res.json({
      id: round.id,
      status: round.status,
      createdAt: round.createdAt,
      completedAt: round.completedAt,
      minParticipants: round.minParticipants,
      maxParticipants: round.maxParticipants,
      aggregationStrategy: round.aggregationStrategy,
      participantCount: round.participants.length,
      participants: round.participants,
      updateCount: round.updates.size,
      hasGlobalModel: !!round.globalModel,
    });
  }
);

router.post(
  '/rounds/:id/updates',
  param('id').isString().notEmpty(),
  body('meterId').isString().notEmpty(),
  body('weights').exists(),
  body('sampleCount').isInt({ min: 1 }).toInt(),
  body('loss').optional().isFloat({ min: 0 }).toFloat(),
  body('privacyBudgetUsed').optional().isFloat({ min: 0 }).toFloat(),
  (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    if (containsRawData(req.body)) {
      return res.status(400).json({
        error: 'Raw data is not permitted in federated learning updates',
      });
    }

    const round = rounds.get(req.params.id);
    if (!round) {
      return res.status(404).json({ error: 'Round not found' });
    }

    if (round.status !== 'collecting') {
      return res.status(409).json({
        error: `Round is not accepting updates (status: ${round.status})`,
      });
    }

    const weightsError = validateWeights(req.body.weights);
    if (weightsError) {
      return res.status(400).json({ error: weightsError });
    }

    const meterId: string = req.body.meterId;
    if (round.updates.has(meterId)) {
      return res.status(409).json({
        error: `Meter ${meterId} has already submitted an update for this round`,
      });
    }

    if (round.participants.length >= round.maxParticipants) {
      return res.status(409).json({
        error: 'Round has reached maximum number of participants',
      });
    }

    const privacyBudgetUsed: number = req.body.privacyBudgetUsed ?? privacyBudget.epsilon;

    if (privacyBudgetUsed > privacyBudget.remainingEpsilon) {
      return res.status(400).json({
        error: 'Privacy budget exceeded',
        remainingEpsilon: privacyBudget.remainingEpsilon,
      });
    }

    const update: MeterUpdate = {
      meterId,
      roundId: round.id,
      weights: req.body.weights,
      sampleCount: req.body.sampleCount,
      loss: req.body.loss,
      submittedAt: new Date().toISOString(),
      privacyBudgetUsed,
    };

    round.updates.set(meterId, update);
    round.participants.push(meterId);
    privacyBudget.remainingEpsilon -= privacyBudgetUsed;

    if (round.updates.size >= round.minParticipants) {
      round.status = 'aggregating';
      try {
        const aggregated = aggregateWeights(
          Array.from(round.updates.values()),
          round.aggregationStrategy
        );
        round.globalModel = aggregated;
        globalModel = aggregated;
        round.status = 'completed';
        round.completedAt = new Date().toISOString();
      } catch (err) {
        round.status = 'failed';
      }
    }

    return res.status(201).json({
      roundId: round.id,
      meterId,
      accepted: true,
      roundStatus: round.status,
      participantCount: round.participants.length,
      remainingEpsilon: privacyBudget.remainingEpsilon,
    });
  }
);

router.get('/model', (_req: Request, res: Response) => {
  return res.json({
    model: globalModel,
    updatedAt: new Date().toISOString(),
  });
});

router.get('/privacy', (_req: Request, res: Response) => {
  return res.json({
    epsilon: privacyBudget.epsilon,
    delta: privacyBudget.delta,
    totalEpsilon: privacyBudget.totalEpsilon,
    totalDelta: privacyBudget.totalDelta,
    remainingEpsilon: privacyBudget.remainingEpsilon,
    remainingDelta: privacyBudget.remainingDelta,
    noiseMechanism: privacyBudget.noiseMechanism,
    clippingNorm: privacyBudget.clippingNorm,
  });
});

export default router;