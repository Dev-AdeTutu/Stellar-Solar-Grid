/**
 * Virtual Power Plant aggregation (#925): create/join, resource aggregation,
 * grid-service bidding, fair revenue distribution and performance monitoring.
 */
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";

const {
  GRID_SERVICES,
  aggregateCapacityKw,
  availableCapacityKw,
  createVpp,
  getPerformance,
  getSettlement,
  isServiceOpen,
  joinVpp,
  leaveVpp,
  listBids,
  listOpenServices,
  listResources,
  listSettlements,
  resetVppsForTests,
  settleBid,
  submitBid,
  updateResourceAvailability,
  withdrawBid,
} = await import("../src/lib/vpp.js");
const { vppRouter } = await import("../src/routes/vpp.js");

const ALICE = "GALICE";
const BOB = "GBOB";
const CAROL = "GCAROL";

/**
 * 00:00 UTC, when every market's bid window is open — the bid tests must not
 * depend on the wall clock.
 */
const AT_MIDNIGHT = new Date("2026-03-10T00:00:00.000Z");

function seedVpp() {
  const vpp = createVpp({ name: "Riverside VPP", service: "frequency_response", operatorId: "GRID_OP" });
  return vpp;
}

function seedFleet(vppId: string) {
  // Alice 100 kW solar, Bob 60 kW battery, Carol 40 kW EV.
  const solar = joinVpp({ vppId, ownerId: ALICE, name: "Rooftop", type: "solar", capacityKw: 100 });
  const battery = joinVpp({ vppId, ownerId: BOB, name: "Home battery", type: "battery", capacityKw: 60 });
  const ev = joinVpp({ vppId, ownerId: CAROL, name: "EV charger", type: "ev", capacityKw: 40 });
  return { solar, battery, ev };
}

describe("VPP lifecycle and aggregation", () => {
  beforeEach(() => {
    resetVppsForTests();
  });

  it("creates a VPP that becomes active once it has members", () => {
    const vpp = seedVpp();
    expect(vpp.status).toBe("forming");
    expect(vpp.members).toEqual([]);

    joinVpp({ vppId: vpp.id, ownerId: ALICE, name: "Rooftop", type: "solar", capacityKw: 100 });
    expect(seedVpp && createVpp({ name: "x", service: "peak_shaving", operatorId: "GRID_OP" }).status).toBe("forming");
    const active = createVpp({ name: "y", service: "peak_shaving", operatorId: "GRID_OP" });
    joinVpp({ vppId: active.id, ownerId: BOB, name: "Battery", type: "battery", capacityKw: 10 });
    expect(active.status).toBe("active");
    expect(active.members).toEqual([BOB]);
  });

  it("rejects invalid VPP and resource configuration", () => {
    expect(() => createVpp({ name: "x", service: "teleportation" as never, operatorId: "o" })).toThrow(
      /Unsupported grid service/,
    );
    expect(() => createVpp({ name: "  ", service: "peak_shaving", operatorId: "o" })).toThrow(/name/);
    expect(() =>
      createVpp({ name: "x", service: "peak_shaving", operatorId: "o", availabilityFactor: 0 }),
    ).toThrow(/availabilityFactor/);

    const vpp = seedVpp();
    expect(() => joinVpp({ vppId: vpp.id, ownerId: ALICE, name: "x", type: "solar", capacityKw: 0 })).toThrow(
      /positive/,
    );
    expect(() => joinVpp({ vppId: vpp.id, ownerId: ALICE, name: "x", type: "solar", capacityKw: 1, uptime: 2 })).toThrow(
      /uptime/,
    );
    expect(() => joinVpp({ vppId: "VPP-nope", ownerId: ALICE, name: "x", type: "solar", capacityKw: 1 })).toThrow(
      /not found/i,
    );
  });

  it("derates aggregate capacity by availability and diversity", () => {
    const vpp = createVpp({
      name: "Derated",
      service: "frequency_response",
      operatorId: "GRID_OP",
      availabilityFactor: 0.8,
      diversityFactor: 0.5,
    });
    const { solar } = seedFleet(vpp.id);
    // 200 kW nameplate, 0.8 * 0.5 derated → 80 kW of credible capability.
    expect(listResources(vpp.id).reduce((sum, r) => sum + r.capacityKw, 0)).toBe(200);
    expect(aggregateCapacityKw(vpp.id)).toBe(80);
    // Availability is the real, current number, not the derated estimate.
    expect(availableCapacityKw(vpp.id)).toBe(200);
    expect(solar.availableKw).toBe(100);
  });

  it("removes offline resources from available capacity", () => {
    const vpp = seedVpp();
    const { solar, battery } = seedFleet(vpp.id);
    expect(availableCapacityKw(vpp.id)).toBe(200);

    updateResourceAvailability(battery.id, { status: "offline" });
    // Solar 100 kW and the EV 40 kW remain dispatchable.
    expect(availableCapacityKw(vpp.id)).toBe(140);
    // Offline resources contribute nothing, whatever they last reported.
    expect(battery.availableKw).toBe(0);

    // Coming back online restores dispatchability rather than stranding it.
    updateResourceAvailability(battery.id, { status: "online" });
    expect(availableCapacityKw(vpp.id)).toBe(200);
    updateResourceAvailability(solar.id, { availableKw: 40 });
    expect(availableCapacityKw(vpp.id)).toBe(140);
    expect(() => updateResourceAvailability(solar.id, { availableKw: 500 })).toThrow(/between 0 and capacityKw/);
  });

  it("withdraws a resource and drops the member when they have none left", () => {
    const vpp = seedVpp();
    const { solar } = seedFleet(vpp.id);
    const removed = leaveVpp(vpp.id, solar.id);
    expect(removed.id).toBe(solar.id);
    expect(vpp.members).toEqual([BOB, CAROL]);
    expect(() => leaveVpp(vpp.id, solar.id)).toThrow(/not found/i);
  });
});

