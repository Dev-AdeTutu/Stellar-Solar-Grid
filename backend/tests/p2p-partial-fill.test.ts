import { beforeEach, describe, expect, it } from "vitest";
import * as trading from "../src/lib/p2pTrading.js";

describe("P2P partial-fill accounting", () => {
  beforeEach(() => {
    trading.resetTradingStateForTests();
  });

  it("never matches more than the sell offer's remaining quantity", () => {
    const sell = trading.createOffer({
      userId: "seller",
      direction: "sell",
      energyKwh: 10,
      pricePerKwh: 1,
      minKwh: 1,
    });
    trading.createOffer({
      userId: "buyer-1",
      direction: "buy",
      energyKwh: 7,
      pricePerKwh: 1,
      minKwh: 1,
    });
    trading.createOffer({
      userId: "buyer-2",
      direction: "buy",
      energyKwh: 7,
      pricePerKwh: 1,
      minKwh: 1,
    });

    const firstRun = trading.runMatchingAlgorithm();
    const secondRun = trading.runMatchingAlgorithm();
    const allMatches = [...firstRun, ...secondRun];

    expect(allMatches.reduce((sum, match) => sum + match.energyKwh, 0)).toBe(10);
    expect(allMatches.map((match) => match.energyKwh)).toEqual([7, 3]);
    expect(sell.remainingKwh).toBe(0);
    expect(sell.status).toBe("matched");
    expect(trading.getOpenOffers("sell")).toHaveLength(0);
  });

  it("leaves a sell offer open with its residual quantity after a partial fill", () => {
    const sell = trading.createOffer({
      userId: "seller",
      direction: "sell",
      energyKwh: 10,
      pricePerKwh: 1,
      minKwh: 1,
    });
    trading.createOffer({
      userId: "buyer",
      direction: "buy",
      energyKwh: 4,
      pricePerKwh: 1,
      minKwh: 1,
    });

    const [match] = trading.runMatchingAlgorithm();
    expect(match.energyKwh).toBe(4);
    expect(sell.remainingKwh).toBe(6);
    expect(sell.status).toBe("open");

    trading.settleMatch(match.id);
    expect(sell.remainingKwh).toBe(6);
    expect(sell.status).toBe("open");
  });
});
