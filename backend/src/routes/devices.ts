/**
 * Energy device registry endpoints (#897).
 *
 *   POST   /api/devices                                  — register a device
 *   GET    /api/devices?owner=&type=&status=&meterId=    — list devices
 *   GET    /api/devices/maintenance/due?withinDays=7     — maintenance due across all devices
 *   GET    /api/devices/certifications/expiring?withinDays=30
 *   GET    /api/devices/:id                              — device + certs + maintenance
 *   PATCH  /api/devices/:id                              — update status/location/specs/meter link
 *   DELETE /api/devices/:id
 *   POST   /api/devices/:id/certifications
 *   DELETE /api/devices/:id/certifications/:certId
 *   POST   /api/devices/:id/maintenance                  — schedule recurring maintenance
 *   POST   /api/devices/:id/maintenance/:scheduleId/complete
 *   DELETE /api/devices/:id/maintenance/:scheduleId
 *   POST   /api/devices/:id/performance                  — HTTP telemetry (alternative to MQTT)
 *   GET    /api/devices/:id/performance?days=7           — readings + summary
 */
import { Router } from "express";
import { z } from "zod";
import {
  DEVICE_STATUSES,
  DEVICE_TYPES,
  DeviceConflictError,
  addCertification,
  completeMaintenance,
  deleteCertification,
  deleteDevice,
  deleteMaintenance,
  getDevice,
  getPerformanceSummary,
  getStabilityReport,
  listCertifications,
  listDevices,
  listDueMaintenance,
  listExpiringCertifications,
  listMaintenance,
  listPerformance,
  recordPerformance,
  registerDevice,
  scheduleMaintenance,
  updateDevice,
} from "../lib/deviceRegistry.js";

export const devicesRouter = Router();

const isoDate = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "must be an ISO-8601 date");
const specsSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]));

export const registerSchema = z.object({
  type: z.enum(DEVICE_TYPES),
  owner: z.string().min(1).max(100),
  manufacturer: z.string().min(1).max(100),
  model: z.string().min(1).max(100),
  serialNumber: z.string().min(1).max(100),
  meterId: z.string().max(64).nullish(),
  location: z.string().max(200).nullish(),
  installedAt: isoDate.nullish(),
  specs: specsSchema.optional(),
}).superRefine((device, ctx) => {
  if (device.type !== "battery") return;
  const capacity = device.specs?.capacityKwh;
  if (typeof capacity !== "number" || capacity <= 0) {
    ctx.addIssue({ code: "custom", path: ["specs", "capacityKwh"], message: "battery capacityKwh must be greater than zero" });
  }
  const chargeBelow = device.specs?.chargePriceBelow;
  const dischargeAbove = device.specs?.dischargePriceAbove;
  if (device.specs?.automationEnabled === true) {
    if (typeof chargeBelow !== "number" || typeof dischargeAbove !== "number") {
      ctx.addIssue({ code: "custom", path: ["specs"], message: "automated batteries require chargePriceBelow and dischargePriceAbove" });
    } else if (chargeBelow >= dischargeAbove) {
      ctx.addIssue({ code: "custom", path: ["specs", "chargePriceBelow"], message: "charge price must be lower than discharge price" });
    }
  }
  for (const [key, price] of [["chargePriceBelow", chargeBelow], ["dischargePriceAbove", dischargeAbove]] as const) {
    if (typeof price === "number" && price < 0) {
      ctx.addIssue({ code: "custom", path: ["specs", key], message: "price thresholds cannot be negative" });
    }
  }
});

export const updateSchema = z.object({
  meterId: z.string().max(64).nullable().optional(),
  location: z.string().max(200).nullable().optional(),
  installedAt: isoDate.nullable().optional(),
  status: z.enum(DEVICE_STATUSES).optional(),
  specs: specsSchema.optional(),
});

export const certSchema = z.object({
  standard: z.string().min(1).max(100),
  issuer: z.string().min(1).max(100),
  certificateNumber: z.string().max(100).nullish(),
  issuedAt: isoDate,
  expiresAt: isoDate.nullish(),
  documentUrl: z.string().url().nullish(),
});

export const maintenanceSchema = z.object({
  task: z.string().min(1).max(200),
  intervalDays: z.number().int().min(1).max(3650),
  nextDueAt: isoDate.optional(),
  notes: z.string().max(1000).nullish(),
});

export const performanceSchema = z.object({
  recordedAt: isoDate.optional(),
  powerW: z.number().min(0).optional(),
  energyKwh: z.number().min(0).optional(),
  voltageV: z.number().optional(),
  frequencyHz: z.number().positive().max(100).optional(),
  temperatureC: z.number().optional(),
  efficiency: z.number().min(0).max(1).optional(),
  stateOfCharge: z.number().min(0).max(1).optional(),
  chargedEnergyKwh: z.number().min(0).optional(),
  dischargedEnergyKwh: z.number().min(0).optional(),
});

