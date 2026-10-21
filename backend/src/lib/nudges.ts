import { randomUUID } from 'crypto';

export type NudgeChannel = 'push' | 'email';

export type NudgeStrategy =
  | 'social_comparison'
  | 'loss_aversion'
  | 'default_option'
  | 'commitment';

export interface NeighborAggregate {
  /** Average usage of comparable neighbors in kWh over the comparison window. */
  averageUsageKwh: number;
  /** Number of neighbors included in the aggregate. */
  sampleSize: number;
  /** Optional window label, e.g. "last 30 days". */
  windowLabel?: string;
}

export interface UserUsage {
  userId: string;
  /** User's usage in kWh over the same comparison window. */
  usageKwh: number;
}

export interface CreditBalance {
  userId: string;
  /** Current credit balance in credits. */
  balance: number;
  /** Credits that could be lost if the user does not act. */
  atRiskCredits?: number;
}

export interface CommitmentPledge {
  id: string;
  userId: string;
  /** Target reduction as a fraction of baseline usage, e.g. 0.1 for 10%. */
  targetReductionPct: number;
  /** ISO timestamp when the pledge was made. */
  createdAt: string;
  /** ISO timestamp when the pledge expires. */
  expiresAt: string;
  /** Baseline usage in kWh used to evaluate the pledge. */
  baselineUsageKwh: number;
  status: 'active' | 'fulfilled' | 'failed' | 'expired';
}

export interface NudgeMessage {
  id: string;
  userId: string;
  strategy: NudgeStrategy;
  channel: NudgeChannel;
  title: string;
  body: string;
  /** Optional call-to-action label. */
  cta?: string;
  /** Structured metadata for analytics. */
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface NudgeDelivery {
  id: string;
  messageId: string;
  userId: string;
  channel: NudgeChannel;
  deliveredAt: string;
  /** Whether the delivery was acknowledged by the channel provider. */
  success: boolean;
  error?: string;
}

export interface AbTestConfig {
  /** Stable experiment name used for deterministic bucketing. */
  experimentName: string;
  /** Strategies to test, keyed by variant name. */
  variants: Record<string, NudgeStrategy>;
  /** Fraction of users in each variant; must sum to 1. */
  weights?: Record<string, number>;
}

export interface AbAssignment {
  experimentName: string;
  variant: string;
  strategy: NudgeStrategy;
}

export interface ImpactMeasurement {
  userId: string;
  strategy: NudgeStrategy;
  preUsageKwh: number;
  postUsageKwh: number;
  /** Absolute change in kWh (post - pre). Negative means reduction. */
  absoluteChangeKwh: number;
  /** Relative change as a fraction (post - pre) / pre. Negative means reduction. */
  relativeChange: number;
  /** Whether usage decreased. */
  improved: boolean;
}

export interface NudgeEngineOptions {
  /** Injectable clock for deterministic testing. */
  now?: () => Date;
  /** Injectable delivery transport. */
  transport?: NudgeTransport;
}

export interface NudgeTransport {
  push(message: NudgeMessage): Promise<{ success: boolean; error?: string }>;
  email(message: NudgeMessage): Promise<{ success: boolean; error?: string }>;
}

const DEFAULT_WEIGHTS: Record<string, number> = {};

/**
 * Deterministic hash used for A/B bucketing. Produces a stable value in [0, 1).
 */
export function hashToUnitInterval(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  // Convert to unsigned and normalize.
  return (hash >>> 0) / 4294967296;
}

export class BehavioralNudgeEngine {
  private readonly now: () => Date;
  private readonly transport: NudgeTransport;
  private readonly deliveries: NudgeDelivery[] = [];
  private readonly pledges = new Map<string, CommitmentPledge>();

  constructor(options: NudgeEngineOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.transport = options.transport ?? defaultTransport;
  }

