import { describe, expect, it } from "vitest";
import { isValidSemVer } from "../src/lib/semver.js";

describe("isValidSemVer (#1150)", () => {
  it("accepts plain semantic versions", () => {
    for (const version of ["0.0.0", "1.2.3", "10.20.30", "1.0.0-alpha", "1.0.0-alpha.1"]) {
      expect(isValidSemVer(version)).toBe(true);
    }
  });

  it("accepts prerelease and build metadata", () => {
    expect(isValidSemVer("2.1.0-rc.1+build.5")).toBe(true);
    expect(isValidSemVer("1.0.0+20260101")).toBe(true);
  });

  it("rejects the malformed versions that break the update scheduler", () => {
    for (const version of ["abc", "1.2", "1.2.x", "v1.2.3", "01.2.3", "1.02.3", "1.2.03", "1.2.3-", "1.2.3+", ""]) {
      expect(isValidSemVer(version)).toBe(false);
    }
  });

  it("rejects non-string inputs", () => {
    expect(isValidSemVer(undefined)).toBe(false);
    expect(isValidSemVer(123)).toBe(false);
    expect(isValidSemVer(null)).toBe(false);
  });
});
