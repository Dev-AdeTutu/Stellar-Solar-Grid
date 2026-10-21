/**
 * Tests for automated credit scoring (#1003).
 *
 * Uses dedicated on-disk sqlite files in a temp dir for billing/revenue
 * store isolation (same approach as emergencyContacts.test.ts), set via env
 * vars before the modules under test are imported.
 */
import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as StellarSdk from "@stellar/stellar-sdk";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "credit-scoring-"));
// billing.ts (transitively) imports lib/stellar.ts, which eagerly builds a
// StellarService singleton from ADMIN_SECRET_KEY at module load — needs a
// syntactically valid (if unused) keypair in the test environment.
process.env.ADMIN_SECRET_KEY ??= StellarSdk.Keypair.random().secret();
process.env.BILLING_DB_PATH = path.join(tmpDir, "billing.sqlite");
process.env.REVENUE_EVENTS_DB_PATH = path.join(tmpDir, "revenue-events.sqlite");
process.env.CREDIT_OVERRIDES_DB_PATH = path.join(tmpDir, "credit-overrides.sqlite");
process.env.BILLING_PDF_DIR = path.join(tmpDir, "bills");
process.env.BILLING_DUE_DAYS = "14";

const { upsertBillingAccount, generateBill, markBillPaid } = await import("./billing.js");
const { recordRevenueEvent, closeRevenueStore } = await import("./revenueStore.js");
const {
  calculateCreditScore,
  computePaymentHistoryStats,
  buildCreditScoreResult,
  creditTier,
  recommendPaymentPlan,
  creditLimitForScore,
  MAX_CREDIT_LIMIT_STROOPS,
  STROOPS_PER_XLM,
} = await import("./creditScoring.js");
const {
  setCreditOverride,
  getActiveCreditOverride,
  clearCreditOverride,
  closeCreditOverridesStore,
} = await import("./creditOverrides.js");

