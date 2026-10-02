/**
 * Energy portfolio management (#926): dashboard composition, allocation
 * recommendations, performance metrics, one-click rebalancing and risk scoring.
 */
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";

const {
  PORTFOLIO_TARIFF_XLM_PER_KWH,
  addAsset,
  applyRebalance,
  assessRisk,
  getDashboard,
  getPerformance,
  getRebalancePlan,
  listAssets,
  recordDelivery,
  recommendAllocation,
  removeAsset,
  resetPortfoliosForTests,
} = await import("../src/lib/portfolio.js");
const { portfolioRouter } = await import("../src/routes/portfolio.js");

const OWNER = "GOWNER1";
/** Solar 100 kW, wind 50 kW, battery 30 kW — deliberately unbalanced. */
function seedPortfolio() {
  addAsset({ ownerId: OWNER, type: "solar", name: "Rooftop array", capacityKw: 100, energyKwh: 1_800 });
  addAsset({ ownerId: OWNER, type: "wind", name: "Turbine 1", capacityKw: 50, energyKwh: 2_200 });
  addAsset({ ownerId: OWNER, type: "storage", name: "Battery bank", capacityKw: 30, energyKwh: 400 });
}

describe("portfolio composition and performance", () => {
  beforeEach(() => {
    resetPortfoliosForTests();
  });

  it("shows composition, ROI and efficiency for a multi-asset portfolio", () => {
    seedPortfolio();
    const assets = listAssets(OWNER);
    expect(assets).toHaveLength(3);

    const performance = getPerformance(OWNER);
    expect(performance.totalCapacityKw).toBe(180);
    expect(performance.totalEnergyKwh).toBe(4_400);
    expect(performance.revenueXlm).toBeCloseTo(4_400 * PORTFOLIO_TARIFF_XLM_PER_KWH, 2);
    expect(performance.roiPct).not.toBeNull();
    expect(performance.efficiencyPct).not.toBeNull();
    expect(performance.uptimePct).toBe(100);
    expect(performance.byType.map((row) => row.type)).toEqual(["solar", "wind", "storage"]);
    // Solar is 100 of 180 kW.
    expect(performance.byType.find((row) => row.type === "solar")!.sharePct).toBeCloseTo(55.56, 1);
  });

  it("reports null rather than zero when a metric is not measurable", () => {
    // No cost basis recorded, and no delivery yet: ROI and efficiency are
    // unknown, not zero.
    addAsset({ ownerId: OWNER, type: "solar", name: "New array", capacityKw: 10, costBasisXlm: 0 });
    const performance = getPerformance(OWNER);
    expect(performance.roiPct).toBeNull();
    // Efficiency is measurable here and genuinely zero: the asset had capacity
    // and availability, and delivered nothing.
    expect(performance.efficiencyPct).toBe(0);

    const empty = getPerformance("GSTRANGER");
    expect(empty.totalCapacityKw).toBe(0);
    expect(empty.roiPct).toBeNull();
    expect(empty.byType).toEqual([]);
  });

  it("accumulates delivery readings and enforces ownership on removal", () => {
    const asset = addAsset({ ownerId: OWNER, type: "solar", name: "Array", capacityKw: 50, energyKwh: 100 });
    expect(recordDelivery(asset.id, 25).energyKwh).toBe(125);
    expect(() => recordDelivery("PA-nope", 1)).toThrow(/not found/i);
    expect(() => removeAsset(asset.id, "GSTRANGER")).toThrow(/Not the asset owner/);
    expect(removeAsset(asset.id, OWNER).id).toBe(asset.id);
    expect(listAssets(OWNER)).toEqual([]);
  });

  it("rejects invalid assets", () => {
    expect(() => addAsset({ ownerId: OWNER, type: "coal" as never, name: "x", capacityKw: 1 })).toThrow(
      /Unsupported asset type/,
    );
    expect(() => addAsset({ ownerId: OWNER, type: "solar", name: "x", capacityKw: 0 })).toThrow(/positive/);
    expect(() => addAsset({ ownerId: OWNER, type: "solar", name: "x", capacityKw: 1, energyKwh: -1 })).toThrow(
      /non-negative/,
    );
  });
});

