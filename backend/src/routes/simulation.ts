/**
 * Meter Virtual Twin Simulation Routes (#1010)
 *
 * POST /api/simulation/create                 — create virtual meter digital twin
 * GET  /api/simulation/meters                 — list virtual meters
 * GET  /api/simulation/meters/:id             — inspect virtual meter
 * POST /api/simulation/meters/:id/step        — step simulation by 1 hour
 * POST /api/simulation/meters/:id/scenario    — run multi-hour scenario & contract rule test
 * GET  /api/simulation/training-scenarios     — list technician training scenarios
 */
import { Router } from "express";
import {
  createVirtualMeter,
  getVirtualMeter,
  listVirtualMeters,
  runContractScenarioSimulation,
  stepVirtualMeter,
  TRAINING_SCENARIOS,
} from "../lib/meterTwinSimulation.js";

export const simulationRouter = Router();

simulationRouter.post("/create", (req, res) => {
  const body = req.body ?? {};
  const twin = createVirtualMeter({
    id: body.id ?? body.meterId,
    name: body.name,
    owner: body.owner,
    usagePattern: body.usagePattern,
    weather: body.weather,
    fault: body.fault,
    balanceStroops: body.balanceStroops !== undefined ? Number(body.balanceStroops) : undefined,
    trainingMode: body.trainingMode,
    trainingScenarioId: body.trainingScenarioId,
    contractRules: body.contractRules,
  });
  return res.status(201).json(twin);
});

simulationRouter.get("/meters", (_req, res) => {
  return res.json({ meters: listVirtualMeters() });
});

simulationRouter.get("/meters/:id", (req, res) => {
  const twin = getVirtualMeter(req.params.id);
  if (!twin) {
    return res.status(404).json({ error: "Virtual meter not found" });
  }
  return res.json(twin);
});

simulationRouter.post("/meters/:id/step", (req, res) => {
  const twin = getVirtualMeter(req.params.id);
  if (!twin) {
    return res.status(404).json({ error: "Virtual meter not found" });
  }
  const hourOfDay = req.body?.hourOfDay !== undefined ? Number(req.body.hourOfDay) : 12;
  const telemetry = stepVirtualMeter(twin.id, hourOfDay);
  return res.json({ meter: twin, telemetry });
});

simulationRouter.post("/meters/:id/scenario", (req, res) => {
  const twin = getVirtualMeter(req.params.id);
  if (!twin) {
    return res.status(404).json({ error: "Virtual meter not found" });
  }
  const result = runContractScenarioSimulation(twin.id, {
    hours: req.body?.hours !== undefined ? Number(req.body.hours) : 24,
    weather: req.body?.weather,
    fault: req.body?.fault,
    contractRules: req.body?.contractRules,
  });
  return res.json(result);
});

simulationRouter.get("/training-scenarios", (_req, res) => {
  return res.json({ scenarios: TRAINING_SCENARIOS });
});