afterAll(() => {
  closeRevenueStore();
  closeCreditOverridesStore();
  // billing.ts has no exported close(); on Windows the sqlite file handle can
  // still be releasing when cleanup runs, so tolerate a locked unlink here
  // rather than failing the suite over teardown, not test, flakiness.
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

const DAY_MS = 86_400_000;
const NOW = new Date("2026-06-01T00:00:00.000Z");

function daysBefore(now: Date, days: number): Date {
  return new Date(now.getTime() - days * DAY_MS);
}

let meterCounter = 0;
function nextMeterId(): string {
  meterCounter += 1;
  return `CRM${meterCounter}`;
}

describe("calculateCreditScore (pure formula)", () => {
  it("gives a brand-new address with no history a neutral mid-range score", () => {
    const stats = computePaymentHistoryStatsStub();
    const score = calculateCreditScore(stats);
    expect(score).toBeGreaterThan(400);
    expect(score).toBeLessThan(700);
    expect(creditTier(score)).toBe("Fair");
  });

  it("rewards a perfect payer with a high score", () => {
    const stats = computePaymentHistoryStatsStub({
      onTimeCount: 20,
      lateCount: 0,
      defaultCount: 0,
      totalPayments: 20,
      totalVolumeStroops: 1000 * STROOPS_PER_XLM,
      accountAgeDays: 400,
    });
    const score = calculateCreditScore(stats);
    expect(score).toBe(1000);
    expect(creditTier(score)).toBe("Excellent");
  });

  it("penalizes a frequent late payer", () => {
    const stats = computePaymentHistoryStatsStub({
      onTimeCount: 4,
      lateCount: 6,
      defaultCount: 0,
      totalPayments: 10,
      totalVolumeStroops: 50 * STROOPS_PER_XLM,
      accountAgeDays: 180,
    });
    const score = calculateCreditScore(stats);
    const neutralScore = calculateCreditScore(computePaymentHistoryStatsStub());
    expect(score).toBeLessThan(neutralScore);
  });

  it("drives a defaulter's score to the bottom", () => {
    const stats = computePaymentHistoryStatsStub({
      onTimeCount: 1,
      lateCount: 1,
      defaultCount: 8,
      totalPayments: 10,
      totalVolumeStroops: 10 * STROOPS_PER_XLM,
      accountAgeDays: 300,
    });
    const score = calculateCreditScore(stats);
    expect(score).toBe(0);
    expect(creditTier(score)).toBe("Very Poor");
  });
});

describe("recommendPaymentPlan / creditLimitForScore thresholds", () => {
  it("recommends Daily below 500, Weekly 500-749, Monthly 750+", () => {
    expect(recommendPaymentPlan(0)).toBe("Daily");
    expect(recommendPaymentPlan(499)).toBe("Daily");
    expect(recommendPaymentPlan(500)).toBe("Weekly");
    expect(recommendPaymentPlan(749)).toBe("Weekly");
    expect(recommendPaymentPlan(750)).toBe("Monthly");
    expect(recommendPaymentPlan(1000)).toBe("Monthly");
  });

  it("scales credit limit linearly with score, capped at MAX_CREDIT_LIMIT_STROOPS", () => {
    expect(creditLimitForScore(0)).toBe(0);
    expect(creditLimitForScore(1000)).toBe(MAX_CREDIT_LIMIT_STROOPS);
    expect(creditLimitForScore(500)).toBe(Math.round(MAX_CREDIT_LIMIT_STROOPS / 2));
  });
});

describe("computePaymentHistoryStats (integration with billing + revenueStore)", () => {
  it("classifies on-time, late and defaulted bills correctly for a real address", () => {
    const address = "GCREDITSCORINGTESTADDRESSAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".slice(0, 56);
    const meterId = nextMeterId();
    upsertBillingAccount({ meterId, stellarAddress: address, email: null, name: null });

    // Bill 1: issued long ago, paid on time.
    const issued1 = daysBefore(NOW, 200);
    const { bill: bill1 } = generateBill(meterId, periodFor(issued1), issued1);
    markBillPaid(bill1.id, null, new Date(new Date(bill1.due_at).getTime() - DAY_MS));

    // Bill 2: issued, paid 5 days after due_at (late).
    const issued2 = daysBefore(NOW, 150);
    const { bill: bill2 } = generateBill(meterId, periodFor(issued2), issued2);
    markBillPaid(bill2.id, null, new Date(new Date(bill2.due_at).getTime() + 5 * DAY_MS));

    // Bill 3: issued long enough ago that it's now past the default grace period, unpaid.
    const issued3 = daysBefore(NOW, 100);
    generateBill(meterId, periodFor(issued3), issued3);

    recordRevenueEvent({
      paymentId: `pay-${meterId}-1`,
      meterId,
      amount: 500 * STROOPS_PER_XLM,
      payer: address,
      createdAt: issued1.toISOString(),
    });

    const stats = computePaymentHistoryStats(address, NOW);
    expect(stats.onTimeCount).toBe(1);
    expect(stats.lateCount).toBe(1);
    expect(stats.defaultCount).toBe(1);
    expect(stats.totalPayments).toBe(1);
    expect(stats.totalVolumeStroops).toBe(500 * STROOPS_PER_XLM);
    expect(stats.accountAgeDays).toBeGreaterThanOrEqual(200);
  });

  it("buildCreditScoreResult returns a full, explainable result", () => {
    const address = "GCREDITSCORINGTESTADDRESSBBBBBBBBBBBBBBBBBBBBBBBBBBBBB".slice(0, 56);
    const result = buildCreditScoreResult(address, NOW);
    expect(result.address).toBe(address);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1000);
    expect(["Excellent", "Good", "Fair", "Poor", "Very Poor"]).toContain(result.tier);
    expect(["Daily", "Weekly", "Monthly"]).toContain(result.recommendedPaymentPlan);
  });
});

describe("admin override precedence", () => {
  it("an active override is returned and takes precedence over the computed score", () => {
    const address = "GCREDITSCORINGTESTADDRESSCCCCCCCCCCCCCCCCCCCCCCCCCCCCC".slice(0, 56);
    setCreditOverride({
      address,
      score: 950,
      creditLimitStroops: 10_000 * STROOPS_PER_XLM,
      reason: "VIP customer",
      setBy: "admin",
    });

    const override = getActiveCreditOverride(address, NOW);
    expect(override?.score).toBe(950);
    expect(override?.credit_limit_stroops).toBe(10_000 * STROOPS_PER_XLM);

    clearCreditOverride(address);
    expect(getActiveCreditOverride(address, NOW)).toBeUndefined();
  });

  it("an expired override is not considered active", () => {
    const address = "GCREDITSCORINGTESTADDRESSDDDDDDDDDDDDDDDDDDDDDDDDDDDDD".slice(0, 56);
    setCreditOverride({
      address,
      score: 10,
      reason: "temporary penalty",
      expiresAt: daysBefore(NOW, 1).toISOString(),
    });

    expect(getActiveCreditOverride(address, NOW)).toBeUndefined();
  });
});

// ── helpers ──────────────────────────────────────────────────────────────────

function periodFor(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function computePaymentHistoryStatsStub(overrides: Partial<ReturnType<typeof baseStats>> = {}) {
  const merged = { ...baseStats(), ...overrides };
  merged.judgedBillCount = merged.onTimeCount + merged.lateCount + merged.defaultCount;
  return merged;
}

function baseStats() {
  return {
    address: "GSTUB",
    totalPayments: 0,
    totalVolumeStroops: 0,
    accountAgeDays: 0,
    onTimeCount: 0,
    lateCount: 0,
    defaultCount: 0,
    judgedBillCount: 0,
  };
}
