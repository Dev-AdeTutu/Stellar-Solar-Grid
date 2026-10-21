import { z } from "zod";
import { UsageUpdateSchema } from "../lib/validation.js";

export const DeviceIdSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);
const safeUnits = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const EnergySourcesSchema = z.object({ solar: safeUnits, grid: safeUnits, battery: safeUnits }).strict();
export type EnergySources = z.infer<typeof EnergySourcesSchema>;

/** New source-aware readings require a firmware-generated stable ID for durable replay protection. */
export const SourceUsageSchema = UsageUpdateSchema.extend({
  readingId: z.string().min(1).max(128),
  energySource: z.enum(["solar", "grid", "battery"]).optional(),
  energySources: EnergySourcesSchema.optional(),
}).superRefine((v, ctx) => {
  if (!Number.isSafeInteger(v.units) || !Number.isSafeInteger(v.cost)) {
    ctx.addIssue({ code: "custom", message: "units and cost must be safe integers" });
  }
  if (Boolean(v.energySource) === Boolean(v.energySources)) {
    ctx.addIssue({ code: "custom", message: "Supply exactly one of energySource or energySources" });
  }
  if (v.energySources && Object.values(v.energySources).reduce((a, b) => a + b, 0) !== v.units) {
    ctx.addIssue({ code: "custom", message: "Source units must sum exactly to units" });
  }
});

/** Heartbeats use server receipt time, not an untrusted device clock. Watts are not energy units. */
export const TelemetrySchema = z.object({
  version: z.literal(1),
  sequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  loadWatts: z.number().finite().min(0).max(1_000_000_000),
  available: z.boolean(),
}).strict();
export type Telemetry = z.infer<typeof TelemetrySchema>;

export const TransferAckSchema = z.object({
  version: z.literal(1), commandId: z.string().uuid(),
  status: z.enum(["executed", "rejected"]),
  reason: z.string().max(500).optional(),
}).strict();
