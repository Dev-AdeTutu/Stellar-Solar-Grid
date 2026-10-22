/**
 * Disaster recovery automation (#1060). All endpoints require X-Admin-Key.
 *
 *   GET  /api/dr/status       — active site, replication lag, RPO/RTO targets
 *   POST /api/dr/replicate    — run a replication cycle now
 *   POST /api/dr/failover     — one-click failover to the DR site ({ drill?: boolean })
 *   POST /api/dr/failback     — return traffic to the primary
 *   GET  /api/dr/history      — previous failovers / drills
 */
import { Router } from "express";
import { requireAdminKey } from "../middleware/adminAuth.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { DisasterRecovery, RPO_MS, RTO_MS, createDefaultAdapter } from "../lib/disasterRecovery.js";

export function createDisasterRecoveryRouter(dr = new DisasterRecovery(createDefaultAdapter())): Router {
  const router = Router();
  router.use(requireAdminKey);

  router.get(
    "/status",
    asyncHandler(async (_req, res) => {
      res.json({ activeSite: dr.activeSite, replication: await dr.replicationStatus(), rpoMs: RPO_MS, rtoMs: RTO_MS });
    }),
  );

  router.post(
    "/replicate",
    asyncHandler(async (_req, res) => {
      res.json(await dr.replicate());
    }),
  );

  router.post(
    "/failover",
    asyncHandler(async (req, res) => {
      try {
        const result = await dr.failover({ drill: Boolean(req.body?.drill) });
        res.status(result.ok ? 200 : 502).json(result);
      } catch (err) {
        res.status(409).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }),
  );

  router.post(
    "/failback",
    asyncHandler(async (_req, res) => {
      try {
        const result = await dr.failback();
        res.status(result.ok ? 200 : 502).json(result);
      } catch (err) {
        res.status(409).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }),
  );

  router.get("/history", (_req, res) => {
    res.json({ history: dr.history });
  });

  return router;
}

/** Schedule replication so the RPO (< 15 min) holds; defaults to every 5 minutes. */
export function startReplicationScheduler(dr: DisasterRecovery, intervalMs = 5 * 60_000): NodeJS.Timeout {
  const t = setInterval(() => {
    dr.replicate().catch((err) => console.error("[dr] replication failed", err));
  }, intervalMs);
  t.unref();
  return t;
}
