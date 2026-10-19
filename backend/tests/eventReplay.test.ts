import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { clearIndexedEvents, indexManualEvent } from "../src/lib/eventIndexer.js";
import {
  replayEvents,
  reconstructStateAtBlock,
  compareContractStates,
} from "../src/lib/eventReplay.js";
import { eventsRouter } from "../src/routes/events.js";

describe("Smart Contract Event Replay (#1007)", () => {
  const app = express();
  app.use(express.json());
  app.use("/api/events", eventsRouter);

  beforeEach(() => {
    clearIndexedEvents();
  });

  it("indexes contract events with block number and replays across a block range", () => {
    indexManualEvent({
      id: "evt-1",
      ledger: 100,
      topic1: "mtr_reg",
      subject: "METER-001",
      value: "GOWNER11111111111111111111111111111111111111111111111111",
    });
    indexManualEvent({
      id: "evt-2",
      ledger: 105,
      topic1: "payment",
      subject: "METER-001",
      value: ["GPAYER", "GTOKEN", 500, "Weekly", "topup"],
    });
    indexManualEvent({
      id: "evt-3",
      ledger: 110,
      topic1: "usage",
      subject: "METER-001",
      value: 120,
    });
    indexManualEvent({
      id: "evt-4",
      ledger: 120,
      topic1: "mtr_deact",
      subject: "METER-001",
      value: null,
    });

    const partialReplay = replayEvents({ fromBlock: 100, toBlock: 110 });
    expect(partialReplay.events).toHaveLength(3);
    expect(partialReplay.state.eventsProcessed).toBe(3);
    expect(partialReplay.state.totalRevenue).toBe(500);
    expect(partialReplay.state.meters["METER-001"]).toMatchObject({
      meterId: "METER-001",
      owner: "GOWNER11111111111111111111111111111111111111111111111111",
      active: true,
      balance: 380,
      unitsUsed: 120,
      plan: "Weekly",
      lastUpdatedBlock: 110,
    });
  });

  it("reconstructs contract state at a specific block and compares against current state", () => {
    indexManualEvent({
      id: "evt-10",
      ledger: 200,
      topic1: "mtr_reg",
      subject: "METER-002",
      value: "GOWNER2",
    });
    indexManualEvent({
      id: "evt-11",
      ledger: 210,
      topic1: "payment",
      subject: "METER-002",
      value: 1000,
    });
    indexManualEvent({
      id: "evt-12",
      ledger: 250,
      topic1: "usage",
      subject: "METER-002",
      value: 300,
    });
    indexManualEvent({
      id: "evt-13",
      ledger: 260,
      topic1: "pause_on",
      subject: null,
      value: null,
    });

    const stateAt210 = reconstructStateAtBlock(210);
    expect(stateAt210.meters["METER-002"].balance).toBe(1000);
    expect(stateAt210.meters["METER-002"].unitsUsed).toBe(0);
    expect(stateAt210.paused).toBe(false);

    const diff = compareContractStates(210, 260);
    expect(diff.inSync).toBe(false);
    expect(diff.discrepancies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entity: "contract",
          field: "paused",
          historicalValue: false,
          currentValue: true,
        }),
        expect.objectContaining({
          entity: "meter:METER-002",
          field: "unitsUsed",
          historicalValue: 0,
          currentValue: 300,
          delta: 300,
        }),
        expect.objectContaining({
          entity: "meter:METER-002",
          field: "balance",
          historicalValue: 1000,
          currentValue: 700,
          delta: -300,
        }),
      ]),
    );
  });

  it("exposes POST /api/events/replay for block-range replay and state comparison", async () => {
    indexManualEvent({
      id: "evt-20",
      ledger: 300,
      topic1: "mtr_reg",
      subject: "METER-003",
      value: "GOWNER3",
    });
    indexManualEvent({
      id: "evt-21",
      ledger: 310,
      topic1: "payment",
      subject: "METER-003",
      value: 250,
    });
    indexManualEvent({
      id: "evt-22",
      ledger: 320,
      topic1: "usage",
      subject: "METER-003",
      value: 50,
    });

    const res = await request(app)
      .post("/api/events/replay")
      .send({ fromBlock: 300, toBlock: 310, compareWithCurrent: true });

    expect(res.status).toBe(200);
    expect(res.body.eventsReplayed).toBe(2);
    expect(res.body.state.meters["METER-003"].balance).toBe(250);
    expect(res.body.comparison.inSync).toBe(false);
    expect(res.body.comparison.currentState.meters["METER-003"].balance).toBe(200);
  });
});
