import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  upsertBillingAccount,
  getBillingAccount,
  getBillingHistory,
  getBillsForMeter,
  checkBillingRemindersAndInvoices,
} from "../src/lib/billing.js";

process.env.EMAIL_PREFERENCES_SECRET = "test-secret-key-for-reminders";

describe("Automated Billing Cycle Management (#971)", () => {
  const meterId = "METER-TEST-BILLING-001";

  it("tracks billing_cycle_start and next_billing_date per meter", () => {
    const cycleStart = new Date("2026-10-01T00:00:00Z").toISOString();
    const nextBilling = new Date("2026-11-01T00:00:00Z").toISOString();

    const account = upsertBillingAccount({
      meterId,
      name: "Alice Solar",
      email: "alice@example.com",
      billingCycleStart: cycleStart,
      nextBillingDate: nextBilling,
    });

    expect(account.meter_id).toBe(meterId);
    expect(account.billing_cycle_start).toBe(cycleStart);
    expect(account.next_billing_date).toBe(nextBilling);

    const history = getBillingHistory(meterId);
    expect(history.meterId).toBe(meterId);
    expect(history.billing_cycle_start).toBe(cycleStart);
    expect(history.next_billing_date).toBe(nextBilling);
    expect(Array.isArray(history.bills)).toBe(true);
  });

  it("calculates upcoming reminders at 7, 3, and 1 days before next billing date", async () => {
    const cycleStart = new Date("2026-10-01T00:00:00Z").toISOString();
    const nextBilling = new Date("2026-10-15T00:00:00Z").toISOString();

    upsertBillingAccount({
      meterId,
      email: "alice@example.com",
      name: "Alice",
      billingCycleStart: cycleStart,
      nextBillingDate: nextBilling,
    });

    // Exactly 7 days before
    const date7DaysBefore = new Date("2026-10-08T00:00:00Z");
    const { remindersSent: r7 } = await checkBillingRemindersAndInvoices(date7DaysBefore);
    expect(r7).toBe(1);

    // Duplicate check on same day should not resend
    const { remindersSent: r7Dup } = await checkBillingRemindersAndInvoices(date7DaysBefore);
    expect(r7Dup).toBe(0);

    // 3 days before
    const date3DaysBefore = new Date("2026-10-12T00:00:00Z");
    const { remindersSent: r3 } = await checkBillingRemindersAndInvoices(date3DaysBefore);
    expect(r3).toBe(1);

    // 1 day before
    const date1DayBefore = new Date("2026-10-14T00:00:00Z");
    const { remindersSent: r1 } = await checkBillingRemindersAndInvoices(date1DayBefore);
    expect(r1).toBe(1);
  });

  it("auto-generates invoice and advances billing cycle on cycle close", async () => {
    const cycleStart = new Date("2026-09-01T00:00:00Z").toISOString();
    const nextBilling = new Date("2026-10-01T00:00:00Z").toISOString();

    upsertBillingAccount({
      meterId,
      email: "alice@example.com",
      billingCycleStart: cycleStart,
      nextBillingDate: nextBilling,
    });

    const cycleCloseDate = new Date("2026-10-01T01:00:00Z");
    await checkBillingRemindersAndInvoices(cycleCloseDate);

    const updatedAccount = getBillingAccount(meterId);
    expect(updatedAccount).toBeDefined();
    // Next billing date should have advanced
    expect(new Date(updatedAccount!.next_billing_date!).getTime()).toBeGreaterThan(new Date(nextBilling).getTime());
    expect(updatedAccount!.billing_cycle_start).toBe(nextBilling);
  });
});