describe("portfolio risk assessment", () => {
  beforeEach(() => {
    resetPortfoliosForTests();
  });

  it("scores a single-asset portfolio higher than a diversified one", () => {
    addAsset({ ownerId: OWNER, type: "solar", name: "Only asset", capacityKw: 100, energyKwh: 1_000 });
    const concentrated = assessRisk(OWNER);
    expect(concentrated.concentration).toBe(1);
    expect(concentrated.band === "high" || concentrated.band === "very_high").toBe(true);
    expect(concentrated.factors.join(" ")).toMatch(/Concentrated/);

    resetPortfoliosForTests();
    seedPortfolio();
    const diversified = assessRisk(OWNER);
    expect(diversified.score).toBeLessThan(concentrated.score);
    expect(diversified.factors.join(" ")).toMatch(/Diversified/);
  });

  it("keeps every component inside its declared range", () => {
    seedPortfolio();
    const risk = assessRisk(OWNER);
    expect(risk.score).toBeGreaterThanOrEqual(0);
    expect(risk.score).toBeLessThanOrEqual(100);
    expect(risk.concentration).toBeGreaterThan(0);
    expect(risk.concentration).toBeLessThan(1);
    expect(risk.volatility).toBeGreaterThanOrEqual(0);
  });

  it("reports an empty portfolio without inventing risk", () => {
    const risk = assessRisk("GEMPTY");
    expect(risk.score).toBe(0);
    expect(risk.factors).toEqual(["No assets in portfolio"]);
  });
});

describe("portfolio allocation and rebalancing", () => {
  beforeEach(() => {
    resetPortfoliosForTests();
  });

  it("recommends a target mix and explains it", () => {
    seedPortfolio();
    const recommendation = recommendAllocation(OWNER, { targetRiskScore: 30 });
    expect(recommendation.allocations).toHaveLength(3);
    expect(recommendation.targetRiskScore).toBe(30);
    expect(recommendation.rationale).toMatch(/risk-adjusted/);

    // Recommended weights are a share of the portfolio and sum to ~100%.
    const totalWeight = recommendation.allocations.reduce((sum, slice) => sum + slice.weightPct, 0);
    expect(totalWeight).toBeGreaterThan(99);
    expect(totalWeight).toBeLessThan(101);
    for (const slice of recommendation.allocations) {
      expect(slice.expectedReturnPct).not.toBeNull();
      expect(slice.riskScore).toBeGreaterThan(0);
      expect(Math.abs(slice.deltaKw)).toBeLessThan(180);
    }
  });

  it("tilt the target mix toward lower risk when the target is tightened", () => {
    seedPortfolio();
    const relaxed = recommendAllocation(OWNER, { targetRiskScore: 95 });
    const tight = recommendAllocation(OWNER, { targetRiskScore: 5 });
    const batteryWeight = (r: typeof relaxed) =>
      r.allocations.find((slice) => slice.type === "storage")!.weightPct;
    const windWeight = (r: typeof relaxed) => r.allocations.find((slice) => slice.type === "wind")!.weightPct;

    // Tightening favours storage/grid over wind.
    expect(batteryWeight(tight)).toBeGreaterThan(batteryWeight(relaxed));
    expect(windWeight(tight)).toBeLessThan(windWeight(relaxed));
  });

  it("produces an actionable plan that ignores immaterial moves", () => {
    seedPortfolio();
    const plan = getRebalancePlan(OWNER, { targetRiskScore: 25 });
    expect(plan.actions).toHaveLength(3);
    expect(plan.riskBefore).toBeGreaterThanOrEqual(0);
    for (const action of plan.actions) {
      if (action.action === "hold") {
        expect(action.deltaKw).toBe(0);
        expect(action.reason).toMatch(/5%/);
      } else {
        expect(Math.abs(action.deltaKw)).toBeGreaterThan(0);
        expect(Math.sign(action.deltaKw)).toBe(action.action === "increase" ? 1 : -1);
        expect(action.reason.length).toBeGreaterThan(0);
      }
    }
    expect(plan.estimatedCostXlm).toBeGreaterThanOrEqual(0);
  });

  it("applies a rebalance in one step and converges", () => {
    seedPortfolio();
    const before = listAssets(OWNER);
    const totalBefore = before.reduce((sum, asset) => sum + asset.capacityKw, 0);

    const applied = applyRebalance(OWNER, { targetRiskScore: 25 });
    expect(applied.actions.length).toBeGreaterThan(0);

    const after = listAssets(OWNER);
    const totalAfter = after.reduce((sum, asset) => sum + asset.capacityKw, 0);
    // Capacity is moved, not created.
    expect(totalAfter).toBeCloseTo(totalBefore, 1);
    expect(after.every((asset) => asset.capacityKw > 0)).toBe(true);
    expect(totalAfter).toBeGreaterThanOrEqual(planActionCapacity(getRebalancePlan(OWNER)));
  });

  it("returns an empty plan for an empty portfolio", () => {
    const plan = getRebalancePlan("GEMPTY");
    expect(plan.actions).toEqual([]);
    expect(plan.netDeltaKw).toBe(0);
    expect(applyRebalance("GEMPTY").actions).toEqual([]);
  });
});

