/**
 * Swarm Intelligence Module
 *
 * Implements decentralized, collective optimization for meters.
 * Meters share anonymized performance data, collectively learn optimal
 * strategies, and derive emergent load-balancing recommendations without
 * central control. Behavior adapts to changing network conditions.
 *
 * See docs/SWARM.md for design details.
 */

import { createHash } from 'crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Raw performance sample reported by a meter. Contains no directly
 * identifying information; the meter id is hashed before aggregation.
 */
export interface MeterPerformanceSample {
  /** Opaque meter identifier (hashed before use). */
  meterId: string;
  /** Observed throughput in requests per second. */
  throughput: number;
  /** Observed latency in milliseconds. */
  latencyMs: number;
  /** Fraction of capacity currently utilized (0..1). */
  utilization: number;
  /** Fraction of requests that failed (0..1). */
  errorRate: number;
  /** Timestamp of the sample (epoch ms). */
  timestamp: number;
}

/**
 * Anonymized sample safe for network-wide sharing.
 */
export interface AnonymizedSample {
  /** Stable, non-reversible pseudonym for the meter. */
  pseudonym: string;
  throughput: number;
  latencyMs: number;
  utilization: number;
  errorRate: number;
  timestamp: number;
}

/**
 * A learned strategy describing how a meter should behave.
 */
export interface SwarmStrategy {
  /** Target utilization the swarm has converged on (0..1). */
  targetUtilization: number;
  /** Recommended request weight relative to peers (0..1). */
  requestWeight: number;
  /** Recommended backoff in ms when under stress. */
  backoffMs: number;
  /** Confidence in the strategy (0..1). */
  confidence: number;
  /** Number of samples the strategy was derived from. */
  sampleCount: number;
}

/**
 * A decentralized load-balancing recommendation for a single meter.
 */
export interface LoadBalancingRecommendation {
  pseudonym: string;
  /** Share of traffic this meter should accept (0..1). */
  trafficShare: number;
  /** Whether the meter should shed load. */
  shedLoad: boolean;
  /** Suggested delay before accepting new work, in ms. */
  delayMs: number;
  /** Reason for the recommendation (for observability). */
  reason: string;
}

/**
 * Aggregate snapshot of the swarm's collective state.
 */
export interface SwarmSnapshot {
  strategy: SwarmStrategy;
  recommendations: LoadBalancingRecommendation[];
  /** Overall network pressure indicator (0..1). */
  networkPressure: number;
  /** Timestamp of the snapshot. */
  timestamp: number;
}

/**
 * Network conditions used to adapt swarm behavior.
 */
export interface NetworkConditions {
  /** Observed network-wide latency in ms. */
  latencyMs: number;
  /** Observed network-wide error rate (0..1). */
  errorRate: number;
  /** Observed network-wide utilization (0..1). */
  utilization: number;
}

// ---------------------------------------------------------------------------
// Privacy helpers
// ---------------------------------------------------------------------------

/**
 * Produce a stable, non-reversible pseudonym for a meter id.
 * Uses a salted hash so raw ids never leave the meter.
 */
export function anonymizeMeterId(meterId: string, salt = 'swarm-v1'): string {
  return createHash('sha256').update(`${salt}:${meterId}`).digest('hex').slice(0, 16);
}

/**
 * Convert a raw sample into an anonymized sample suitable for sharing.
 */
export function anonymizeSample(sample: MeterPerformanceSample): AnonymizedSample {
  return {
    pseudonym: anonymizeMeterId(sample.meterId),
    throughput: clamp(sample.throughput, 0, Number.MAX_SAFE_INTEGER),
    latencyMs: clamp(sample.latencyMs, 0, Number.MAX_SAFE_INTEGER),
    utilization: clamp(sample.utilization, 0, 1),
    errorRate: clamp(sample.errorRate, 0, 1),
    timestamp: sample.timestamp,
  };
}

// ---------------------------------------------------------------------------
// Collective learning
// ---------------------------------------------------------------------------

const DEFAULT_STRATEGY: SwarmStrategy = {
  targetUtilization: 0.7,
  requestWeight: 1,
  backoffMs: 0,
  confidence: 0,
  sampleCount: 0,
};

/**
 * Collectively learn an optimal strategy from anonymized samples.
 *
 * The algorithm is a weighted, exponentially-decayed aggregation:
 *  - Recent samples weigh more than old ones.
 *  - Samples with lower error rates and latency weigh more (they represent
 *    healthier operating points).
 *  - The swarm converges on a target utilization that balances throughput
 *    against error/latency pressure.
 */