  /**
   * Deterministically assign a user to an A/B variant for the given experiment.
   */
  assignVariant(userId: string, config: AbTestConfig): AbAssignment {
    const variantNames = Object.keys(config.variants);
    if (variantNames.length === 0) {
      throw new Error('A/B test must define at least one variant');
    }

    const weights = config.weights ?? DEFAULT_WEIGHTS;
    const hasWeights = variantNames.some((v) => weights[v] !== undefined);

    if (hasWeights) {
      const total = variantNames.reduce((sum, v) => sum + (weights[v] ?? 0), 0);
      if (Math.abs(total - 1) > 1e-6) {
        throw new Error('A/B test weights must sum to 1');
      }
    }

    const bucket = hashToUnitInterval(`${config.experimentName}:${userId}`);

    if (!hasWeights) {
      const index = Math.min(
        variantNames.length - 1,
        Math.floor(bucket * variantNames.length),
      );
      const variant = variantNames[index];
      return {
        experimentName: config.experimentName,
        variant,
        strategy: config.variants[variant],
      };
    }

    let cumulative = 0;
    for (const variant of variantNames) {
      cumulative += weights[variant] ?? 0;
      if (bucket < cumulative) {
        return {
          experimentName: config.experimentName,
          variant,
          strategy: config.variants[variant],
        };
      }
    }

    const last = variantNames[variantNames.length - 1];
    return {
      experimentName: config.experimentName,
      variant: last,
      strategy: config.variants[last],
    };
  }

  /**
   * Build a social comparison nudge comparing the user's usage to neighbors.
   */
  buildSocialComparisonNudge(
    user: UserUsage,
    neighbors: NeighborAggregate,
    channel: NudgeChannel = 'push',
  ): NudgeMessage {
    if (neighbors.sampleSize <= 0) {
      throw new Error('Neighbor aggregate must include at least one neighbor');
    }

    const windowLabel = neighbors.windowLabel ?? 'the last 30 days';
    const diffPct =
      neighbors.averageUsageKwh > 0
        ? ((user.usageKwh - neighbors.averageUsageKwh) /
            neighbors.averageUsageKwh) *
          100
        : 0;

    let title: string;
    let body: string;

    if (diffPct > 0) {
      const rounded = Math.round(diffPct);
      title = 'You are using more energy than your neighbors';
      body = `Over ${windowLabel}, you used about ${rounded}% more energy than similar neighbors. Small changes can bring you in line with the pack.`;
    } else if (diffPct < 0) {
      const rounded = Math.abs(Math.round(diffPct));
      title = 'You are beating your neighbors on energy use';
      body = `Over ${windowLabel}, you used about ${rounded}% less energy than similar neighbors. Keep up the great work!`;
    } else {
      title = 'You are right on par with your neighbors';
      body = `Over ${windowLabel}, your energy use matched similar neighbors. A small reduction could put you ahead.`;
    }

    return this.createMessage({
      userId: user.userId,
      strategy: 'social_comparison',
      channel,
      title,
      body,
      cta: 'See saving tips',
      metadata: {
        userUsageKwh: user.usageKwh,
        neighborAverageKwh: neighbors.averageUsageKwh,
        neighborSampleSize: neighbors.sampleSize,
        differencePct: diffPct,
        windowLabel,
      },
    });
  }

  /**
   * Build a loss-aversion nudge framing credits as something the user may lose.
   */
  buildLossAversionNudge(
    credits: CreditBalance,
    channel: NudgeChannel = 'push',
  ): NudgeMessage {
    const atRisk = credits.atRiskCredits ?? Math.max(0, credits.balance);
    const title = 'Do not lose your energy credits';
    const body =
      atRisk > 0
        ? `You have ${atRisk} credits at risk. Take a saving action today to keep them from expiring.`
        : `You currently have ${credits.balance} credits. Keep saving energy to protect your balance.`;

    return this.createMessage({
      userId: credits.userId,
      strategy: 'loss_aversion',
      channel,
      title,
      body,
      cta: 'Protect my credits',
      metadata: {
        balance: credits.balance,
        atRiskCredits: atRisk,
      },
    });
  }

  /**
   * Build a default-option nudge that promotes saving by pre-selecting a saving action.
   */
  buildDefaultOptionNudge(
    userId: string,
    channel: NudgeChannel = 'push',
  ): NudgeMessage {
    return this.createMessage({
      userId,
      strategy: 'default_option',
      channel,
      title: 'Your energy-saving plan is ready',
      body: 'We have pre-selected a simple saving plan for you: shift heavy usage off-peak and set your thermostat 1 degree lower. It is already active unless you change it.',
      cta: 'Review my plan',
      metadata: {
        defaultAction: 'off_peak_shift_and_thermostat',
        optOutAvailable: true,
      },
    });
  }

