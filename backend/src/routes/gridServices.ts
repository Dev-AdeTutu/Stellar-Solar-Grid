import { Router } from "express";
import { z } from "zod";
import { getFrequencyReading, getMeterGridServiceSummary, listGridServiceContributions, recordFrequencyReading, recordGridServiceProvided } from "../lib/frequencyRegulation.js";
import { getGeofence, getLocationHistory, isMeterDisabled, listGeofences, setGeofence, verifyMeterLocation } from "../lib/geofencing.js";
export const gridServicesRouter = Router();
const meterId = z.string().min(1).max(128);
const frequencyBody = z.object({ meterId, frequencyHz: z.number(), loadKw: z.number().nonnegative(), thresholdHz: z.number().positive().optional(), responseRatio: z.number().positive().max(1).optional() });
const contributionBody = z.object({ meterId, durationSeconds: z.number().positive(), priceXlmPerKwh: z.number().positive().optional() });
const fenceBody = z.object({ meterId, latitude: z.number(), longitude: z.number(), radiusMeters: z.number().positive() });
const locationBody = z.object({ meterId, latitude: z.number(), longitude: z.number() });
function body<T>(schema: z.ZodType<T>, value: unknown): T { const parsed = schema.safeParse(value); if (!parsed.success) throw Object.assign(new Error("Invalid request"), { code: "VALIDATION_ERROR" }); return parsed.data; }
function handle(res: any, action: () => unknown) { try { return res.json(action()); } catch (error) { const e = error as { code?: string; message?: string }; return res.status(e.code === "NOT_FOUND" ? 404 : 400).json({ error: e.message ?? "Request failed", code: e.code }); } }
gridServicesRouter.post("/frequency/readings", (req, res) => handle(res, () => recordFrequencyReading(body(frequencyBody, req.body))));
gridServicesRouter.post("/frequency/contributions", (req, res) => handle(res, () => recordGridServiceProvided(body(contributionBody, req.body))));
gridServicesRouter.get("/frequency/:meterId", (req, res) => res.json(getFrequencyReading(req.params.meterId) ?? null));
gridServicesRouter.get("/frequency/:meterId/summary", (req, res) => res.json(getMeterGridServiceSummary(req.params.meterId)));
gridServicesRouter.get("/frequency/:meterId/events", (req, res) => res.json({ events: listGridServiceContributions(req.params.meterId) }));
gridServicesRouter.post("/geofences", (req, res) => handle(res, () => setGeofence(body(fenceBody, req.body))));
gridServicesRouter.get("/geofences", (_req, res) => res.json({ geofences: listGeofences() }));
gridServicesRouter.post("/geofences/verify", (req, res) => handle(res, () => verifyMeterLocation(body(locationBody, req.body))));
gridServicesRouter.get("/geofences/:meterId", (req, res) => res.json({ geofence: getGeofence(req.params.meterId) ?? null, disabled: isMeterDisabled(req.params.meterId), history: getLocationHistory(req.params.meterId) }));
