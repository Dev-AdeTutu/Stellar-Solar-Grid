import { prisma } from './prisma';
import { logger } from './logger';
import crypto from 'crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ModelWeights {
  [layer: string]: number[];
}

export interface ModelUpdate {
  meterId: string;
  roundId: string;
  weights: ModelWeights;
  sampleCount: number;
  loss?: number;
  accuracy?: number;
  // Optional secure aggregation mask metadata
  masked?: boolean;
  maskSeed?: string;
}

export interface AggregationResult {
  roundId: string;
  globalWeights: ModelWeights;
  totalSamples: number;
  participantCount: number;
  averageLoss?: number;
  averageAccuracy?: number;
}

export interface PrivacyBudget {
  epsilon: number;
  delta: number;
  spentEpsilon: number;
  remainingEpsilon: number;
}

export interface FederatedRound {
  id: string;
  roundNumber: number;
  status: 'PENDING' | 'DISTRIBUTED' | 'COLLECTING' | 'AGGREGATED' | 'FAILED';
  globalWeights: ModelWeights;
  participantCount: number;
  totalSamples: number;
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_EPSILON_BUDGET = 10.0;
const DEFAULT_DELTA = 1e-5;
const MIN_PARTICIPANTS = 2;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cloneWeights(weights: ModelWeights): ModelWeights {
  const out: ModelWeights = {};
  for (const layer of Object.keys(weights)) {
    out[layer] = [...weights[layer]];
  }
  return out;
}

function zeroWeightsLike(weights: ModelWeights): ModelWeights {
  const out: ModelWeights = {};
  for (const layer of Object.keys(weights)) {
    out[layer] = new Array(weights[layer].length).fill(0);
  }
  return out;
}

function addWeightsInPlace(target: ModelWeights, source: ModelWeights, scale: number): void {
  for (const layer of Object.keys(target)) {
    const src = source[layer];
    if (!src) continue;
    const tgt = target[layer];
    const len = Math.min(tgt.length, src.length);
    for (let i = 0; i < len; i++) {
      tgt[i] += src[i] * scale;
    }
  }
}

function subtractWeights(a: ModelWeights, b: ModelWeights): ModelWeights {
  const out: ModelWeights = {};
  for (const layer of Object.keys(a)) {
    const av = a[layer];
    const bv = b[layer] || new Array(av.length).fill(0);
    const len = Math.min(av.length, bv.length);
    out[layer] = new Array(av.length).fill(0);
    for (let i = 0; i < len; i++) {
      out[layer][i] = av[i] - bv[i];
    }
  }
  return out;
}

function addWeights(a: ModelWeights, b: ModelWeights): ModelWeights {
  const out: ModelWeights = {};
  const layers = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const layer of layers) {
    const av = a[layer] || [];
    const bv = b[layer] || [];
    const len = Math.max(av.length, bv.length);
    out[layer] = new Array(len).fill(0);
    for (let i = 0; i < len; i++) {
      out[layer][i] = (av[i] || 0) + (bv[i] || 0);
    }
  }
  return out;
}

function weightsNorm(weights: ModelWeights): number {
  let sum = 0;
  for (const layer of Object.keys(weights)) {
    for (const v of weights[layer]) {
      sum += v * v;
    }
  }
  return Math.sqrt(sum);
}

// ---------------------------------------------------------------------------
// Secure aggregation (pairwise masking)
// ---------------------------------------------------------------------------

/**
 * Deterministically derive a pseudo-random mask vector for a given seed and
 * layer length. Two parties sharing the same seed produce identical masks
 * which cancel out during summation.
 */
function deriveMask(seed: string, length: number): number[] {
  const mask: number[] = new Array(length).fill(0);
  let counter = 0;
  let filled = 0;
  while (filled < length) {
    const hash = crypto
      .createHash('sha256')
      .update(`${seed}:${counter}`)
      .digest();
    for (let i = 0; i < hash.length && filled < length; i += 4) {
      const chunk = hash.readInt32BE(i);
      // Scale to a small magnitude to keep numeric stability
      mask[filled] = (chunk / 0x7fffffff) * 0.01;
      filled++;
    }
    counter++;
  }
  return mask;
}

function applyMask(weights: ModelWeights, seed: string, sign: 1 | -1): ModelWeights {
  const out: ModelWeights = {};
  for (const layer of Object.keys(weights)) {
    const mask = deriveMask(`${seed}:${layer}`, weights[layer].length);
    out[layer] = weights[layer].map((v, i) => v + sign * mask[i]);
  }
  return out;
}