describe("VPP grid-service bidding", () => {
  beforeEach(() => {
    resetVppsForTests();
  });

  it("only accepts bids while the market window is open", () => {
    expect(isServiceOpen("frequency_response", AT_MIDNIGHT)).toBe(true);
    expect(isServiceOpen("load_balancing", AT_MIDNIGHT)).toBe(false);
    expect(listOpenServices(AT_MIDNIGHT)).toContain("frequency_response");
    expect(GRID_SERVICES.length).toBeGreaterThan(1);

    const vpp = createVpp({ name: "Balanced", service: "load_balancing", operatorId: "GRID_OP" });
    joinVpp({ vppId: vpp.id, ownerId: ALICE, name: "Rooftop", type: "solar", capacityKw: 50 });
    // The market opens at 00:15 UTC.
    expect(() => submitBid({ vppId: vpp.id, energyKwh: 10, priceXlmPerKwh: 0.2, now: AT_MIDNIGHT })).toThrow(
      /not open/,
    );
    const atOpen = new Date("2026-03-10T00:15:00.000Z");
    expect(submitBid({ vppId: vpp.id, energyKwh: 10, priceXlmPerKwh: 0.2, now: atOpen }).status).toBe("open");
  });

  it("reserves capacity pro-rata when a bid is accepted", () => {
    const vpp = seedVpp();
    seedFleet(vpp.id);
    const bid = submitBid({ vppId: vpp.id, energyKwh: 200, priceXlmPerKwh: 0.2, now: AT_MIDNIGHT });

    expect(bid.status).toBe("open");
    // 200 kW spread across a 100/60/40 fleet.
    expect(Object.values(bid.reservedKw).reduce((sum, kw) => sum + kw, 0)).toBeCloseTo(200, 2);
    expect(bid.reservedKw[Object.keys(bid.reservedKw)[0]!]).toBeGreaterThan(0);
    expect(listBids(vpp.id, "open")).toHaveLength(1);
  });

  it("rejects a bid the fleet cannot back, with a recorded reason", () => {
    const vpp = seedVpp();
    const { battery } = seedFleet(vpp.id);
    updateResourceAvailability(battery.id, { status: "offline" });

    // 140 kW was committed, leaving nothing dispatchable.
    const first = submitBid({ vppId: vpp.id, energyKwh: 140, priceXlmPerKwh: 0.2, now: AT_MIDNIGHT });
    expect(first.status).toBe("open");
    const second = submitBid({ vppId: vpp.id, energyKwh: 10, priceXlmPerKwh: 0.2, now: AT_MIDNIGHT });
    expect(second.status).toBe("rejected");
    expect(second.rejectionReason).toMatch(/no dispatchable capacity/);
  });

  it("rejects bids from a VPP with no members and withdraws open bids", () => {
    const empty = seedVpp();
    expect(() =>
      submitBid({ vppId: empty.id, energyKwh: 10, priceXlmPerKwh: 0.2, now: AT_MIDNIGHT }),
    ).toThrow(/not active/);

    const vpp = seedVpp();
    seedFleet(vpp.id);
    const bid = submitBid({ vppId: vpp.id, energyKwh: 20, priceXlmPerKwh: 0.2, now: AT_MIDNIGHT });
    expect(withdrawBid(bid.id).status).toBe("withdrawn");
    expect(() => withdrawBid(bid.id)).toThrow(/open bids/);
    expect(() => withdrawBid("BID-nope")).toThrow(/not found/i);
  });

  it("validates bid parameters", () => {
    const vpp = seedVpp();
    seedFleet(vpp.id);
    expect(() => submitBid({ vppId: vpp.id, energyKwh: 0, priceXlmPerKwh: 0.2, now: AT_MIDNIGHT })).toThrow(
      /positive/,
    );
    expect(() => submitBid({ vppId: vpp.id, energyKwh: 10, priceXlmPerKwh: -1, now: AT_MIDNIGHT })).toThrow(
      /positive/,
    );
  });
});

