/**
 * #1163: a VPP dispatch must not hold the event loop for the whole fleet.
 *
 * `dispatchSignal` fans a signal out to every online resource. It now works in chunks and yields to
 * the event loop between them, so other requests are served while a large fleet is processed.
 * These tests check that it yields, that chunking does not change the result, and that a signal
 * cannot be fanned out twice while a dispatch is between chunks.
 */
import { createServer, type Server } from "node:http";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const drEvents = vi.hoisted(() => ({ created: 0 }));

// The payment and demand-response modules reach for the network and the filesystem; neither is the
// subject here.
vi.mock("../src/lib/stellar.js", () => ({ sendPayment: vi.fn() }));
vi.mock("../src/lib/demandResponse.js", () => ({
  createDemandResponseEvent: vi.fn(() => {
    drEvents.created += 1;
    return { id: `dr-${drEvents.created}` };
  }),
}));

const {
  DISPATCH_CHUNK_SIZE,
  createVpp,
  dispatchSignal,
  getDispatchSignal,
  getResource,
  joinVpp,
  receiveDispatchSignal,
  resetVppsForTests,
} = await import("../src/lib/vpp.js");
const { vppRouter } = await import("../src/routes/vpp.js");

function fleet(size: number, capacityKw = 1) {
  const vpp = createVpp({ name: "Big fleet", service: "frequency_response", operatorId: "OP" });
  const ids: string[] = [];
  for (let i = 0; i < size; i += 1) {
    ids.push(joinVpp({ vppId: vpp.id, ownerId: `owner-${i}`, name: `d${i}`, type: "battery", capacityKw }).id);
  }
  return { vpp, ids };
}

const signalFor = (vppId: string, targetKw = 100) =>
  receiveDispatchSignal({ vppId, direction: "increase", targetKw, durationMinutes: 30 });

beforeEach(() => {
  resetVppsForTests();
  drEvents.created = 0;
});

describe("chunked fan-out", () => {
  it("defaults to 500 resources per turn", () => {
    expect(DISPATCH_CHUNK_SIZE).toBe(500);
  });

  it("yields to the event loop between chunks instead of running the whole fleet in one tick", async () => {
    const { vpp } = fleet(5_000);
    const signal = signalFor(vpp.id);

    // A competing task that needs the loop: it can only run when the dispatch yields.
    let ticks = 0;
    let running = true;
    const tick = () => {
      ticks += 1;
      if (running) setImmediate(tick);
    };
    setImmediate(tick);

    await dispatchSignal({ signalId: signal.id, chunkSize: 500 });
    running = false;

    // 5,000 resources in chunks of 500 is 10 chunks, so 9 yields.
    expect(ticks).toBeGreaterThanOrEqual(9);
  });

  it("does not yield for a fleet that fits in one chunk", async () => {
    const { vpp } = fleet(10);
    const signal = signalFor(vpp.id);
    let ticks = 0;
    const timer = setImmediate(() => {
      ticks += 1;
    });

    await dispatchSignal({ signalId: signal.id, chunkSize: 500 });
    clearImmediate(timer);

    expect(ticks).toBe(0);
  });

  it("gives every resource exactly one instruction and one demand-response event", async () => {
    const { vpp, ids } = fleet(2_345);
    const signal = signalFor(vpp.id);

    const result = await dispatchSignal({ signalId: signal.id, chunkSize: 500 });

    expect(result.status).toBe("dispatched");
    expect(result.instructions).toHaveLength(2_345);
    expect(new Set(result.instructions.map((i) => i.resourceId))).toEqual(new Set(ids));
    expect(drEvents.created).toBe(2_345);
    expect(new Set(result.instructions.map((i) => i.demandResponseEventId)).size).toBe(2_345);
  });

  it("keeps the fleet's order and allocates the target pro rata, whatever the chunk size", async () => {
    const results = [] as Array<{ ownerId: string; deltaKw: number }[]>;
    for (const chunkSize of [1, 7, 500, 1_000_000]) {
      resetVppsForTests();
      const { vpp } = fleet(300);
      const signal = signalFor(vpp.id, 150);
      const result = await dispatchSignal({ signalId: signal.id, chunkSize });
      results.push(result.instructions.map((i) => ({ ownerId: i.ownerId, deltaKw: i.deltaKw })));
      expect(result.instructions.reduce((sum, i) => sum + i.deltaKw, 0)).toBeCloseTo(150, 5);
    }

    for (const other of results.slice(1)) expect(other).toEqual(results[0]);
  });

  it("caps the delivered power at what the fleet has available", async () => {
    const { vpp } = fleet(1_000, 1); // 1,000 kW available
    const signal = signalFor(vpp.id, 5_000);

    const result = await dispatchSignal({ signalId: signal.id, chunkSize: 100 });

    expect(result.instructions.reduce((sum, i) => sum + i.deltaKw, 0)).toBeCloseTo(1_000, 5);
  });

  it("treats a chunk size below 1 as 1 rather than looping forever", async () => {
    const { vpp } = fleet(5);
    const signal = signalFor(vpp.id);

    const result = await dispatchSignal({ signalId: signal.id, chunkSize: 0 });

    expect(result.instructions).toHaveLength(5);
  });

  it("only dispatches resources that are online", async () => {
    const { vpp, ids } = fleet(6);
    (getResource(ids[0]) as { status: string }).status = "offline";
    (getResource(ids[1]) as { status: string }).status = "offline";

    const result = await dispatchSignal({ signalId: signalFor(vpp.id).id, chunkSize: 2 });

    expect(result.instructions.map((i) => i.resourceId)).toEqual(ids.slice(2));
  });
});

