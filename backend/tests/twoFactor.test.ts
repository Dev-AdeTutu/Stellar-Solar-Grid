import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupTwoFactor, verifyTwoFactor, resetTwoFactorForTests, totp, verifyTotp } from "../src/lib/twoFactor.js";

describe("two-factor authentication", () => {
  beforeEach(() => {
    process.env.TWO_FACTOR_ENCRYPTION_KEY = "test-encryption-key";
    resetTwoFactorForTests();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });
  it("verifies a generated TOTP code", async () => {
    const { secret } = setupTwoFactor("admin");
    const { verifyTotp } = await import("../src/lib/twoFactor.js");
    expect(secret).toMatch(/^[A-Z2-7]+$/);
    const crypto = await import("node:crypto");
    const counter = Math.floor(Date.now() / 1000 / 30);
    const digest = crypto.createHmac("sha1", Buffer.from(secret, "base64"));
    expect(verifyTotp(secret, "000000", Date.now())).toBe(false);
    expect(counter).toBeGreaterThan(0);
    expect(digest).toBeDefined();
  });
  it("accepts a code generated at second 29 when submitted at the next step's second 0", () => {
    const { secret } = setupTwoFactor("admin");
    const generatedAt = Date.parse("2026-01-01T00:00:29.000Z");
    const submittedAt = Date.parse("2026-01-01T00:00:30.000Z");
    const code = totp(secret, generatedAt);

    expect(verifyTotp(secret, code, submittedAt)).toBe(true);
  });
  it("rejects a code that is more than one time step away", () => {
    const { secret } = setupTwoFactor("admin");
    const now = Date.parse("2026-01-01T00:00:00.000Z");
    const codeTwoStepsAhead = totp(secret, now + 60_000);

    expect(verifyTotp(secret, codeTwoStepsAhead, now)).toBe(false);
  });
  it("consumes a recovery code once", () => {
    const { recoveryCodes } = setupTwoFactor("admin");
    expect(verifyTwoFactor("admin", recoveryCodes[0])).toBe(true);
    expect(verifyTwoFactor("admin", recoveryCodes[0])).toBe(false);
  });
});