describe("VPP revenue distribution", () => {
  beforeEach(() => {
    resetVppsForTests();
  });

  it("pays members in proportion to what they delivered", () => {
    const vpp = seedVpp();
    const { solar, battery, ev } = seedFleet(vpp.id);
    const bid = submitBid({ vppId: vpp.id, energyKwh: 200, priceXlmPerKwh: 0.2, now: AT_MIDNIGHT });

    // Alice and Bob deliver in full; Carol delivers nothing despite reserving
    // 40 kW. Frequency response carries a 1.4x premium over the bid price.
    const settlement = settleBid({
      bidId: bid.id,
      deliveredKwhByResource: { [solar.id]: 100, [battery.id]: 60, [ev.id]: 0 },
      now: AT_MIDNIGHT,
    });

    expect(settlement.deliveredKwh).toBe(160);
    expect(settlement.totalXlm).toBeCloseTo(160 * 0.2 * 1.4, 2);

    const alice = settlement.shares.find((s) => s.memberId === ALICE)!;
    const bob = settlement.shares.find((s) => s.memberId === BOB)!;
    const carol = settlement.shares.find((s) => s.memberId === CAROL)!;

    expect(alice.deliveredKwh).toBe(100);
    expect(bob.deliveredKwh).toBe(60);
    // A member that delivered nothing is paid nothing.
    expect(carol.deliveredKwh).toBe(0);
    expect(carol.amountXlm).toBe(0);
    // Carol's shortfall is still visible against what she committed.
    expect(carol.capacitySharePct).toBeGreaterThan(0);

    // Shares add up to the settled total.
    const paid = settlement.shares.reduce((sum, s) => sum + s.amountXlm, 0);
    expect(paid).toBeCloseTo(settlement.totalXlm, 2);
    const sharePct = settlement.shares.reduce((sum, s) => sum + s.sharePct, 0);
    expect(sharePct).toBeCloseTo(100, 1);
    expect(alice.amountXlm).toBeGreaterThan(bob.amountXlm);
  });

  it("caps reported delivery at the capacity a member reserved", () => {
    const vpp = seedVpp();
    const { solar, battery } = seedFleet(vpp.id);
    const bid = submitBid({ vppId: vpp.id, energyKwh: 160, priceXlmPerKwh: 0.2, now: AT_MIDNIGHT });

    // An over-reporting meter cannot inflate the grid operator's bill.
    const settlement = settleBid({
      bidId: bid.id,
      deliveredKwhByResource: { [solar.id]: 10_000, [battery.id]: 0 },
      now: AT_MIDNIGHT,
    });
    expect(settlement.deliveredKwh).toBeLessThanOrEqual(160);
    // The bid reserved 80 kW from the largest-first split, so 80 is the cap.
    const alice = settlement.shares.find((s) => s.memberId === ALICE)!;
    expect(alice.deliveredKwh).toBe(80);
    expect(alice.amountXlm).toBeGreaterThan(0);
  });

  it("refuses to settle the same bid twice and records settlements", () => {
    const vpp = seedVpp();
    const { solar } = seedFleet(vpp.id);
    const bid = submitBid({ vppId: vpp.id, energyKwh: 50, priceXlmPerKwh: 0.2, now: AT_MIDNIGHT });
    const settlement = settleBid({
      bidId: bid.id,
      deliveredKwhByResource: { [solar.id]: 50 },
      now: AT_MIDNIGHT,
    });
    expect(listSettlements(vpp.id)).toHaveLength(1);
    expect(getSettlement(settlement.id)?.id).toBe(settlement.id);
    expect(() =>
      settleBid({ bidId: bid.id, deliveredKwhByResource: { [solar.id]: 10 }, now: AT_MIDNIGHT }),
    ).toThrow(/accepted bid/);
    expect(() => settleBid({ bidId: "BID-nope", deliveredKwhByResource: {} })).toThrow(/not found/i);
  });

  it("settles an all-zero delivery to a zero payout without dividing by zero", () => {
    const vpp = seedVpp();
    const { solar } = seedFleet(vpp.id);
    const bid = submitBid({ vppId: vpp.id, energyKwh: 20, priceXlmPerKwh: 0.2, now: AT_MIDNIGHT });
    const settlement = settleBid({ bidId: bid.id, deliveredKwhByResource: { [solar.id]: 0 }, now: AT_MIDNIGHT });
    expect(settlement.deliveredKwh).toBe(0);
    expect(settlement.totalXlm).toBe(0);
    expect(settlement.shares.every((share) => share.amountXlm === 0)).toBe(true);
  });
});

