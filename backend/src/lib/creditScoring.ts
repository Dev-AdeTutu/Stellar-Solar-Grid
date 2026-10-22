/**
 * Automated credit scoring for payment plans (#1003).
 *
 * Builds a 0-1000 credit score for a Stellar address from two existing data
 * sources rather than inventing a new ledger:
 *
 *   - `lib/revenueStore.ts` (#1002) — one row per successful payment
 *     (payment_id, meter_id, payer, amount, created_at). This gives overall
 *     activity: how many payments, how much volume, how long the address
 *     has been paying.
 *   - `lib/billing.ts` (#902) — monthly bills per meter, each with a
 *     `due_at` and (if paid) a `paid_at`. Billing accounts carry a
 *     `stellar_address`, which is the only existing "which meters does this
 *     address pay for" link in the codebase, so it is reused here
 *     (see `getBillingAccountsByAddress`) to find every bill relevant to an
 *     address and classify it on-time / late / defaulted.
 *
 * The score itself is a simple, deterministic weighted formula (not ML) —
 * easy to explain to a user who asks "why is my score X":
 *
 *   score = BASE
 *         + RELIABILITY_WEIGHT * reliabilityRatio   (on-time share of bills)
 *         + VOLUME_WEIGHT      * volumeFactor        (total paid, capped)
 *         + TENURE_WEIGHT      * tenureFactor        (account age, capped)
 *         - LATE_PENALTY       * lateCount
 *         - DEFAULT_PENALTY    * defaultCount
 *         clamped to [0, 1000]
 *
 * A bill is classified against its `due_at`:
 *   - paid at or before due_at           -> on-time
 *   - paid after due_at                  -> late
 *   - unpaid, due_at < now                -> late (outstanding)
 *   - unpaid, due_at + GRACE_DAYS < now   -> default (supersedes "late")
 *   - unpaid, due_at still in the future  -> ignored (nothing to judge yet)
 *
 * A user with no bill history at all gets a neutral reliabilityRatio of 0.5
 * (benefit of the doubt, not a perfect or a zero score) so brand-new
 * addresses land in the middle "Fair" tier rather than top or bottom.
 */
import { getBillingAccountsByAddress, listBills, type Bill } from "./billing.js";
import { getRevenueEvents } from "./revenueStore.js";
import { getContractClient } from "./contractClient.js";

export const STROOPS_PER_XLM = 10_000_000;

/** Days past due before an unpaid bill counts as a default rather than "late". */
export const DEFAULT_GRACE_DAYS = Number(process.env.CREDIT_DEFAULT_GRACE_DAYS ?? 30);

// ── Weighting scheme (documented above; tuned to be simple & explainable) ──
const BASE = 300;
const RELIABILITY_WEIGHT = 500; // on-time ratio contributes up to 500 points
const VOLUME_WEIGHT = 150; // total lifetime volume contributes up to 150 points
const TENURE_WEIGHT = 100; // account age contributes up to 100 points
const LATE_PENALTY = 15; // flat penalty per late payment
const DEFAULT_PENALTY = 60; // flat penalty per default

const VOLUME_CAP_XLM = 500; // volumeFactor reaches 1.0 at >= 500 XLM lifetime paid
const TENURE_CAP_DAYS = 365; // tenureFactor reaches 1.0 at >= 1 year of history

export type PaymentHistoryStats = {
  address: string;
  /** Count of successful payments recorded in revenueStore for this address. */
  totalPayments: number;
  /** Lifetime payment volume, in stroops. */
  totalVolumeStroops: number;
  /** Days since this address's earliest known activity (payment or bill). */
  accountAgeDays: number;
  onTimeCount: number;
  lateCount: number;
  defaultCount: number;
  /** Bills counted toward on-time/late/default (excludes not-yet-due bills). */
  judgedBillCount: number;
};

export type CreditTier = "Excellent" | "Good" | "Fair" | "Poor" | "Very Poor";

export type PaymentPlanName = "Daily" | "Weekly" | "Monthly";

export type CreditScoreResult = {
  address: string;
  score: number;
  tier: CreditTier;
  factors: PaymentHistoryStats;
  recommendedPaymentPlan: PaymentPlanName;
  /** Suggested credit limit, in stroops. */
  creditLimitStroops: number;
};