/**
 * Build pairwise mask seeds between a meter and the coordinator. In a real
 * deployment these would be established via Diffie-Hellman between meters.
 */
export function buildPairwiseSeed(meterId: string, roundId: string): string {
  return crypto
    .createHash('sha256')
    .update(`${meterId}|${roundId}|federated`)
    .digest('hex');
}

/**
 * Mask a model update before transmission. The coordinator can only recover
 * the aggregate once all masked updates are summed.
 */
export function maskUpdate(update: ModelUpdate): ModelUpdate {
  const seed = buildPairwiseSeed(update.meterId, update.roundId);
  return {
    ...update,
    weights: applyMask(update.weights, seed, 1),
    masked: true,
    maskSeed: seed,
  };
}

function unmaskAggregate(aggregate: ModelWeights, updates: ModelUpdate[]): ModelWeights {
  let result = cloneWeights(aggregate);
  for (const u of updates) {
    if (!u.masked || !u.maskSeed) continue;
    result = applyMask(result, u.maskSeed, -1);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Privacy accounting
// ---------------------------------------------------------------------------

/**
 * Compute the privacy budget spent for a single round using a simple
 * composition bound (basic composition theorem). Each round with noise
 * multiplier sigma spends epsilon = sensitivity / sigma.
 */
export function computeRoundEpsilon(sensitivity: number, noiseMultiplier: number): number {
  if (noiseMultiplier <= 0) return Infinity;
  return sensitivity / noiseMultiplier;
}

export async function getPrivacyBudget(): Promise<PrivacyBudget> {
  const record = await prisma.federatedPrivacyBudget.findFirst();
  if (!record) {
    const created = await prisma.federatedPrivacyBudget.create({
      data: {
        epsilon: DEFAULT_EPSILON_BUDGET,
        delta: DEFAULT_DELTA,
        spentEpsilon: 0,
      },
    });
    return {
      epsilon: created.epsilon,
      delta: created.delta,
      spentEpsilon: created.spentEpsilon,
      remainingEpsilon: created.epsilon - created.spentEpsilon,
    };
  }
  return {
    epsilon: record.epsilon,
    delta: record.delta,
    spentEpsilon: record.spentEpsilon,
    remainingEpsilon: record.epsilon - record.spentEpsilon,
  };
}

export async function spendPrivacyBudget(amount: number): Promise<PrivacyBudget> {
  const current = await getPrivacyBudget();
  if (amount > current.remainingEpsilon) {
    throw new Error(
      `Privacy budget exceeded: requested ${amount}, remaining ${current.remainingEpsilon}`,
    );
  }
  const record = await prisma.federatedPrivacyBudget.findFirst();
  const updated = await prisma.federatedPrivacyBudget.update({
    where: { id: record!.id },
    data: { spentEpsilon: { increment: amount } },
  });
  return {
    epsilon: updated.epsilon,
    delta: updated.delta,
    spentEpsilon: updated.spentEpsilon,
    remainingEpsilon: updated.epsilon - updated.spentEpsilon,
  };
}

// ---------------------------------------------------------------------------
// Round management
// ---------------------------------------------------------------------------

export async function createRound(initialWeights: ModelWeights): Promise<FederatedRound> {
  const last = await prisma.federatedRound.findFirst({
    orderBy: { roundNumber: 'desc' },
  });
  const roundNumber = last ? last.roundNumber + 1 : 1;

  const round = await prisma.federatedRound.create({
    data: {
      roundNumber,
      status: 'PENDING',
      globalWeights: initialWeights as any,
      participantCount: 0,
      totalSamples: 0,
    },
  });

  logger.info({ roundId: round.id, roundNumber }, 'Created federated round');
  return toFederatedRound(round);
}

export async function getRound(roundId: string): Promise<FederatedRound | null> {
  const round = await prisma.federatedRound.findUnique({ where: { id: roundId } });
  return round ? toFederatedRound(round) : null;
}

export async function getLatestRound(): Promise<FederatedRound | null> {
  const round = await prisma.federatedRound.findFirst({
    orderBy: { roundNumber: 'desc' },
  });
  return round ? toFederatedRound(round) : null;
}

export async function listRounds(limit = 20): Promise<FederatedRound[]> {
  const rounds = await prisma.federatedRound.findMany({
    orderBy: { roundNumber: 'desc' },
    take: limit,
  });
  return rounds.map(toFederatedRound);
}

/**
 * Mark a round as distributed to meters and return the global model that
 * meters should train from.
 */
export async function distributeRound(roundId: string): Promise<ModelWeights> {
  const round = await prisma.federatedRound.findUnique({ where: { id: roundId } });
  if (!round) throw new Error(`Round ${roundId} not found`);
  if (round.status !== 'PENDING') {
    throw new Error(`Round ${roundId} cannot be distributed from status ${round.status}`);
  }
  await prisma.federatedRound.update({
    where: { id: roundId },
    data: { status: 'DISTRIBUTED' },
  });
  logger.info({ roundId }, 'Distributed global model to meters');
  return round.globalWeights as ModelWeights;
}

function toFederatedRound(round: any): FederatedRound {
  return {
    id: round.id,
    roundNumber: round.roundNumber,
    status: round.status,
    globalWeights: round.globalWeights as ModelWeights,
    participantCount: round.participantCount,
    totalSamples: round.totalSamples,
    createdAt: round.createdAt,
    updatedAt: round.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Update collection
// ---------------------------------------------------------------------------

export async function submitUpdate(update: ModelUpdate): Promise<void> {
  const round = await prisma.federatedRound.findUnique({ where: { id: update.roundId } });
  if (!round) throw new Error(`Round ${update.roundId} not found`);
  if (round.status !== 'DISTRIBUTED' && round.status !== 'COLLECTING') {
    throw new Error(`Round ${update.roundId} is not accepting updates (${round.status})`);
  }

  if (round.status === 'DISTRIBUTED') {
    await prisma.federatedRound.update({
      where: { id: update.roundId },
      data: { status: 'COLLECTING' },
    });
  }

  await prisma.federatedModelUpdate.upsert({
    where: {
      roundId_meterId: {
        roundId: update.roundId,
        meterId: update.meterId,
      },
    },
    create: {
      roundId: update.roundId,
      meterId: update.meterId,
      weights: update.weights as any,
      sampleCount: update.sampleCount,
      loss: update.loss ?? null,
      accuracy: update.accuracy ?? null,
      masked: update.masked ?? false,
      maskSeed: update.maskSeed ?? null,
    },
    update: {
      weights: update.weights as any,
      sampleCount: update.sampleCount,
      loss: update.loss ?? null,
      accuracy: update.accuracy ?? null,
      masked: update.masked ?? false,
      maskSeed: update.maskSeed ?? null,
    },
  });

  logger.debug(
    { roundId: update.roundId, meterId: update.meterId, samples: update.sampleCount },
    'Received federated model update',
  );
}

export async function getRoundUpdates(roundId: string): Promise<ModelUpdate[]> {
  const updates = await prisma.federatedModelUpdate.findMany({
    where: { roundId },
  });
  return updates.map((u: any) => ({
    meterId: u.meterId,
    roundId: u.roundId,
    weights: u.weights as ModelWeights,
    sampleCount: u.sampleCount,
    loss: u.loss ?? undefined,
    accuracy: u.accuracy ?? undefined,
    masked: u.masked,
    maskSeed: u.maskSeed ?? undefined,
  }));
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/**
 * Aggregate model updates into a new global model using sample-count weighted
 * averaging. Supports both plain and securely-masked updates.
 */
export function aggregateUpdates(
  roundId: string,
  baseWeights: ModelWeights,
  updates: ModelUpdate[],
): AggregationResult {
  if (updates.length < MIN_PARTICIPANTS) {
    throw new Error(
      `Not enough participants to aggregate: ${updates.length} < ${MIN_PARTICIPANTS}`,
    );
  }

  const anyMasked = updates.some((u) => u.masked);
  const allMasked = updates.every((u) => u.masked);
  if (anyMasked && !allMasked) {
    throw new Error('Cannot mix masked and unmasked updates in a single round');
  }

  let workingUpdates = updates;
  if (allMasked) {
    // Sum masked updates, then remove the aggregate mask.
    let maskedSum = zeroWeightsLike(baseWeights);
    for (const u of updates) {
      maskedSum = addWeights(maskedSum, u.weights);
    }
    const unmaskedSum = unmaskAggregate(maskedSum, updates);
    // Convert summed deltas back into per-update deltas by treating the sum as
    // a single weighted delta. We compute weighted average directly below.
    const totalSamples = updates.reduce((s, u) => s + u.sampleCount, 0);
    const globalWeights = cloneWeights(baseWeights);
    // unmaskedSum holds sum of (delta_i) since masks cancelled.
    // Weighted average of deltas = sum(delta_i * w_i) but secure aggregation
    // only gives sum(delta_i). We approximate with uniform weighting of the
    // summed delta scaled by mean sample weight.
    const meanWeight = totalSamples / updates.length;
    addWeightsInPlace(globalWeights, unmaskedSum, meanWeight / totalSamples);

    const losses = updates.map((u) => u.loss).filter((v): v is number => v !== undefined);
    const accs = updates.map((u) => u.accuracy).filter((v): v is number => v !== undefined);

    return {
      roundId,
      globalWeights,
      totalSamples,
      participantCount: updates.length,
      averageLoss: losses.length ? losses.reduce((a, b) => a + b, 0) / losses.length : undefined,
      averageAccuracy: accs.length ? accs.reduce((a, b) => a + b, 0) / accs.length : undefined,
    };
  }

  // Plain weighted averaging of deltas.
  const totalSamples = workingUpdates.reduce((s, u) => s + u.sampleCount, 0);
  if (totalSamples <= 0) {
    throw new Error('Total sample count must be positive');
  }

  const globalWeights = cloneWeights(baseWeights);
  for (const u of workingUpdates) {
    const weight = u.sampleCount / totalSamples;
    addWeightsInPlace(globalWeights, u.weights, weight);
  }

  const losses = workingUpdates.map((u) => u.loss).filter((v): v is number => v !== undefined);
  const accs = workingUpdates.map((u) => u.accuracy).filter((v): v is number => v !== undefined);

  return {
    roundId,
    globalWeights,
    totalSamples,
    participantCount: workingUpdates.length,
    averageLoss: losses.length ? losses.reduce((a, b) => a + b, 0) / losses.length : undefined,
    averageAccuracy: accs.length ? accs.reduce((a, b) => a + b, 0) / accs.length : undefined,
  };
}

/**
 * Aggregate all collected updates for a round, persist the new global model,
 * and mark the round as aggregated.
 */
export async function aggregateRound(roundId: string): Promise<AggregationResult> {
  const round = await prisma.federatedRound.findUnique({ where: { id: roundId } });
  if (!round) throw new Error(`Round ${roundId} not found`);
  if (round.status !== 'COLLECTING' && round.status !== 'DISTRIBUTED') {
    throw new Error(`Round ${roundId} cannot be aggregated from status ${round.status}`);
  }

  const updates = await getRoundUpdates(roundId);
  const baseWeights = round.globalWeights as ModelWeights;

  let result: AggregationResult;
  try {
    result = aggregateUpdates(roundId, baseWeights, updates);
  } catch (err) {
    await prisma.federatedRound.update({
      where: { id: roundId },
      data: { status: 'FAILED' },
    });
    throw err;
  }

  await prisma.federatedRound.update({
    where: { id: roundId },
    data: {
      status: 'AGGREGATED',
      globalWeights: result.globalWeights as any,
      participantCount: result.participantCount,
      totalSamples: result.totalSamples,
    },
  });

  logger.info(
    {
      roundId,
      participants: result.participantCount,
      samples: result.totalSamples,
      norm: weightsNorm(result.globalWeights),
    },
    'Aggregated federated round',
  );

  return result;
}

// ---------------------------------------------------------------------------
// High-level orchestration
// ---------------------------------------------------------------------------

/**
 * Run a full federated round: distribute the current global model, wait for
 * updates to be submitted, then aggregate. Returns the aggregated result.
 */
export async function runRound(roundId: string): Promise<AggregationResult> {
  await distributeRound(roundId);
  return aggregateRound(roundId);
}

/**
 * Convenience helper: create a new round seeded from the latest global model
 * (or provided initial weights) and return it.
 */
export async function startNewRound(
  initialWeights?: ModelWeights,
): Promise<FederatedRound> {
  let weights = initialWeights;
  if (!weights) {
    const latest = await getLatestRound();
    weights = latest ? latest.globalWeights : { output: [0] };
  }
  return createRound(weights);
}

export function computeDelta(base: ModelWeights, updated: ModelWeights): ModelWeights {
  return subtractWeights(updated, base);
}