  /**
   * Create a commitment pledge for the user.
   */
  createPledge(params: {
    userId: string;
    targetReductionPct: number;
    baselineUsageKwh: number;
    durationDays?: number;
  }): CommitmentPledge {
    if (params.targetReductionPct <= 0 || params.targetReductionPct >= 1) {
      throw new Error('targetReductionPct must be between 0 and 1');
    }
    if (params.baselineUsageKwh <= 0) {
      throw new Error('baselineUsageKwh must be positive');
    }

    const createdAt = this.now();
    const durationDays = params.durationDays ?? 30;
    const expiresAt = new Date(
      createdAt.getTime() + durationDays * 24 * 60 * 60 * 1000,
    );

    const pledge: CommitmentPledge = {
      id: randomUUID(),
      userId: params.userId,
      targetReductionPct: params.targetReductionPct,
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      baselineUsageKwh: params.baselineUsageKwh,
      status: 'active',
    };

    this.pledges.set(pledge.id, pledge);
    return pledge;
  }

  /**
   * Build a commitment-device nudge referencing an existing pledge.
   */
  buildCommitmentNudge(
    pledge: CommitmentPledge,
    channel: NudgeChannel = 'push',
  ): NudgeMessage {
    const targetPct = Math.round(pledge.targetReductionPct * 100);
    return this.createMessage({
      userId: pledge.userId,
      strategy: 'commitment',
      channel,
      title: 'You pledged to save energy',
      body: `You committed to reducing your usage by ${targetPct}%. Keep your pledge on track and check your progress before it expires.`,
      cta: 'Check my progress',
      metadata: {
        pledgeId: pledge.id,
        targetReductionPct: pledge.targetReductionPct,
        expiresAt: pledge.expiresAt,
      },
    });
  }

  /**
   * Evaluate a pledge against post-period usage.
   */
  evaluatePledge(pledge: CommitmentPledge, postUsageKwh: number): CommitmentPledge {
    const targetUsage = pledge.baselineUsageKwh * (1 - pledge.targetReductionPct);
    const fulfilled = postUsageKwh <= targetUsage;
    const updated: CommitmentPledge = {
      ...pledge,
      status: fulfilled ? 'fulfilled' : 'failed',
    };
    this.pledges.set(pledge.id, updated);
    return updated;
  }

  /**
   * Deliver a nudge message through the configured transport and record it.
   */
  async deliver(message: NudgeMessage): Promise<NudgeDelivery> {
    let result: { success: boolean; error?: string };
    try {
      if (message.channel === 'email') {
        result = await this.transport.email(message);
      } else {
        result = await this.transport.push(message);
      }
    } catch (err) {
      result = {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    const delivery: NudgeDelivery = {
      id: randomUUID(),
      messageId: message.id,
      userId: message.userId,
      channel: message.channel,
      deliveredAt: this.now().toISOString(),
      success: result.success,
      error: result.error,
    };
    this.deliveries.push(delivery);
    return delivery;
  }

  /**
   * Return recorded deliveries, optionally filtered by user.
   */
  getDeliveries(userId?: string): NudgeDelivery[] {
    if (!userId) {
      return [...this.deliveries];
    }
    return this.deliveries.filter((d) => d.userId === userId);
  }

  /**
   * Measure behavior change impact by comparing pre and post usage.
   */
  measureImpact(params: {
    userId: string;
    strategy: NudgeStrategy;
    preUsageKwh: number;
    postUsageKwh: number;
  }): ImpactMeasurement {
    const { userId, strategy, preUsageKwh, postUsageKwh } = params;
    const absoluteChangeKwh = postUsageKwh - preUsageKwh;
    const relativeChange =
      preUsageKwh > 0 ? absoluteChangeKwh / preUsageKwh : 0;

    return {
      userId,
      strategy,
      preUsageKwh,
      postUsageKwh,
      absoluteChangeKwh,
      relativeChange,
      improved: absoluteChangeKwh < 0,
    };
  }

  private createMessage(params: {
    userId: string;
    strategy: NudgeStrategy;
    channel: NudgeChannel;
    title: string;
    body: string;
    cta?: string;
    metadata: Record<string, unknown>;
  }): NudgeMessage {
    return {
      id: randomUUID(),
      userId: params.userId,
      strategy: params.strategy,
      channel: params.channel,
      title: params.title,
      body: params.body,
      cta: params.cta,
      metadata: params.metadata,
      createdAt: this.now().toISOString(),
    };
  }
}

const defaultTransport: NudgeTransport = {
  async push() {
    return { success: true };
  },
  async email() {
    return { success: true };
  },
};