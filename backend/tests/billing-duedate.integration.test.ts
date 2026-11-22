/**
 * A null due date must not crash the invoice PDF or email renderer (#1148).
 * The database driver is stubbed because PDF rendering itself is pure.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("better-sqlite3", () => ({
  default: class FakeDatabase {
    pragma() {}
    exec() {}
    close() {}
    prepare() {
      return {
        all: () => [],
        get: () => undefined,
        run: () => ({ lastInsertRowid: 1, changes: 0 }),
      };
    }
  },
}));

vi.mock("../src/lib/stellar.js", () => ({
  stellarService: {},
  adminInvoke: vi.fn(),
}));

vi.mock("../src/lib/usageEvents.js", () => ({ db: vi.fn() }));

vi.mock("../src/lib/communities.js", () => ({ getMemberDiscountPercent: () => 0 }));

import { createBillPdf, formatBillDate, type Bill } from "../src/lib/billing.js";

const bill = (dueAt: string | null): Bill =>
  ({
    id: "bill-1",
    bill_number: "INV-001",
    meter_id: "meter-1",
    period: "2026-01",
    period_start: "2026-01-01T00:00:00Z",
    period_end: "2026-02-01T00:00:00Z",
    units: 10,
    energy_charge: 100,
    discount_percent: 0,
    discount_amount: 0,
    service_charge: 10,
    tax: 0,
    total: 110,
    status: "issued",
    issued_at: "2026-01-02T00:00:00Z",
    due_at: dueAt as string,
    paid_at: null,
    payment_tx_hash: null,
    payment_link: "https://example.com/pay/bill-1",
    emailed_at: null,
    email_error: null,
  }) as Bill;

describe("formatBillDate", () => {
  it("renders null and empty dates as N/A", () => {
    expect(formatBillDate(null)).toBe("N/A");
    expect(formatBillDate(undefined)).toBe("N/A");
    expect(formatBillDate("")).toBe("N/A");
  });

  it("truncates a valid ISO timestamp to the date part", () => {
    expect(formatBillDate("2026-02-03T12:34:56Z")).toBe("2026-02-03");
  });
});

describe("createBillPdf", () => {
  it("renders a bill with a null due date instead of throwing", () => {
    const pdf = createBillPdf(bill(null));
    expect(Buffer.isBuffer(pdf)).toBe(true);
    expect(pdf.toString("latin1")).toContain("Due: N/A");
  });

  it("renders the date when a due date is present", () => {
    const pdf = createBillPdf(bill("2026-02-10T00:00:00Z"));
    expect(pdf.toString("latin1")).toContain("Due: 2026-02-10");
  });
});
