import { describe, expect, it } from "vitest";
import { getCredit, issueCredit, retireCreditWithLedger } from "./carbonCredits.js";

describe("carbon credit ledger retirement", () => {
  it("restores local state when ledger settlement fails", async () => {
    const credit = issueCredit({ ownerId: "owner-rollback", kwhProduced: 2000 });
    await expect(retireCreditWithLedger(credit.id, "owner-rollback", async () => {
      throw new Error("ledger unavailable");
    })).rejects.toThrow("ledger unavailable");
    const restored = getCredit(credit.id);
    expect(restored?.status).toBe("issued");
    expect(restored?.retiredAt).toBeNull();
    expect(restored?.auditTrail.some((entry) => entry.action === "retired")).toBe(false);
  });
});