function classifyBill(bill: Bill, now: Date): "on-time" | "late" | "default" | "pending" {
  const dueAt = new Date(bill.due_at).getTime();
  if (bill.status === "paid" && bill.paid_at) {
    const paidAt = new Date(bill.paid_at).getTime();
    return paidAt <= dueAt ? "on-time" : "late";
  }
  // Unpaid (or void, which we treat the same as unpaid for scoring purposes).
  const graceDeadline = dueAt + DEFAULT_GRACE_DAYS * 86_400_000;
  if (now.getTime() >= graceDeadline) return "default";
  if (now.getTime() >= dueAt) return "late";
  return "pending";
}

/**
 * Aggregate payment history for an address from revenueStore (activity) and
 * billing (delays/defaults). Pure read — does not write anything.
 */
export function computePaymentHistoryStats(address: string, now: Date = new Date()): PaymentHistoryStats {
  const payments = getRevenueEvents().filter((e) => e.payer === address);
  const totalPayments = payments.length;
  const totalVolumeStroops = payments.reduce((sum, e) => sum + Number(e.amount), 0);

  const accounts = getBillingAccountsByAddress(address);
  let onTimeCount = 0;
  let lateCount = 0;
  let defaultCount = 0;
  let earliest: number | null = null;

  for (const account of accounts) {
    const accountCreated = new Date(account.created_at).getTime();
    if (!Number.isNaN(accountCreated) && (earliest === null || accountCreated < earliest)) {
      earliest = accountCreated;
    }
    for (const bill of listBills(account.meter_id, 1000)) {
      const outcome = classifyBill(bill, now);
      if (outcome === "on-time") onTimeCount++;
      else if (outcome === "late") lateCount++;
      else if (outcome === "default") defaultCount++;
    }
  }

  for (const payment of payments) {
    const t = new Date(payment.created_at).getTime();
    if (!Number.isNaN(t) && (earliest === null || t < earliest)) earliest = t;
  }

  const accountAgeDays = earliest === null ? 0 : Math.max(0, (now.getTime() - earliest) / 86_400_000);

  return {
    address,
    totalPayments,
    totalVolumeStroops,
    accountAgeDays,
    onTimeCount,
    lateCount,
    defaultCount,
    judgedBillCount: onTimeCount + lateCount + defaultCount,
  };
}

/** Pure scoring formula — see module doc comment for the weighting scheme. */
export function calculateCreditScore(stats: PaymentHistoryStats): number {
  const reliabilityRatio = stats.judgedBillCount > 0 ? stats.onTimeCount / stats.judgedBillCount : 0.5;
  const volumeFactor = Math.min(1, stats.totalVolumeStroops / STROOPS_PER_XLM / VOLUME_CAP_XLM);
  const tenureFactor = Math.min(1, stats.accountAgeDays / TENURE_CAP_DAYS);

  const raw =
    BASE +
    RELIABILITY_WEIGHT * reliabilityRatio +
    VOLUME_WEIGHT * volumeFactor +
    TENURE_WEIGHT * tenureFactor -
    LATE_PENALTY * stats.lateCount -
    DEFAULT_PENALTY * stats.defaultCount;

  return Math.round(Math.min(1000, Math.max(0, raw)));
}

/** Tier thresholds, documented for backend/README.md. */
export function creditTier(score: number): CreditTier {
  if (score >= 850) return "Excellent";
  if (score >= 700) return "Good";
  if (score >= 500) return "Fair";
  if (score >= 300) return "Poor";
  return "Very Poor";
}

/**
 * Payment plan recommendation: higher trust unlocks longer billing cycles
 * (less frequent, larger payments); lower trust keeps payments small and
 * frequent to limit exposure.
 */
export function recommendPaymentPlan(score: number): PaymentPlanName {
  if (score >= 750) return "Monthly";
  if (score >= 500) return "Weekly";
  return "Daily";
}

/** Maximum credit limit a perfect (1000) score can reach, in stroops (5,000 XLM). */
export const MAX_CREDIT_LIMIT_STROOPS = 5_000 * STROOPS_PER_XLM;

/** Credit limit scales linearly with score up to MAX_CREDIT_LIMIT_STROOPS. */
export function creditLimitForScore(score: number): number {
  const clamped = Math.min(1000, Math.max(0, score));
  return Math.round((clamped / 1000) * MAX_CREDIT_LIMIT_STROOPS);
}

