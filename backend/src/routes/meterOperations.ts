import { Router } from "express";
import type { StellarService } from "../lib/stellar.js";
import * as StellarSdk from "@stellar/stellar-sdk";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireAdminKey } from "../middleware/adminAuth.js";
import { validateRequest } from "../lib/validation.js";
import { getEnergyMix } from "../lib/usageEvents.js";
import { writeLimiter } from "../middleware/rateLimit.js";
import { loadDistribution, LoadRuleSchema, saveLoadRule } from "../lib/loadBalancing.js";
import { meterSlaReport, slaAlerts, slaTargets, slaTrends, SlaTargetSchema, saveSlaTarget } from "../lib/meterSla.js";
import { DeviceIdSchema } from "../iot/telemetrySchemas.js";

const WindowSchema = z.object({ since: z.iso.datetime().optional(), until: z.iso.datetime().optional() }).strict();

export function createMeterOperationsRouter(stellar: StellarService) {
  const router = Router();
  const registered = async (id: string) => {
    if (!DeviceIdSchema.safeParse(id).success) return false;
    const value = await stellar.query("get_meter", [StellarSdk.nativeToScVal(id, { type: "string" })]);
    return Boolean(StellarSdk.scValToNative(value));
  };
  const ensure = async (id: string) => {
    try { return await registered(id); } catch { return false; }
  };
  router.get("/meters/:meterId/energy-mix", asyncHandler(async (req, res) => {
    const parsed = WindowSchema.safeParse(req.query);
    if (!parsed.success || !DeviceIdSchema.safeParse(req.params.meterId).success) return res.status(400).json({ error: "Invalid meter or ISO UTC window", code: "VALIDATION_ERROR" });
    const since = parsed.data.since ?? "1970-01-01T00:00:00.000Z";
    const until = parsed.data.until ?? new Date().toISOString();
    if (Date.parse(since) >= Date.parse(until) || Date.parse(until) > Date.now()) return res.status(400).json({ error: "Require since < until <= now", code: "VALIDATION_ERROR" });
    if (!await ensure(req.params.meterId)) return res.status(404).json({ error: "Meter not found", code: "METER_NOT_FOUND" });
    res.json(getEnergyMix(req.params.meterId, new Date(since).toISOString(), new Date(until).toISOString()));
  }));

  router.get("/load-balancing", requireAdminKey, (_req, res) => res.json({ groups: loadDistribution() }));
  router.put("/load-balancing/rules/:groupId", requireAdminKey, writeLimiter, validateRequest({ body: LoadRuleSchema }), asyncHandler(async (req, res) => {
    const rule = LoadRuleSchema.parse(req.body);
    if (rule.id !== req.params.groupId) return res.status(400).json({ error: "Rule ID must match route", code: "VALIDATION_ERROR" });
    for (const id of new Set([rule.controllerId, ...rule.members.map(m => m.meterId)])) {
      if (!await ensure(id)) return res.status(404).json({ error: `Device ${id} is not registered`, code: "METER_NOT_FOUND" });
    }
    try { res.json(saveLoadRule(rule)); }
    catch (error) {
      if ((error as { status?: number }).status === 409) return res.status(409).json({ error: (error as Error).message, code: "UNRESOLVED_COMMAND" });
      throw error;
    }
  }));

  router.get("/sla", requireAdminKey, (_req, res) => res.json({ meters: slaTargets().map(t => ({ ...t, ...meterSlaReport(t.meterId), trends: slaTrends(t.meterId) })), alerts: slaAlerts() }));
  router.get("/meters/:meterId/sla", requireAdminKey, asyncHandler(async (req, res) => {
    if (!await ensure(req.params.meterId)) return res.status(404).json({ error: "Meter not found", code: "METER_NOT_FOUND" });
    const result = meterSlaReport(req.params.meterId);
    if (!result) return res.status(404).json({ error: "SLA not configured", code: "SLA_NOT_CONFIGURED" });
    res.json({ ...result, trends: slaTrends(req.params.meterId), alerts: slaAlerts(req.params.meterId) });
  }));
  router.put("/meters/:meterId/sla", requireAdminKey, writeLimiter, validateRequest({ body: SlaTargetSchema }), asyncHandler(async (req, res) => {
    if (!await ensure(req.params.meterId)) return res.status(404).json({ error: "Meter not found", code: "METER_NOT_FOUND" });
    res.json(saveSlaTarget(req.params.meterId, req.body));
  }));
  return router;
}
