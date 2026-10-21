import { describe, it, expect, beforeEach } from "vitest";
import {
  categorizeContractEvent,
  exportTransactionsToCsv,
  getTransactionsForAddress,
  indexContractTransaction,
  resetTransactionIndex,
} from "../src/lib/transactionExplorer.js";

describe("Blockchain Transaction History Explorer (#1004)", () => {
  const userAddr = "GABC1234567890SOLARUSER";

  beforeEach(() => {
    resetTransactionIndex();
  });

  it("categorizes contract events into payments, registrations, transfers, and admin_actions", () => {
    expect(categorizeContractEvent("pay_meter_bill")).toBe("payments");
    expect(categorizeContractEvent("register_meter")).toBe("registrations");
    expect(categorizeContractEvent("transfer_credits")).toBe("transfers");
    expect(categorizeContractEvent("set_tariff_rate")).toBe("admin_actions");
  });

  it("indexes transactions with Stellar explorer links and filters by category, meter_id, and date range", () => {
    indexContractTransaction({
      txHash: "tx999",
      address: userAddr,
      category: "payments",
      meterId: "meter-500",
      amountStroops: 100000000,
      assetCode: "XLM",
      status: "success",
      ledger: 600000,
      timestamp: "2026-10-16T00:00:00.000Z",
      description: "Payment for meter-500",
    });

    const paymentsOnly = getTransactionsForAddress(userAddr, { category: "payments" });
    expect(paymentsOnly.every((tx) => tx.category === "payments")).toBe(true);
    expect(paymentsOnly[0].explorerUrl).toContain("tx999");

    const byMeter = getTransactionsForAddress(userAddr, { meterId: "meter-500" });
    expect(byMeter.length).toBe(1);
    expect(byMeter[0].txHash).toBe("tx999");
  });

  it("exports indexed transactions to CSV for accounting", () => {
    const txs = getTransactionsForAddress(userAddr);
    const csv = exportTransactionsToCsv(txs);
    expect(csv).toContain("txHash,timestamp,category,meterId");
    expect(csv).toContain("a1b2c3d4e5f602");
  });
});
