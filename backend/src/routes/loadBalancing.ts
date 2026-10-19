import { Router } from "express";
import { z } from "zod";
import { balanceLoads } from "../lib/loadBalancer.js";

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
