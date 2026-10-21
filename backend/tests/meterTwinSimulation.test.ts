import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import {
  clearVirtualMeters,
  createVirtualMeter,
  runContractScenarioSimulation,
  stepVirtualMeter,
} from "../src/lib/meterTwinSimulation.js";
import { simulationRouter } from "../src/routes/simulation.js";

describe("Meter Virtual Twin Simulation (#1010)", () => {
  const app = express();
  app.use(express.json());
  app.use("/api/simulation", simulationRouter);

  beforeEach(() => {
    clearVirtualMeters();
  });

  it("POST /api/simulation/create creates a virtual meter that mimics real meter behavior", async () => {
    const res = await request(app)
      .post("/api/simulation/create")
      .send({
        id: "V-METER-TEST-1",
        usagePattern: "residential",
        weather: "sunny",
        balanceStroops: 3000,
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe("V-METER-TEST-1");
    expect(res.body.active).toBe(true);
    expect(res.body.relayClosed).toBe(true);
    expect(res.body.balanceStroops).toBe(3000);
  });

  it("simulates usage patterns, faults, weather impacts, and contract rule changes accurately", () => {
    const twin = createVirtualMeter({
      id: "V-METER-TEST-2",
      usagePattern: "commercial",
      weather: "heatwave",
      fault: "voltage_sag",
      balanceStroops: 1000,
      contractRules: {
        unitPriceStroops: 15,
        dailyLimitUnits: 200,
        plan: "UsageBased",
        autoDeactivate: true,
      },
    });

    const step = stepVirtualMeter(twin.id, 13);
    expect(step.voltageV).toBe(182);
    expect(step.temperatureC).toBe(41);
    expect(step.solarGenerationKw).toBeGreaterThan(0);

    const scenario = runContractScenarioSimulation(twin.id, {
      hours: 24,
      weather: "overcast",
      contractRules: {
        unitPriceStroops: 20,
        dailyLimitUnits: 120,
      },
    });

    expect(scenario.simulatedHours).toBe(24);
    expect(scenario.totalUnitsConsumed).toBeGreaterThan(0);
    expect(scenario.deactivatedByContract).toBe(true);
    expect(scenario.faultsEncountered).toContain("voltage_sag");
  });
});
