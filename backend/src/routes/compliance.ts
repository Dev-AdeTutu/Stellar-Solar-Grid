import { Router } from "express";
import { complianceEngine, DEFAULT_RULES } from "../lib/compliance.js";

export const complianceRouter = Router();

/** Continuous monitoring: evaluate every non-GET API operation. */
export function complianceMonitor(req: any, _res: any, next: any) {
  if (req.method !== "GET" && !req.path.startsWith("/api/compliance")) {
    const body = req.body ?? {};
    complianceEngine.evaluate({
      type: req.path.includes("payment") ? "payment" : req.path.includes("usage") ? "usage" : "write",
      meterId: body.meter_id ?? body.meterId,
      amount: body.amount !== undefined ? Number(body.amount) : undefined,
      actor: body.owner ?? body.payer ?? body.actor,
    });
  }
  next();
}

complianceRouter.get("/rules", (_req, res) => {
  res.json(DEFAULT_RULES.map(({ id, description, severity }) => ({ id, description, severity })));
});

complianceRouter.post("/check", (req, res) => {
  res.json({ results: complianceEngine.evaluate(req.body) });
});

complianceRouter.get("/audit", (req, res) => {
  res.json(complianceEngine.auditTrail(Number(req.query.since ?? 0)));
});

complianceRouter.get("/report", (req, res) => {
  res.json(complianceEngine.report(Number(req.query.since ?? 0)));
});
