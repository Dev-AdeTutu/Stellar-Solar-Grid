import { describe, expect, it } from "vitest";
import {
  buildRevenueAnalyticsSummary,
  buildRevenueTrend,
  calculateARPU,
  calculateChurnRate,
  calculateCustomerAcquisition,
  calculateGeoBreakdown,
  calculateMRR,
  calculateTotalRevenue,
  formatRevenueBucket,
  stroopsToXlm,
  type RevenueRow,
} from "./revenueAnalytics.js";

function row(partial: Partial<RevenueRow> & { meterId: string; amount: number; createdAt: string }): RevenueRow {
  return { paymentId: `${partial.meterId}-${partial.createdAt}`, region: null, payer: null, ...partial };
}

describe("formatRevenueBucket", () => {
  it("formats daily/monthly/yearly buckets in UTC", () => {
    const d = new Date("2026-03-15T23:59:00Z");
    expect(formatRevenueBucket(d, "daily")).toBe("2026-03-15");
    expect(formatRevenueBucket(d, "monthly")).toBe("2026-03");
    expect(formatRevenueBucket(d, "yearly")).toBe("2026");
  });
});

describe("calculateTotalRevenue", () => {
  it("sums amounts across rows", () => {
    const rows = [
      row({ meterId: "M1", amount: 1000, createdAt: "2026-01-01T00:00:00Z" }),
      row({ meterId: "M2", amount: 2500, createdAt: "2026-01-02T00:00:00Z" }),
    ];
    expect(calculateTotalRevenue(rows)).toBe(3500);
  });

  it("returns 0 for an empty set", () => {
    expect(calculateTotalRevenue([])).toBe(0);
  });
});

describe("stroopsToXlm", () => {
  it("converts stroops to XLM", () => {
    expect(stroopsToXlm(10_000_000)).toBe(1);
    expect(stroopsToXlm(25_000_000)).toBe(2.5);
  });
});

describe("calculateMRR", () => {
  it("sums only revenue within the calendar month of asOf", () => {
    const rows = [
      row({ meterId: "M1", amount: 1000, createdAt: "2026-02-10T00:00:00Z" }),
      row({ meterId: "M1", amount: 2000, createdAt: "2026-02-20T00:00:00Z" }),
      // Different month — must be excluded.
      row({ meterId: "M2", amount: 5000, createdAt: "2026-03-01T00:00:00Z" }),
    ];
    expect(calculateMRR(rows, new Date("2026-02-28T00:00:00Z"))).toBe(3000);
    expect(calculateMRR(rows, new Date("2026-03-15T00:00:00Z"))).toBe(5000);
  });

  it("returns 0 when nothing falls in the target month", () => {
    const rows = [row({ meterId: "M1", amount: 1000, createdAt: "2026-01-01T00:00:00Z" })];
    expect(calculateMRR(rows, new Date("2026-06-01T00:00:00Z"))).toBe(0);
  });
});

describe("calculateARPU", () => {
  it("divides total revenue by distinct paying meters", () => {
    const rows = [
      row({ meterId: "M1", amount: 1000, createdAt: "2026-01-01T00:00:00Z" }),
      row({ meterId: "M1", amount: 1000, createdAt: "2026-01-05T00:00:00Z" }),
      row({ meterId: "M2", amount: 2000, createdAt: "2026-01-02T00:00:00Z" }),
    ];
    // total = 4000, distinct meters = 2 -> ARPU = 2000
    expect(calculateARPU(rows)).toBe(2000);
  });

  it("returns 0 for an empty set", () => {
    expect(calculateARPU([])).toBe(0);
  });
});

describe("calculateChurnRate", () => {
  it("computes churn/retention between two equal-length back-to-back periods", () => {
    // Previous period: Jan 2026. Current period: Feb 2026.
    const rows = [
      // Paid in Jan, paid again in Feb -> retained
      row({ meterId: "M1", amount: 100, createdAt: "2026-01-05T00:00:00Z" }),
      row({ meterId: "M1", amount: 100, createdAt: "2026-02-05T00:00:00Z" }),
      // Paid in Jan only -> churned
      row({ meterId: "M2", amount: 100, createdAt: "2026-01-10T00:00:00Z" }),
      // Paid in Jan only -> churned
      row({ meterId: "M3", amount: 100, createdAt: "2026-01-15T00:00:00Z" }),
      // New in Feb — doesn't affect churn (not in previous period)
      row({ meterId: "M4", amount: 100, createdAt: "2026-02-20T00:00:00Z" }),
    ];
    const result = calculateChurnRate(
      rows,
      new Date("2026-02-01T00:00:00Z"),
      new Date("2026-03-01T00:00:00Z"),
    );
    expect(result.previousPeriodCustomers).toBe(3); // M1, M2, M3
    expect(result.retainedCustomers).toBe(1); // M1
    expect(result.churnedCustomers).toBe(2); // M2, M3
    expect(result.churnRate).toBeCloseTo(2 / 3, 5);
    expect(result.retentionRate).toBeCloseTo(1 / 3, 5);
  });

  it("treats an empty previous period as 0% churn and 100% retention", () => {
    const rows = [row({ meterId: "M1", amount: 100, createdAt: "2026-02-05T00:00:00Z" })];
    const result = calculateChurnRate(
      rows,
      new Date("2026-02-01T00:00:00Z"),
      new Date("2026-03-01T00:00:00Z"),
    );
    expect(result.previousPeriodCustomers).toBe(0);
    expect(result.churnRate).toBe(0);
    expect(result.retentionRate).toBe(1);
  });
});

