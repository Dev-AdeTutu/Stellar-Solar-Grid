/**
 * #1154: a load balancing request where the grid reports no capacity must produce a defined plan,
 * not NaN and not a rejected request.
 *
 * The issue describes a weighted round-robin dividing by total weight 0. The balancer has no
 * weights: it fills capacity in priority order, and the only division is guarded. What was wrong
 * is that the route refused `capacityKw: 0` outright (400), so an outage with nothing available
 * could not be planned at all. That is now accepted and sheds everything but critical load.
 */
import { describe, expect, it } from "vitest";
import { balanceLoads, type Load } from "../src/lib/loadBalancer.js";

const load = (id: string, demandKw: number, priority: Load["priority"], override?: Load["override"]): Load =>
  ({ id, demandKw, priority, ...(override ? { override } : {}) });

const allFinite = (result: ReturnType<typeof balanceLoads>) =>
  [result.servedKw, result.shedKw, result.baselineCost, result.optimisedCost, result.savingsPct].every(Number.isFinite);

describe("balanceLoads with zero capacity", () => {
  const loads = [load("hospital", 5, "critical"), load("fridge", 1, "high"), load("tv", 2, "normal"), load("dryer", 3, "deferrable")];

  it("serves only critical load and sheds the rest, with every number finite", () => {
    const result = balanceLoads({ loads, capacityKw: 0, pricePerKwh: 0.2 });

    expect(result.on).toEqual(["hospital"]);
    expect(result.off.sort()).toEqual(["dryer", "fridge", "tv"]);
    expect(result.servedKw).toBe(5);
    expect(result.shedKw).toBe(6);
    expect(allFinite(result)).toBe(true);
    expect(Number.isNaN(result.savingsPct)).toBe(false);
  });

  it("sheds everything when no load is critical", () => {
    const result = balanceLoads({ loads: loads.filter((l) => l.priority !== "critical"), capacityKw: 0, pricePerKwh: 0.2 });

    expect(result.on).toEqual([]);
    expect(result.servedKw).toBe(0);
    expect(allFinite(result)).toBe(true);
  });

  it("zero capacity and zero demand together is an empty, finite plan", () => {
    const result = balanceLoads({ loads: [load("idle", 0, "normal")], capacityKw: 0, pricePerKwh: 0.2 });

    expect(allFinite(result)).toBe(true);
    expect(result.savingsPct).toBe(0);
    expect(result.baselineCost).toBe(0);
  });

  it("zero price does not divide anything either", () => {
    const result = balanceLoads({ loads, capacityKw: 0, pricePerKwh: 0 });

    expect(allFinite(result)).toBe(true);
    expect(result.savingsPct).toBe(0);
  });

  it("no loads at all is a finite, empty plan", () => {
    const result = balanceLoads({ loads: [], capacityKw: 0, pricePerKwh: 0.2 });

    expect(result).toMatchObject({ on: [], off: [], servedKw: 0, shedKw: 0, savingsPct: 0 });
  });

  it("a user override still wins when there is no capacity", () => {
    const result = balanceLoads({
      loads: [load("pump", 4, "normal", "on"), load("heater", 3, "normal", "off"), load("lamp", 1, "high")],
      capacityKw: 0,
      pricePerKwh: 0.2,
    });

    expect(result.on).toEqual(["pump"]);
    expect(result.off.sort()).toEqual(["heater", "lamp"]);
    expect(allFinite(result)).toBe(true);
  });

  it("is a sheddable plan rather than a NaN one for a deferrable load at peak price", () => {
    const result = balanceLoads({ loads: [load("dryer", 3, "deferrable")], capacityKw: 0, pricePerKwh: 1, peakPriceThreshold: 0.5 });

    expect(result.off).toEqual(["dryer"]);
    expect(allFinite(result)).toBe(true);
  });
});