describe("a signal is dispatched once", () => {
  it("refuses a second dispatch of the same signal while the first is between chunks", async () => {
    const { vpp } = fleet(2_000);
    const signal = signalFor(vpp.id);

    const first = dispatchSignal({ signalId: signal.id, chunkSize: 100 });
    expect(getDispatchSignal(signal.id)?.status).toBe("dispatching");
    const second = dispatchSignal({ signalId: signal.id, chunkSize: 100 });

    await expect(second).rejects.toMatchObject({ code: "CONFLICT" });
    const result = await first;
    expect(result.instructions).toHaveLength(2_000);
    expect(drEvents.created).toBe(2_000); // not 4,000
  });

  it("refuses to dispatch it again once it has been dispatched", async () => {
    const { vpp } = fleet(3);
    const signal = signalFor(vpp.id);
    await dispatchSignal({ signalId: signal.id });

    await expect(dispatchSignal({ signalId: signal.id })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("rejects an unknown signal", async () => {
    await expect(dispatchSignal({ signalId: "nope" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("fails the signal, with the reason, when no resource is online", async () => {
    const vpp = createVpp({ name: "Empty", service: "frequency_response", operatorId: "OP" });
    const signal = signalFor(vpp.id);

    const result = await dispatchSignal({ signalId: signal.id });

    expect(result).toMatchObject({ status: "failed", failureReason: "No dispatchable resources are online" });
  });

  it("marks the signal failed, and not stuck dispatching, if the fan-out throws", async () => {
    const { vpp, ids } = fleet(20);
    const signal = signalFor(vpp.id);
    Object.defineProperty(getResource(ids[15]), "ownerId", {
      get() {
        throw new Error("boom");
      },
    });

    await expect(dispatchSignal({ signalId: signal.id, chunkSize: 5 })).rejects.toThrow("boom");

    expect(getDispatchSignal(signal.id)).toMatchObject({ status: "failed", failureReason: "boom" });
    await expect(dispatchSignal({ signalId: signal.id })).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("POST /api/vpp/dispatch", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use("/api/vpp", vppRouter);
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("waits for the chunked fan-out and answers 202 with the dispatched signal", async () => {
    const { vpp } = fleet(1_200);
    const signal = signalFor(vpp.id);

    const res = await fetch(`${baseUrl}/api/vpp/dispatch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        vppId: vpp.id,
        service: "frequency_response",
        direction: "up",
        targetKw: 100,
        signalId: signal.id,
      }),
    });

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toMatchObject({ id: signal.id, status: "dispatched" });
    expect(body.instructions).toHaveLength(1_200);
  });

  it("answers a repeated dispatch of the same signal with a conflict", async () => {
    const { vpp } = fleet(3);
    const signal = signalFor(vpp.id);
    const send = () =>
      fetch(`${baseUrl}/api/vpp/dispatch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ vppId: vpp.id, service: "frequency_response", direction: "up", targetKw: 10, signalId: signal.id }),
      });

    expect((await send()).status).toBe(202);
    expect((await send()).status).toBe(409);
  });
});
