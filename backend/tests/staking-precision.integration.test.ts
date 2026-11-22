/**
 * Staking reward calculations must not lose precision for large token
 * amounts (#1149). The division happens in BigInt space before converting to
 * a display Number.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as StellarSdk from "@stellar/stellar-sdk";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../src/lib/stellar.js", () => ({ stellarService: { query } }));

import { getStakingStats, ratioToNumber } from "../src/lib/staking.js";

const ADDRESS = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

beforeEach(() => {
  query.mockReset();
});

describe("ratioToNumber", () => {
  it("preserves precision beyond Number.MAX_SAFE_INTEGER", () => {
    // Number(2^53 + 1) rounds down to 2^53, changing the fractional part.
    expect(ratioToNumber(2n ** 53n + 1n, 10n ** 6n)).toBe(9007199254.740993);
  });

  it("handles a negative numerator", () => {
    expect(ratioToNumber(-3n, 4n)).toBe(-0.75);
  });

  it("handles a zero denominator", () => {
    expect(ratioToNumber(10n, 0n)).toBeNull();
  });

  it("handles a large ratio", () => {
    expect(ratioToNumber(10n ** 30n, 4n)).toBe(2.5e29);
  });
});

describe("getStakingStats", () => {
  it("computes APR from BigInt inputs without precision loss", async () => {
    query.mockImplementation(async (method: string) => {
      if (method === "get_staking_config") {
        return StellarSdk.nativeToScVal({
          reward_rate: 1000000000000000000n,
          stake_token: ADDRESS,
          reward_token: ADDRESS,
          cooldown_secs: 604800,
        });
      }
      if (method === "get_staking_pool") {
        return StellarSdk.nativeToScVal({
          total_staked: 2n ** 53n + 1n,
          staker_count: 1,
          reward_reserve: 1000000000000000000000000000000n,
          total_distributed: 0n,
        });
      }
      throw new Error(`unexpected method ${method}`);
    });

    const stats = await getStakingStats();
    const expectedApr = ratioToNumber(
      1000000000000000000n * BigInt(365 * 86400) * 100n,
      2n ** 53n + 1n,
    );
    expect(stats.aprPercent).toBe(expectedApr);
    expect(stats.reserveRunwayDays).toBeTypeOf("number");
  });
});