describe("buildRevenueTrend", () => {
  it("buckets revenue, payment count, and unique customers by day", () => {
    const rows = [
      row({ meterId: "M1", amount: 100, createdAt: "2026-01-01T01:00:00Z" }),
      row({ meterId: "M2", amount: 200, createdAt: "2026-01-01T15:00:00Z" }),
      row({ meterId: "M1", amount: 50, createdAt: "2026-01-02T00:00:00Z" }),
    ];
    const trend = buildRevenueTrend(rows, "daily");
    expect(trend).toEqual([
      { bucket: "2026-01-01", revenue: 300, paymentCount: 2, uniqueCustomers: 2 },
      { bucket: "2026-01-02", revenue: 50, paymentCount: 1, uniqueCustomers: 1 },
    ]);
  });

  it("buckets revenue by month and year", () => {
    const rows = [
      row({ meterId: "M1", amount: 100, createdAt: "2026-01-15T00:00:00Z" }),
      row({ meterId: "M1", amount: 100, createdAt: "2026-02-15T00:00:00Z" }),
      row({ meterId: "M1", amount: 100, createdAt: "2027-01-15T00:00:00Z" }),
    ];
    expect(buildRevenueTrend(rows, "monthly").map((p) => p.bucket)).toEqual(["2026-01", "2026-02", "2027-01"]);
    expect(buildRevenueTrend(rows, "yearly").map((p) => [p.bucket, p.revenue])).toEqual([
      ["2026", 200],
      ["2027", 100],
    ]);
  });
});

describe("calculateCustomerAcquisition", () => {
  it("counts each customer once, in the bucket of their first ever payment", () => {
    const rows = [
      row({ meterId: "M1", amount: 100, createdAt: "2026-01-05T00:00:00Z" }),
      row({ meterId: "M1", amount: 100, createdAt: "2026-02-05T00:00:00Z" }), // repeat, not new
      row({ meterId: "M2", amount: 100, createdAt: "2026-02-10T00:00:00Z" }),
    ];
    expect(calculateCustomerAcquisition(rows, "monthly")).toEqual([
      { bucket: "2026-01", newCustomers: 1 },
      { bucket: "2026-02", newCustomers: 1 },
    ]);
  });
});

describe("calculateGeoBreakdown", () => {
  it("groups revenue by region, falling back to Unknown, sorted descending", () => {
    const rows = [
      row({ meterId: "M1", amount: 100, createdAt: "2026-01-01T00:00:00Z", region: "Lagos" }),
      row({ meterId: "M2", amount: 300, createdAt: "2026-01-02T00:00:00Z", region: "Nairobi" }),
      row({ meterId: "M3", amount: 100, createdAt: "2026-01-03T00:00:00Z", region: null }),
    ];
    const geo = calculateGeoBreakdown(rows);
    expect(geo[0]).toMatchObject({ region: "Nairobi", revenue: 300, customers: 1 });
    expect(geo.find((g) => g.region === "Unknown")).toMatchObject({ revenue: 100 });
    const total = geo.reduce((s, g) => s + g.percentageOfTotal, 0);
    expect(total).toBeCloseTo(100, 5);
  });
});

describe("buildRevenueAnalyticsSummary", () => {
  it("assembles a consistent summary restricted to the window, using full history for acquisition/churn", () => {
    const allRows = [
      row({ meterId: "M1", amount: 1000, createdAt: "2025-12-01T00:00:00Z" }), // outside window
      row({ meterId: "M1", amount: 1000, createdAt: "2026-01-10T00:00:00Z" }),
      row({ meterId: "M2", amount: 2000, createdAt: "2026-01-15T00:00:00Z" }),
    ];
    const from = new Date("2026-01-01T00:00:00Z");
    const to = new Date("2026-01-31T23:59:59Z");
    const windowRows = allRows.filter((r) => new Date(r.createdAt) >= from && new Date(r.createdAt) <= to);

    const summary = buildRevenueAnalyticsSummary(allRows, windowRows, from, to, "monthly");

    expect(summary.totalRevenue).toBe(3000);
    expect(summary.totalPayments).toBe(2);
    expect(summary.activeCustomers).toBe(2);
    expect(summary.trend).toEqual([
      { bucket: "2026-01", revenue: 3000, paymentCount: 2, uniqueCustomers: 2 },
    ]);
    // M1's first-ever payment was in Dec 2025 (outside the window), so only
    // M2 counts as newly acquired within the Jan window.
    expect(summary.acquisition).toEqual([{ bucket: "2026-01", newCustomers: 1 }]);
  });
});