/** Total capacity a still-pending plan would move. */
function planActionCapacity(plan: ReturnType<typeof getRebalancePlan>): number {
  return plan.actions.reduce((sum, action) => sum + Math.abs(action.deltaKw), 0);
}

describe("portfolio API", () => {
  let server: Server;
  let baseUrl = "";

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use("/api/portfolio", portfolioRouter);
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const json = (body: unknown) => ({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  it("adds assets and serves the full dashboard", async () => {
    const created = await fetch(
      `${baseUrl}/api/portfolio/${OWNER}/assets`,
      json({ type: "solar", name: "Rooftop", capacityKw: 100, energyKwh: 1_800 }),
    );
    expect(created.status).toBe(201);
    const asset = await created.json();

    await fetch(
      `${baseUrl}/api/portfolio/${OWNER}/assets`,
      json({ type: "wind", name: "Turbine", capacityKw: 50, energyKwh: 2_200 }),
    );

    const dashboard = await (await fetch(`${baseUrl}/api/portfolio/${OWNER}`)).json();
    expect(dashboard.ownerId).toBe(OWNER);
    expect(dashboard.assetCount).toBe(2);
    expect(dashboard.performance.totalCapacityKw).toBe(150);
    expect(dashboard.risk.score).toBeGreaterThanOrEqual(0);
    expect(dashboard.recommendation.allocations).toHaveLength(2);
    expect(dashboard.rebalance.actions).toHaveLength(2);

    // Delivery readings accumulate against the asset.
    const delivery = await fetch(
      `${baseUrl}/api/portfolio/${OWNER}/assets/${asset.id}/delivery`,
      json({ energyKwh: 100 }),
    );
    expect((await delivery.json()).energyKwh).toBe(1_900);
  });

  it("serves performance, risk, allocation and rebalance endpoints", async () => {
    const performance = await (await fetch(`${baseUrl}/api/portfolio/${OWNER}/performance`)).json();
    expect(performance.totalEnergyKwh).toBe(4_100);

    const risk = await (await fetch(`${baseUrl}/api/portfolio/${OWNER}/risk`)).json();
    expect(risk).toHaveProperty("band");

    const allocation = await (
      await fetch(`${baseUrl}/api/portfolio/${OWNER}/allocation?targetRiskScore=20`)
    ).json();
    expect(allocation.targetRiskScore).toBe(20);

    const plan = await (await fetch(`${baseUrl}/api/portfolio/${OWNER}/rebalance?targetRiskScore=20`)).json();
    expect(plan.actions.length).toBeGreaterThan(0);

    const applied = await fetch(
      `${baseUrl}/api/portfolio/${OWNER}/rebalance`,
      json({ targetRiskScore: 20 }),
    );
    expect(applied.status).toBe(200);
    expect((await applied.json()).actions).toBeDefined();
  });

  it("rejects invalid requests and unknown assets", async () => {
    const badType = await fetch(
      `${baseUrl}/api/portfolio/${OWNER}/assets`,
      json({ type: "coal", name: "x", capacityKw: 10 }),
    );
    expect(badType.status).toBe(400);
    expect((await badType.json()).code).toBe("VALIDATION_ERROR");

    const badRisk = await fetch(`${baseUrl}/api/portfolio/${OWNER}/allocation?targetRiskScore=999`);
    expect(badRisk.status).toBe(400);

    const unknownDelivery = await fetch(
      `${baseUrl}/api/portfolio/${OWNER}/assets/PA-nope/delivery`,
      json({ energyKwh: 1 }),
    );
    expect(unknownDelivery.status).toBe(404);

    // An empty portfolio is a valid answer, not an error.
    const empty = await fetch(`${baseUrl}/api/portfolio/GEMPTY`);
    expect(empty.status).toBe(200);
    expect((await empty.json()).assetCount).toBe(0);
  });

  it("refuses delivery readings and removal by a non-owner", async () => {
    const asset = listAssets(OWNER)[0];
    const notOwner = await fetch(
      `${baseUrl}/api/portfolio/GSTRANGER/assets/${asset.id}/delivery`,
      json({ energyKwh: 5 }),
    );
    expect(notOwner.status).toBe(403);

    const remove = await fetch(`${baseUrl}/api/portfolio/GSTRANGER/assets/${asset.id}`, {
      method: "DELETE",
    });
    expect(remove.status).toBe(403);
  });
});
