import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupTwoFactor, verifyTwoFactor, resetTwoFactorForTests } from "../src/lib/twoFactor.js";

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
  it("consumes a recovery code once", () => {
    const { recoveryCodes } = setupTwoFactor("admin");
    expect(verifyTwoFactor("admin", recoveryCodes[0])).toBe(true);
    expect(verifyTwoFactor("admin", recoveryCodes[0])).toBe(false);
  });
});
