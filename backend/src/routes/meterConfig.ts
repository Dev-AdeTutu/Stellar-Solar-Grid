/**
 * Meter configuration backup endpoints (#1055).
 *
 *   POST /api/meter-config/:meterId/backup              — { config, note? } store a version
 *   GET  /api/meter-config/:meterId/versions            — version history
 *   GET  /api/meter-config/:meterId/versions/latest     — latest config (meter boot restore)
 *   GET  /api/meter-config/:meterId/versions/:version
 *   POST /api/meter-config/:meterId/restore             — { sourceMeterId, version? } (X-Admin-Key)
 *   GET  /api/meter-config/templates
 *   POST /api/meter-config/templates                    — { name, config, description? } (X-Admin-Key)
 *   POST /api/meter-config/:meterId/apply-template      — { name, overrides? } (X-Admin-Key)
 */
import { Router } from "express";
import { z } from "zod";
import { requireAdminKey } from "../middleware/adminAuth.js";
import {
  applyTemplate,
  backupConfig,
  getVersion,
  listTemplates,
  listVersions,
  restoreConfig,
  saveTemplate,
} from "../lib/meterConfigBackup.js";

export const meterConfigRouter = Router();

const configSchema = z.record(z.unknown());

meterConfigRouter.get("/templates", (_req, res) => res.json(listTemplates()));

meterConfigRouter.post("/templates", requireAdminKey, (req, res) => {
  const parsed = z.object({ name: z.string().min(1).max(64), config: configSchema, description: z.string().max(500).optional() })
    .safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Invalid template", details: parsed.error.issues });
  res.status(201).json(saveTemplate(parsed.data.name, parsed.data.config, parsed.data.description));
});

meterConfigRouter.post("/:meterId/backup", (req, res) => {
  const parsed = z.object({ config: configSchema, note: z.string().max(200).optional() }).safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Invalid config backup", details: parsed.error.issues });
  res.status(201).json(backupConfig(req.params.meterId, parsed.data.config, parsed.data.note));
});

meterConfigRouter.get("/:meterId/versions", (req, res) => res.json(listVersions(req.params.meterId)));

meterConfigRouter.get("/:meterId/versions/:version", (req, res) => {
  const v = req.params.version === "latest" ? undefined : Number(req.params.version);
  if (v !== undefined && !Number.isInteger(v)) return res.status(400).json({ error: "Invalid version" });
  const found = getVersion(req.params.meterId, v);
  if (!found) return res.status(404).json({ error: "Config version not found" });
  res.json(found);
});

meterConfigRouter.post("/:meterId/restore", requireAdminKey, (req, res) => {
  const parsed = z.object({ sourceMeterId: z.string().min(1), version: z.number().int().positive().optional() })
    .safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Invalid restore request", details: parsed.error.issues });
  try {
    res.status(201).json(restoreConfig(req.params.meterId, parsed.data.sourceMeterId, parsed.data.version));
  } catch (err) {
    res.status(404).json({ error: (err as Error).message });
  }
});

meterConfigRouter.post("/:meterId/apply-template", requireAdminKey, (req, res) => {
  const parsed = z.object({ name: z.string().min(1), overrides: configSchema.optional() }).safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Invalid template request", details: parsed.error.issues });
  try {
    res.status(201).json(applyTemplate(req.params.meterId, parsed.data.name, parsed.data.overrides));
  } catch (err) {
    res.status(404).json({ error: (err as Error).message });
  }
});
