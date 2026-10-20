import { Router } from "express";
import { z } from "zod";
import { balanceLoads } from "../lib/loadBalancer.js";
import {
  recordMeterReport,
  getLearnedStrategies,
  getEmergentLoadBalancing,
} from "../lib/swarmIntelligence.js";

export const loadBalancingRouter = Router();

const schema = z.object({
  capacityKw: z.number().positive(),
  pricePerKwh: z.number().nonnegative(),
  peakPriceThreshold: z.number().nonnegative().optional(),
  loads: z.array(z.object({
    id: z.string().min(1),
    demandKw: z.number().nonnegative(),
    priority: z.enum(["critical", "high", "normal", "deferrable"]),
    override: z.enum(["on", "off"]).optional(),
  })).max(1000),
});

/** POST /api/load-balancing/balance — returns which loads to switch on/off. */
loadBalancingRouter.post("/balance", (req, res) => {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues });
  res.json(balanceLoads(parsed.data));
});

const reportSchema = z.object({
  meterId: z.string().min(1),
  strategy: z.string().min(1),
  performanceScore: z.number().min(0).max(1),
  avgLoadKw: z.number().nonnegative(),
  peakLoadKw: z.number().nonnegative(),
  efficiency: z.number().min(0).max(1),
  timestamp: z.number().optional(),
});

/** POST /api/swarm/report — accepts anonymized meter performance data. */
loadBalancingRouter.post("/swarm/report", (req, res) => {
  const parsed = reportSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues });
  const result = recordMeterReport(parsed.data);
  res.json(result);
});

/** GET /api/swarm/strategies — returns learned collective strategies. */
loadBalancingRouter.get("/swarm/strategies", (_req, res) => {
  res.json(getLearnedStrategies());
});

/** GET /api/swarm/load-balancing — returns emergent load-balancing recommendations. */
loadBalancingRouter.get("/swarm/load-balancing", (_req, res) => {
  res.json(getEmergentLoadBalancing());
});