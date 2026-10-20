/**
 * Predictive grid capacity planning (#1050). See docs/CAPACITY_PLANNING.md.
 *
 *   GET  /api/capacity-planning?horizon=&scenario=     — forecasts for all regions + recommendations
 *   GET  /api/capacity-planning/:region                — forecast, scenarios and backtest accuracy
 *   POST /api/capacity-planning/:region/observations   — record { month, meters, peakKw }
 *   PUT  /api/capacity-planning/:region/capacity       — set { capacityKw }
 */
import { Router } from "express";
import {
  SCENARIOS,
  backtestAccuracy,
  forecastRegion,
  listRegions,
  recommendInvestments,
  recordObservation,
  setCapacity,
  type Scenario,
} from "../lib/capacityPlanning.js";

export const capacityPlanningRouter = Router();

function parseQuery(q: Record<string, unknown>): { horizon: number; scenario: Scenario } | string {
  const horizon = q.horizon === undefined ? 24 : Number(q.horizon);
  const scenario = (q.scenario ?? "baseline") as Scenario;
  if (!Number.isInteger(horizon) || horizon < 1 || horizon > 120) return "horizon must be an integer 1-120";
  if (!(scenario in SCENARIOS)) return `scenario must be one of ${Object.keys(SCENARIOS).join(", ")}`;
  return { horizon, scenario };
}

capacityPlanningRouter.get("/", (req, res) => {
  const p = parseQuery(req.query);
  if (typeof p === "string") return res.status(400).json({ error: p });
  res.json({
    scenario: p.scenario,
    forecasts: listRegions().map((r) => forecastRegion(r, p.horizon, p.scenario)),
    recommendations: recommendInvestments(p.horizon, p.scenario),
  });
});

capacityPlanningRouter.get("/:region", (req, res) => {
  const p = parseQuery(req.query);
  if (typeof p === "string") return res.status(400).json({ error: p });
  const { region } = req.params;
  res.json({
    forecast: forecastRegion(region, p.horizon, p.scenario),
    scenarios: Object.fromEntries((Object.keys(SCENARIOS) as Scenario[]).map((s) => [s, forecastRegion(region, p.horizon, s).bottleneckInMonths])),
    accuracy: backtestAccuracy(region),
  });
});

capacityPlanningRouter.post("/:region/observations", (req, res) => {
  const { month, meters, peakKw } = req.body ?? {};
  if (typeof month !== "string" || !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: "month must be YYYY-MM" });
  if (!(Number(meters) >= 0) || !(Number(peakKw) >= 0)) return res.status(400).json({ error: "meters and peakKw must be non-negative numbers" });
  res.status(201).json(recordObservation({ region: req.params.region, month, meters: Number(meters), peakKw: Number(peakKw) }));
});

capacityPlanningRouter.put("/:region/capacity", (req, res) => {
  const capacityKw = Number(req.body?.capacityKw);
  if (!(capacityKw > 0)) return res.status(400).json({ error: "capacityKw must be a positive number" });
  setCapacity(req.params.region, capacityKw);
  res.json({ region: req.params.region, capacityKw });
});
