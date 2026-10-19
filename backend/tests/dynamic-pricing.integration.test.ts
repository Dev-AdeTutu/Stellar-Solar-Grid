import { describe, it, expect, vi } from "vitest";
import {
  calculatePrice,
  updatePricingMultiplier,
  getPricingMultiplier,
  getCurrentPrice,
  pricingEvents,
  recordPrice,
} from "../src/lib/dynamicPricing.js";

describe("Dynamic Pricing Based on Demand (#973)", () => {
  it("calculates real-time price based on supply and demand ratio", () => {
    // High demand (demand = 200, supply = 100 -> ratio 2.0)
    const highDemand = calculatePrice(100, 200);
    // Low demand (demand = 50, supply = 100 -> ratio 0.5)
    const lowDemand = calculatePrice(100, 50);

    expect(highDemand.pricePerKwh).toBeGreaterThan(lowDemand.pricePerKwh);
    expect(highDemand.supplyDemandRatio).toBe(2.0);
    expect(lowDemand.supplyDemandRatio).toBe(0.5);
  });

  it("updates pricing multiplier and reflects in calculated price", () => {
    updatePricingMultiplier(1.5, "peak_demand_surge");
    expect(getPricingMultiplier()).toBe(1.5);

    const price = calculatePrice(100, 100);
    expect(price.pricePerKwh).toBeGreaterThan(0);

    // Reset multiplier
    updatePricingMultiplier(1.0, "normal");
    expect(getPricingMultiplier()).toBe(1.0);
  });

  it("emits PriceUpdated event when price is updated or recorded", () => {
    const handler = vi.fn();
    pricingEvents.on("PriceUpdated", handler);

    updatePricingMultiplier(1.25, "event_test");
    expect(handler).toHaveBeenCalled();
    const eventArg = handler.mock.calls[0][0];
    expect(eventArg.multiplier).toBe(1.25);
    expect(eventArg.rule).toBe("event_test");
    expect(typeof eventArg.pricePerKwh).toBe("number");

    pricingEvents.off("PriceUpdated", handler);
  });
});