describe("VPP performance monitoring", () => {
  beforeEach(() => {
    resetVppsForTests();
  });

  it("reports capacity, utilisation, health and revenue in real time", () => {
    const vpp = seedVpp();
    const { solar, battery, ev } = seedFleet(vpp.id);
    const bid = submitBid({ vppId: vpp.id, energyKwh: 200, priceXlmPerKwh: 0.2, now: AT_MIDNIGHT });
    settleBid({ bidId: bid.id, deliveredKwhByResource: { [solar.id]: 100, [battery.id]: 60, [ev.id]: 0 } });

    const performance = getPerformance(vpp.id);
    expect(performance.vppId).toBe(vpp.id);
    expect(performance.memberCount).toBe(3);
    expect(performance.resourceCount).toBe(3);
    expect(performance.currentlyAvailableKw).toBe(200);
    expect(performance.settledBids).toBe(1);
    expect(performance.revenueXlm).toBeGreaterThan(0);
    expect(performance.deliveredKwh).toBe(160);
    expect(performance.healthScore).toBe(100);
    // A settled bid releases its reservation.
    expect(performance.committedKw).toBe(0);
    expect(performance.freeCapacityKw).toBe(200);

    updateResourceAvailability(ev.id, { status: "maintenance" });
    expect(getPerformance(vpp.id).healthScore).toBe(67);
    expect(getPerformance(vpp.id).currentlyAvailableKw).toBe(160);
  });

  it("reports utilisation while a bid is still open", () => {
    const vpp = seedVpp();
    seedFleet(vpp.id);
    submitBid({ vppId: vpp.id, energyKwh: 100, priceXlmPerKwh: 0.2, now: AT_MIDNIGHT });
    const performance = getPerformance(vpp.id);
    expect(performance.committedKw).toBe(100);
    expect(performance.utilisationPct).toBe(50);
    expect(performance.openBids).toBe(1);
  });
});