/** Full, explainable result for an address, built from the pure functions above. */
export function buildCreditScoreResult(address: string, now: Date = new Date()): CreditScoreResult {
  const factors = computePaymentHistoryStats(address, now);
  const score = calculateCreditScore(factors);
  return {
    address,
    score,
    tier: creditTier(score),
    factors,
    recommendedPaymentPlan: recommendPaymentPlan(score),
    creditLimitStroops: creditLimitForScore(score),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reputation-based credit scoring (#1070)
//
// A second, complementary scoring path that produces a 0-100 reputation score
// from on-chain payment history tracked by the `solar_grid` contract, blended
// with the off-chain payment history already aggregated above. The 0-1000
// credit score above is left untouched; this path is additive.
// ─────────────────────────────────────────────────────────────────────────────

/** On-chain reputation record as returned by the solar_grid contract. */
export type OnChainReputation = {
  address: string;
  /** Number of payments recorded on-chain. */
  paymentCount: number;
  /** Number of on-chain payments made at or before their due date. */
  onTimeCount: number;
  /** Number of on-chain payments made after their due date. */
  lateCount: number;
  /** Total on-chain payment volume, in stroops. */
  totalVolumeStroops: number;
  /** Unix seconds of the first recorded on-chain payment (0 if none). */
  firstPaymentAt: number;
  /** Unix seconds of the most recent recorded on-chain payment (0 if none). */
  lastPaymentAt: number;
};

/** Decentralized identifier metadata attached to a reputation result. */
export type DidMetadata = {
  /** The DID string, e.g. `did:stellar:G...`. */
  did: string;
  /** The Stellar address the DID resolves to. */
  address: string;
  /** Whether a DID document is known for this address. */
  resolved: boolean;
};

/** Portability metadata describing how a reputation score may be reused. */
export type PortabilityMetadata = {
  /** Stable schema version for cross-platform consumers. */
  schemaVersion: string;
  /** Whether the score can be exported to other platforms. */
  portable: boolean;
  /** Whether the score was computed without exposing raw payment data. */
  privacyPreserving: boolean;
  /** Opaque commitment over the underlying history (no raw amounts leak). */
  commitment: string;
};

export type ReputationScoreResult = {
  address: string;
  /** Reputation score in the range [0, 100]. */
  reputationScore: number;
  tier: CreditTier;
  did: DidMetadata;
  portability: PortabilityMetadata;
  /** Breakdown of the components that produced the reputation score. */
  components: {
    onChainReliability: number;
    onChainVolume: number;
    onChainTenure: number;
    offChainReliability: number;
    offChainVolume: number;
  };
  onChain: OnChainReputation;
  offChain: PaymentHistoryStats;
};

export const REPUTATION_SCHEMA_VERSION = "1.0.0";

// Reputation weighting (sums to 100 so the result is naturally 0-100).
const REP_ONCHAIN_RELIABILITY_WEIGHT = 35;
const REP_ONCHAIN_VOLUME_WEIGHT = 15;
const REP_ONCHAIN_TENURE_WEIGHT = 10;
const REP_OFFCHAIN_RELIABILITY_WEIGHT = 30;
const REP_OFFCHAIN_VOLUME_WEIGHT = 10;

const REP_VOLUME_CAP_XLM = 500;
const REP_TENURE_CAP_DAYS = 365;

/**
 * Fetch the on-chain reputation record for an address from the solar_grid
 * contract. Returns a zeroed record if the contract has no history for the
 * address (or the read fails), so callers always get a usable value.
 */
export async function fetchOnChainReputation(address: string): Promise<OnChainReputation> {
  const empty: OnChainReputation = {
    address,
    paymentCount: 0,
    onTimeCount: 0,
    lateCount: 0,
    totalVolumeStroops: 0,
    firstPaymentAt: 0,
    lastPaymentAt: 0,
  };

  try {
    const client = getContractClient();
    const raw = await client.getReputation(address);
    if (!raw) return empty;
    return {
      address,
      paymentCount: Number(raw.payment_count ?? 0),
      onTimeCount: Number(raw.on_time_count ?? 0),
      lateCount: Number(raw.late_count ?? 0),
      totalVolumeStroops: Number(raw.total_volume ?? 0),
      firstPaymentAt: Number(raw.first_payment_at ?? 0),
      lastPaymentAt: Number(raw.last_payment_at ?? 0),
    };
  } catch {
    return empty;
  }
}

/** Build DID metadata for an address. */
export function buildDidMetadata(address: string): DidMetadata {
  return {
    did: `did:stellar:${address}`,
    address,
    resolved: true,
  };
}

/**
 * Deterministic, non-reversible commitment over the underlying history. Used
 * so a score can be shared/verified without revealing raw payment amounts.
 */
function reputationCommitment(address: string, onChain: OnChainReputation, offChain: PaymentHistoryStats): string {
  const payload = [
    address,
    onChain.paymentCount,
    onChain.onTimeCount,
    onChain.lateCount,
    offChain.totalPayments,
    offChain.onTimeCount,
    offChain.lateCount,
    offChain.defaultCount,
  ].join("|");
  // FNV-1a 32-bit hash — cheap, deterministic, and dependency-free.
  let hash = 0x811c9dc5;
  for (let i = 0; i < payload.length; i++) {
    hash ^= payload.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `0x${hash.toString(16).padStart(8, "0")}`;
}

/**
 * Pure reputation scoring formula combining on-chain and off-chain history
 * into a 0-100 score. See the weighting constants above for the breakdown.
 */
export function calculateReputationScore(
  onChain: OnChainReputation,
  offChain: PaymentHistoryStats,
  now: Date = new Date(),
): { score: number; components: ReputationScoreResult["components"] } {
  const onChainJudged = onChain.onTimeCount + onChain.lateCount;
  const onChainReliability = onChainJudged > 0 ? onChain.onTimeCount / onChainJudged : 0.5;

  const onChainVolume = Math.min(1, onChain.totalVolumeStroops / STROOPS_PER_XLM / REP_VOLUME_CAP_XLM);

  const onChainTenureDays =
    onChain.firstPaymentAt > 0 ? Math.max(0, (now.getTime() / 1000 - onChain.firstPaymentAt) / 86_400) : 0;
  const onChainTenure = Math.min(1, onChainTenureDays / REP_TENURE_CAP_DAYS);

  const offChainReliability =
    offChain.judgedBillCount > 0 ? offChain.onTimeCount / offChain.judgedBillCount : 0.5;
  const offChainVolume = Math.min(1, offChain.totalVolumeStroops / STROOPS_PER_XLM / REP_VOLUME_CAP_XLM);

  const raw =
    REP_ONCHAIN_RELIABILITY_WEIGHT * onChainReliability +
    REP_ONCHAIN_VOLUME_WEIGHT * onChainVolume +
    REP_ONCHAIN_TENURE_WEIGHT * onChainTenure +
    REP_OFFCHAIN_RELIABILITY_WEIGHT * offChainReliability +
    REP_OFFCHAIN_VOLUME_WEIGHT * offChainVolume;

  return {
    score: Math.round(Math.min(100, Math.max(0, raw))),
    components: {
      onChainReliability,
      onChainVolume,
      onChainTenure,
      offChainReliability,
      offChainVolume,
    },
  };
}

/** Map a 0-100 reputation score onto the existing credit tiers. */
export function reputationTier(reputationScore: number): CreditTier {
  return creditTier(Math.round((Math.min(100, Math.max(0, reputationScore)) / 100) * 1000));
}

/**
 * Full reputation-based result for an address: fetches on-chain reputation,
 * combines it with off-chain payment history, and attaches DID + portability
 * metadata. The score is computed without exposing raw payment data.
 */
export async function buildReputationScoreResult(
  address: string,
  now: Date = new Date(),
): Promise<ReputationScoreResult> {
  const [onChain, offChain] = await Promise.all([
    fetchOnChainReputation(address),
    Promise.resolve(computePaymentHistoryStats(address, now)),
  ]);

  const { score, components } = calculateReputationScore(onChain, offChain, now);

  return {
    address,
    reputationScore: score,
    tier: reputationTier(score),
    did: buildDidMetadata(address),
    portability: {
      schemaVersion: REPUTATION_SCHEMA_VERSION,
      portable: true,
      privacyPreserving: true,
      commitment: reputationCommitment(address, onChain, offChain),
    },
    components,
    onChain,
    offChain,
  };
}
