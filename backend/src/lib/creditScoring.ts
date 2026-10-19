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