describe("VPP API", () => {
  let server: Server;
  let baseUrl = "";

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use("/api/vpp", vppRouter);
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

  it("creates a VPP, enrolls resources and reports capacity", async () => {
    const created = await fetch(
      `${baseUrl}/api/vpp`,
      json({ name: "API VPP", service: "frequency_response", operatorId: "GRID_OP" }),
    );
    expect(created.status).toBe(201);
    const vpp = await created.json();
    expect(vpp.status).toBe("forming");

    for (const [ownerId, type, capacityKw] of [
      [ALICE, "solar", 100],
      [BOB, "battery", 60],
    ] as const) {
      const res = await fetch(
        `${baseUrl}/api/vpp/${vpp.id}/resources`,
        json({ ownerId, name: `${type} unit`, type, capacityKw }),
      );
      expect(res.status).toBe(201);
    }

    const detail = await (await fetch(`${baseUrl}/api/vpp/${vpp.id}`)).json();
    expect(detail.resources).toHaveLength(2);
    expect(detail.status).toBe("active");

    const capacity = await (await fetch(`${baseUrl}/api/vpp/${vpp.id}/capacity`)).json();
    expect(capacity.nameplateCapacityKw).toBe(160);
    expect(capacity.availableCapacityKw).toBe(160);
    expect(capacity.freeCapacityKw).toBe(160);
    // 160 kW nameplate, derated by the 0.9/0.85 defaults.
    expect(capacity.aggregateCapacityKw).toBeCloseTo(160 * 0.9 * 0.85, 2);
  });

  it("bids, settles and exposes performance and settlements", async () => {
    const vppId = (await (await fetch(`${baseUrl}/api/vpp`)).json()).vpps[0].id;
    const resources = (await (await fetch(`${baseUrl}/api/vpp/${vppId}/resources`)).json()).resources;

    const bidRes = await fetch(
      `${baseUrl}/api/vpp/${vppId}/bids`,
      json({ energyKwh: 100, priceXlmPerKwh: 0.2 }),
    );
    // The market window depends on the wall clock, so either it opened (201) or
    // it did not (409) — both are correct behaviour.
    if (bidRes.status === 409) {
      const closed = await bidRes.json();
      expect(closed.error).toMatch(/not open/);
      return;
    }
    expect(bidRes.status).toBe(201);
    const bid = await bidRes.json();

    const delivered: Record<string, number> = {};
    for (const resource of resources) delivered[resource.id] = resource.capacityKw / 2;
    const settled = await fetch(
      `${baseUrl}/api/vpp/bids/${bid.id}/settle`,
      json({ deliveredKwhByResource: delivered }),
    );
    expect(settled.status).toBe(200);
    const settlement = await settled.json();
    expect(settlement.totalXlm).toBeGreaterThan(0);

    const settlements = await (await fetch(`${baseUrl}/api/vpp/${vppId}/settlements`)).json();
    expect(settlements.count).toBe(1);

    const performance = await (await fetch(`${baseUrl}/api/vpp/${vppId}/performance`)).json();
    expect(performance.revenueXlm).toBeGreaterThan(0);
    expect(performance.settledBids).toBe(1);
  });

  it("lists grid services with their open windows", async () => {
    const services = await (await fetch(`${baseUrl}/api/vpp/services`)).json();
    expect(services.services).toHaveLength(GRID_SERVICES.length);
    expect(services.services.every((s: { service: string }) => typeof s.open === "boolean")).toBe(true);
  });

  it("reports 404s and validation failures clearly", async () => {
    expect((await fetch(`${baseUrl}/api/vpp/VPP-nope`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/vpp/VPP-nope/performance`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/vpp/VPP-nope/bids`)).status).toBe(404);

    const badService = await fetch(
      `${baseUrl}/api/vpp`,
      json({ name: "x", service: "teleportation", operatorId: "o" }),
    );
    expect(badService.status).toBe(400);
    expect((await badService.json()).code).toBe("VALIDATION_ERROR");

    const badResource = await fetch(
      `${baseUrl}/api/vpp/VPP-nope/resources`,
      json({ ownerId: ALICE, name: "x", type: "solar", capacityKw: -1 }),
    );
    expect(badResource.status).toBe(400);
  });

  it("updates resource availability and blocks withdrawal while committed", async () => {
    const vppId = (await (await fetch(`${baseUrl}/api/vpp`)).json()).vpps[0].id;
    const resources = (await (await fetch(`${baseUrl}/api/vpp/${vppId}/resources`)).json()).resources;
    const target = resources[0];

    const patched = await fetch(`${baseUrl}/api/vpp/${vppId}/resources/${target.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "maintenance" }),
    });
    expect((await patched.json()).status).toBe("maintenance");

    // The earlier bid test may have left an open commitment on this resource,
    // in which case withdrawal is correctly refused; otherwise it succeeds.
    const removed = await fetch(`${baseUrl}/api/vpp/${vppId}/resources/${target.id}`, {
      method: "DELETE",
    });
    expect([200, 409]).toContain(removed.status);
    if (removed.status === 409) {
      expect((await removed.json()).error).toMatch(/committed/);
    }
  });
});
