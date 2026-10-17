import { describe, it, expect } from "vitest";

process.env.ADMIN_SECRET_KEY = "SCKUYV5P4VUHLFNUNCLQV3EPPTGDD4CCUDOFEXEBFIJAO4YMHIN2YDOE";
process.env.CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
process.env.BILLING_DB_PATH = ":memory:";
process.env.USAGE_EVENTS_DB_PATH = ":memory:";

const {
  setupBillingCycle,
  getBillingCycle,
  renewBillingCycle,
  checkUpcomingBillingCycles,
  getMeterBillingHistory,
} = await import("../src/lib/billing.js");

describe("Automated Billing Cycle Management (#971)", () => {
  const meterId = "MTR_BILLING_TEST_1";

  it("sets up and retrieves a billing cycle", () => {
    const cycle = setupBillingCycle({
      meterId,
      cycleDurationDays: 30,
      autoRenew: true,
      startDate: "2026-01-01T00:00:00.000Z",
    });

    expect(cycle.meter_id).toBe(meterId);
    expect(cycle.billing_cycle_start).toBe("2026-01-01T00:00:00.000Z");
    expect(cycle.cycle_duration_days).toBe(30);
    expect(cycle.auto_renew).toBe(1);

    const fetched = getBillingCycle(meterId);
    expect(fetched).toBeDefined();
    expect(fetched?.meter_id).toBe(meterId);
  });

  it("renews billing cycle advancing dates", () => {
    const now = new Date("2026-01-31T00:00:00.000Z");
    const renewed = renewBillingCycle(meterId, now);

    expect(renewed).toBeDefined();
    expect(renewed?.billing_cycle_start).toBe("2026-01-31T00:00:00.000Z");
    expect(new Date(renewed!.next_billing_date).getTime()).toBeGreaterThan(
      new Date("2026-01-31T00:00:00.000Z").getTime(),
    );
  });

  it("returns billing history including cycle and past bills", () => {
    const history = getMeterBillingHistory(meterId, 10);
    expect(history.meterId).toBe(meterId);
    expect(history.billingCycle).toBeDefined();
    expect(Array.isArray(history.bills)).toBe(true);
  });

  it("checks upcoming billing cycles and processes renewals", async () => {
    const dueMeterId = "MTR_DUE_TODAY";
    setupBillingCycle({
      meterId: dueMeterId,
      cycleDurationDays: 30,
      autoRenew: true,
      startDate: "2025-12-01T00:00:00.000Z",
    });

    const now = new Date("2026-01-05T00:00:00.000Z");
    const result = await checkUpcomingBillingCycles(now);
    expect(result).toBeDefined();
    expect(typeof result.remindersSent).toBe("number");
    expect(typeof result.invoicesGenerated).toBe("number");
  });
});
