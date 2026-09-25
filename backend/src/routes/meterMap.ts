import { Router } from "express";
import { searchMetersByLocationIndex } from "../lib/meterMetadataIndex.js";

export const meterMapRouter = Router();

meterMapRouter.get("/", (_req, res) => {
  const { results } = searchMetersByLocationIndex("", 5000, 0);
  const points = results.flatMap((record) => {
    let metadata: Record<string, unknown> = {};
    try { metadata = record.metadata ? JSON.parse(record.metadata) : {}; } catch { /* ignore malformed optional metadata */ }
    const latitude = Number(metadata.latitude ?? metadata.lat);
    const longitude = Number(metadata.longitude ?? metadata.lng ?? metadata.lon);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return [];
    return [{ meter_id: record.meter_id, latitude, longitude, active: metadata.active !== false, usage: Number(metadata.usage ?? metadata.units_used ?? 0), region: typeof metadata.region === "string" ? metadata.region : undefined, provider: typeof metadata.provider === "string" ? metadata.provider : undefined }];
  });
  res.json({ points });
});
