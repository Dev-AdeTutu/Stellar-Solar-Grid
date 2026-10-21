import { describe, expect, it } from "vitest";
import { createReceiptPdf } from "../src/lib/receipts.js";

describe("payment receipts", () => {
  it("creates a valid PDF containing the required payment fields", () => {
    const pdf = createReceiptPdf({
      paymentId: "tx-1",
      amount: 5000000,
      meterId: "METER-1",
      date: "2026-09-24T11:00:00.000Z",
      transactionHash: "abc123",
      invoiceNumber: "INV-1",
    });
    const text = pdf.toString("utf8");
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text).toContain("5000000");
    expect(text).toContain("METER-1");
    expect(text).toContain("abc123");
    expect(text).toContain("INV-1");
    expect(text).toContain("startxref");
  });
});