export function learnStrategy(
  samples: AnonymizedSample[],
  now: number = Date.now(),
  halfLifeMs = 60_000,
): SwarmStrategy {
  if (samples.length === 0) {
    return { ...DEFAULT_STRATEGY };
  }

  let weightSum = 0;
  let utilSum = 0;
  let latencySum = 0;
  let errorSum = 0;
  let throughputSum = 0;

  for (const s of samples) {
    const age = Math.max(0, now - s.timestamp);
    const recency = Math.pow(0.5, age / halfLifeMs);
    // Health weight: penalize high error and high latency.
    const health = (1 - s.errorRate) / (1 + s.latencyMs / 1000);
    const weight = recency * Math.max(health, 0.01);

    weightSum += weight;
    utilSum += s.utilization * weight;
    latencySum += s.latencyMs * weight;
    errorSum += s.errorRate * weight;
    throughputSum += s.throughput * weight;
  }

  if (weightSum === 0) {
    return { ...DEFAULT_STRATEGY };
  }

  const avgUtil = utilSum / weightSum;
  const avgLatency = latencySum / weightSum;
  const avgError = errorSum / weightSum;
  const avgThroughput = throughputSum / weightSum;

  // Converge on a target utilization: pull toward the healthy operating
  // point observed by the swarm, but never above a safety ceiling.
  const safetyCeiling = 0.85;
  const pressure = clamp(avgError * 2 + avgLatency / 1000, 0, 1);
  const targetUtilization = clamp(
    avgUtil * (1 - pressure * 0.3),
    0.1,
    safetyCeiling,
  );

  // Request weight scales with healthy throughput relative to latency.
  const requestWeight = clamp(
    avgThroughput / (1 + avgLatency / 100),
    0,
    1,
  );

  // Backoff grows with observed pressure.
  const backoffMs = Math.round(pressure * 500);

  // Confidence grows with sample count and decreases with variance proxy.
  const confidence = clamp(
    (1 - pressure) * Math.min(1, samples.length / 20),
    0,
    1,
  );

  return {
    targetUtilization,
    requestWeight,
    backoffMs,
    confidence,
    sampleCount: samples.length,
  };
}

// ---------------------------------------------------------------------------
// Decentralized load balancing
// ---------------------------------------------------------------------------

/**
 * Compute decentralized load-balancing recommendations.
 *
 * Each meter independently derives its own recommendation from the shared
 * strategy and its own local sample. No central coordinator is required:
 * the same inputs always yield the same recommendation, so the swarm
 * converges without explicit orchestration.
 */
export function computeLoadBalancing(
  samples: AnonymizedSample[],
  strategy: SwarmStrategy,
): LoadBalancingRecommendation[] {
  if (samples.length === 0) {
    return [];
  }

  // Inverse-pressure weighting: healthier meters get more traffic.
  const weights = samples.map((s) => {
    const health = (1 - s.errorRate) / (1 + s.latencyMs / 1000);
    return Math.max(health, 0.01);
  });
  const totalWeight = weights.reduce((a, b) => a + b, 0);

  return samples.map((s, i) => {
    const trafficShare = totalWeight > 0 ? weights[i] / totalWeight : 1 / samples.length;
    const overTarget = s.utilization > strategy.targetUtilization;
    const shedLoad = overTarget || s.errorRate > 0.1;

    let delayMs = 0;
    let reason = 'balanced';
    if (shedLoad) {
      const excess = Math.max(0, s.utilization - strategy.targetUtilization);
      delayMs = Math.round(strategy.backoffMs * (1 + excess));
      reason = overTarget ? 'over-target-utilization' : 'high-error-rate';
    } else if (s.utilization < strategy.targetUtilization * 0.5) {
      reason = 'under-utilized';
    }

    return {
      pseudonym: s.pseudonym,
      trafficShare,
      shedLoad,
      delayMs,
      reason,
    };
  });
}

// ---------------------------------------------------------------------------
// Adaptive response
// ---------------------------------------------------------------------------

/**
 * Adapt a strategy to current network conditions.
 *
 * When the network is under stress (high latency/errors/utilization), the
 * swarm becomes more conservative: lower target utilization, more backoff,
 * and reduced request weight.
 */
export function adaptToNetwork(
  strategy: SwarmStrategy,
  conditions: NetworkConditions,
): SwarmStrategy {
  const pressure = clamp(
    conditions.errorRate * 2 +
      conditions.latencyMs / 1000 +
      Math.max(0, conditions.utilization - 0.7),
    0,
    1,
  );

  return {
    targetUtilization: clamp(
      strategy.targetUtilization * (1 - pressure * 0.4),
      0.1,
      0.85,
    ),
    requestWeight: clamp(strategy.requestWeight * (1 - pressure * 0.5), 0, 1),
    backoffMs: Math.round(strategy.backoffMs + pressure * 1000),
    confidence: strategy.confidence,
    sampleCount: strategy.sampleCount,
  };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Run one swarm cycle: anonymize, learn, adapt, and recommend.
 */
export function runSwarmCycle(
  rawSamples: MeterPerformanceSample[],
  conditions: NetworkConditions,
  now: number = Date.now(),
): SwarmSnapshot {
  const anonymized = rawSamples.map(anonymizeSample);
  const learned = learnStrategy(anonymized, now);
  const adapted = adaptToNetwork(learned, conditions);
  const recommendations = computeLoadBalancing(anonymized, adapted);

  const networkPressure = clamp(
    conditions.errorRate * 2 +
      conditions.latencyMs / 1000 +
      Math.max(0, conditions.utilization - 0.7),
    0,
    1,
  );

  return {
    strategy: adapted,
    recommendations,
    networkPressure,
    timestamp: now,
  };
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}