function badRequest(res: any, error: z.ZodError) {
  return res.status(400).json({ error: "Validation failed", details: z.flattenError(error).fieldErrors });
}

function intParam(v: unknown, fallback: number, max: number) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(max, Math.trunc(n)) : fallback;
}

devicesRouter.post("/", (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error);
  try {
    res.status(201).json(registerDevice(parsed.data));
  } catch (err) {
    if (err instanceof DeviceConflictError) return res.status(409).json({ error: err.message });
    throw err;
  }
});

devicesRouter.get("/", (req, res) => {
  const { owner, type, status, meterId } = req.query as Record<string, string | undefined>;
  if (type && !DEVICE_TYPES.includes(type as any)) {
    return res.status(400).json({ error: `type must be one of ${DEVICE_TYPES.join(", ")}` });
  }
  if (status && !DEVICE_STATUSES.includes(status as any)) {
    return res.status(400).json({ error: `status must be one of ${DEVICE_STATUSES.join(", ")}` });
  }
  res.json({
    devices: listDevices({
      owner,
      type: type as any,
      status: status as any,
      meterId,
      limit: intParam(req.query.limit, 100, 500),
      offset: Number(req.query.offset) || 0,
    }),
  });
});

devicesRouter.get("/maintenance/due", (req, res) => {
  res.json({ maintenance: listDueMaintenance(intParam(req.query.withinDays, 7, 365)) });
});

devicesRouter.get("/certifications/expiring", (req, res) => {
  res.json({ certifications: listExpiringCertifications(intParam(req.query.withinDays, 30, 365)) });
});

devicesRouter.get("/:id", (req, res) => {
  const device = getDevice(req.params.id);
  if (!device) return res.status(404).json({ error: "Device not found" });
  res.json({
    ...device,
    certifications: listCertifications(device.id),
    maintenance: listMaintenance(device.id),
  });
});

devicesRouter.patch("/:id", (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error);
  const device = updateDevice(req.params.id, parsed.data);
  if (!device) return res.status(404).json({ error: "Device not found" });
  res.json(device);
});

devicesRouter.delete("/:id", (req, res) => {
  if (!deleteDevice(req.params.id)) return res.status(404).json({ error: "Device not found" });
  res.status(204).end();
});

devicesRouter.post("/:id/certifications", (req, res) => {
  if (!getDevice(req.params.id)) return res.status(404).json({ error: "Device not found" });
  const parsed = certSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error);
  res.status(201).json(addCertification(req.params.id, parsed.data));
});

devicesRouter.delete("/:id/certifications/:certId", (req, res) => {
  if (!deleteCertification(req.params.id, req.params.certId)) {
    return res.status(404).json({ error: "Certification not found" });
  }
  res.status(204).end();
});

devicesRouter.post("/:id/maintenance", (req, res) => {
  if (!getDevice(req.params.id)) return res.status(404).json({ error: "Device not found" });
  const parsed = maintenanceSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error);
  res.status(201).json(scheduleMaintenance(req.params.id, parsed.data));
});

devicesRouter.post("/:id/maintenance/:scheduleId/complete", (req, res) => {
  const performedAt = req.body?.performedAt;
  if (performedAt !== undefined && !isoDate.safeParse(performedAt).success) {
    return res.status(400).json({ error: "performedAt must be an ISO-8601 date" });
  }
  const schedule = completeMaintenance(req.params.id, req.params.scheduleId, performedAt);
  if (!schedule) return res.status(404).json({ error: "Maintenance schedule not found" });
  res.json(schedule);
});

devicesRouter.delete("/:id/maintenance/:scheduleId", (req, res) => {
  if (!deleteMaintenance(req.params.id, req.params.scheduleId)) {
    return res.status(404).json({ error: "Maintenance schedule not found" });
  }
  res.status(204).end();
});

devicesRouter.post("/:id/performance", (req, res) => {
  if (!getDevice(req.params.id)) return res.status(404).json({ error: "Device not found" });
  const parsed = performanceSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error);
  const device = getDevice(req.params.id)!;
  if (
    device.type !== "battery" &&
    [parsed.data.stateOfCharge, parsed.data.chargedEnergyKwh, parsed.data.dischargedEnergyKwh].some(
      (value) => value !== undefined,
    )
  ) {
    return res.status(400).json({ error: "storage telemetry is only valid for battery devices" });
  }
  recordPerformance(req.params.id, parsed.data);
  res.status(202).json({ accepted: true });
});

devicesRouter.get("/:id/performance", (req, res) => {
  if (!getDevice(req.params.id)) return res.status(404).json({ error: "Device not found" });
  const days = intParam(req.query.days, 7, 90);
  res.json({
    summary: getPerformanceSummary(req.params.id, days),
    readings: listPerformance(req.params.id, days),
  });
});

devicesRouter.get("/:id/stability", (req, res) => {
  if (!getDevice(req.params.id)) return res.status(404).json({ error: "Device not found" });
  const days = intParam(req.query.days, 7, 90);
  res.json(getStabilityReport(req.params.id, days));
});
