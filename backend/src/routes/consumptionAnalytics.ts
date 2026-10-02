/**
 * Energy consumption pattern analysis API (#928).
 *
 *   GET  /api/analytics/patterns/:meterId            — full analysis (patterns,
 *                                                      anomalies, forecast, insights)
 *   GET  /api/analytics/patterns/:meterId/trends     — actuals + forecast series
 *   GET  /api/analytics/patterns/:meterId/patterns   — recognised consumption patterns
 *   GET  /api/analytics/patterns/:meterId/anomalies  — flagged anomalies
 *   POST /api/analytics/patterns/anomalies/:id/ack  — acknowledge a flagged anomaly
 *   GET  /api/analytics/patterns/:meterId/weekly     — weekly insights report(s)
 *   POST /api/analytics/patterns/:meterId/weekly     — generate the weekly report now
 */
import { Router, Request, Response } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireAdminKey } from "../middleware/adminAuth.js";
import { z } from "zod";
import {
  acknowledgeAnomaly,
  analyzeConsumption,
  generateAllWeeklyReports,
  generateWeeklyInsightsReport,
  listFlaggedAnomalies,
  listWeeklyReports,
  getTrendSeries,
  retrainAllConsumptionModels,
} from "../lib/consumptionAnalytics.js";

export const consumptionAnalyticsRouter = Router();

const MeterId = z.string().min(1).max(128);
const AnomalyId = z.string().min(1).max(256);

const AnalysisQuery = z.object({
  days: z.coerce.number().int().min(1).max(365).optional(),
  forecastHours: z.coerce.number().int().min(1).max(720).optional(),
  tariffXlmPerKwh: z.coerce.number().min(0).optional(),
});

const AnomalyQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
  severity: z.enum(["info", "warning", "critical"]).optional(),
  includeAcknowledged: z
    .union([z.literal("true"), z.literal("false")])
    .transform((value) => value === "true")
    .optional(),
});

const WeeklyQuery = z.object({
  limit: z.coerce.number().int().min(1).max(52).optional(),
});

const WeeklyBody = z.object({
  tariffXlmPerKwh: z.number().min(0).optional(),
});

function validationError(res: Response, error: z.ZodError) {
  return res.status(400).json({ error: "Invalid request", code: "VALIDATION_ERROR", details: error.flatten() });
}

consumptionAnalyticsRouter.get(
  "/:meterId",
  asyncHandler(async (req: Request, res: Response) => {
    const meterId = MeterId.safeParse(req.params.meterId);
    if (!meterId.success) return res.status(400).json({ error: "meterId is required" });
    const query = AnalysisQuery.safeParse(req.query);
    if (!query.success) return validationError(res, query.error);
    res.json(analyzeConsumption(meterId.data, query.data));
  }),
);

consumptionAnalyticsRouter.get(
  "/:meterId/trends",
  asyncHandler(async (req: Request, res: Response) => {
    const meterId = MeterId.safeParse(req.params.meterId);
    if (!meterId.success) return res.status(400).json({ error: "meterId is required" });
    const query = AnalysisQuery.pick({ days: true, forecastHours: true }).safeParse(req.query);
    if (!query.success) return validationError(res, query.error);
    res.json(getTrendSeries(meterId.data, query.data));
  }),
);

consumptionAnalyticsRouter.get(
  "/:meterId/patterns",
  asyncHandler(async (req: Request, res: Response) => {
    const meterId = MeterId.safeParse(req.params.meterId);
    if (!meterId.success) return res.status(400).json({ error: "meterId is required" });
    const analysis = analyzeConsumption(meterId.data, { persistAnomalies: false });
    res.json({
      meterId: analysis.meterId,
      accuracyPct: analysis.accuracyPct,
      sufficientData: analysis.sufficientData,
      patterns: analysis.patterns,
    });
  }),
);

consumptionAnalyticsRouter.get(
  "/:meterId/anomalies",
  asyncHandler(async (req: Request, res: Response) => {
    const meterId = MeterId.safeParse(req.params.meterId);
    if (!meterId.success) return res.status(400).json({ error: "meterId is required" });
    const query = AnomalyQuery.safeParse(req.query);
    if (!query.success) return validationError(res, query.error);
    res.json({
      anomalies: listFlaggedAnomalies(meterId.data, query.data),
      count: listFlaggedAnomalies(meterId.data, query.data).length,
    });
  }),
);

consumptionAnalyticsRouter.post(
  "/anomalies/:id/ack",
  asyncHandler(async (req: Request, res: Response) => {
    const id = AnomalyId.safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ error: "id is required" });
    const anomaly = acknowledgeAnomaly(id.data);
    if (!anomaly) return res.status(404).json({ error: "Anomaly not found" });
    res.json(anomaly);
  }),
);

consumptionAnalyticsRouter.get(
  "/:meterId/weekly",
  asyncHandler(async (req: Request, res: Response) => {
    const meterId = MeterId.safeParse(req.params.meterId);
    if (!meterId.success) return res.status(400).json({ error: "meterId is required" });
    const query = WeeklyQuery.safeParse(req.query);
    if (!query.success) return validationError(res, query.error);
    const reports = listWeeklyReports(meterId.data, query.data.limit ?? 12);
    res.json({ reports, count: reports.length });
  }),
);

consumptionAnalyticsRouter.post(
  "/:meterId/weekly",
  asyncHandler(async (req: Request, res: Response) => {
    const meterId = MeterId.safeParse(req.params.meterId);
    if (!meterId.success) return res.status(400).json({ error: "meterId is required" });
    const body = WeeklyBody.safeParse(req.body ?? {});
    if (!body.success) return validationError(res, body.error);
    res.json(generateWeeklyInsightsReport(meterId.data, body.data));
  }),
);

// Fleet-wide retraining and weekly report generation are operator actions.
consumptionAnalyticsRouter.post(
  "/retrain",
  requireAdminKey,
  asyncHandler(async (_req: Request, res: Response) => {
    res.json({ ...retrainAllConsumptionModels(), ...generateAllWeeklyReports() });
  }),
);
