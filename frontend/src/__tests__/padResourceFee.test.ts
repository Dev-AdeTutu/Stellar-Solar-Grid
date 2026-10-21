import { padResourceFee } from "@/lib/fees";

// #762 — mirrors backend/tests/feeEstimation.integration.test.ts: the
// wallet-signed frontend transaction path pads the simulated resource fee
// the same way the backend admin path does, so a large batch/complex
// operation doesn't fail with "insufficient fee" between simulation and
// submission.
describe("padResourceFee", () => {
  it("pads the assembled fee by the configured margin (default 20%)", () => {
    expect(padResourceFee("1000")).toBe("1200");
  });

  it("rounds up to the nearest stroop", () => {
    expect(padResourceFee("101")).toBe(String(Math.ceil(101 * 1.2)));
  });

  it("scales the absolute padding with the simulated fee", () => {
    const small = Number(padResourceFee("1000")) - 1000;
    const large = Number(padResourceFee("50000")) - 50000;
    expect(large).toBeGreaterThan(small);
  });
});
