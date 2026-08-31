import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as StellarSdk from "@stellar/stellar-sdk";

// StellarService's module-scope singleton requires a valid admin secret to
// construct — set one before import, same pattern as tests/scrub.test.ts.
const kp = StellarSdk.Keypair.random();
process.env.ADMIN_SECRET_KEY = kp.secret();

describe("padResourceFee (#762 — insufficient fee on large batch operations)", () => {
  const originalMargin = process.env.RPC_FEE_SAFETY_MARGIN_PCT;

  afterEach(() => {
    if (originalMargin === undefined) delete process.env.RPC_FEE_SAFETY_MARGIN_PCT;
    else process.env.RPC_FEE_SAFETY_MARGIN_PCT = originalMargin;
  });

  it("pads the assembled fee by the default 20% margin", async () => {
    delete process.env.RPC_FEE_SAFETY_MARGIN_PCT;
    const { padResourceFee } = await import("../src/lib/stellar.js");
    expect(padResourceFee("1000")).toBe("1200");
  });

  it("scales the absolute padding with the simulated fee — a larger batch's higher resource fee gets a proportionally larger cushion", async () => {
    const { padResourceFee } = await import("../src/lib/stellar.js");
    const smallBatchFee = padResourceFee("1000"); // e.g. a single-meter update
    const largeBatchFee = padResourceFee("50000"); // e.g. a 50-meter batch_update_usage

    const smallPadding = Number(smallBatchFee) - 1000;
    const largePadding = Number(largeBatchFee) - 50000;
    expect(largePadding).toBeGreaterThan(smallPadding);
  });

  it("respects a custom margin percentage", async () => {
    process.env.RPC_FEE_SAFETY_MARGIN_PCT = "100";
    const { padResourceFee } = await import("../src/lib/stellar.js");
    expect(padResourceFee("1000")).toBe("2000");
  });

  it("is a no-op when the margin is disabled", async () => {
    process.env.RPC_FEE_SAFETY_MARGIN_PCT = "0";
    const { padResourceFee } = await import("../src/lib/stellar.js");
    expect(padResourceFee("1000")).toBe("1000");
  });
});
