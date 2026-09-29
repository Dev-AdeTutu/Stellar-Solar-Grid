/**
 * Contract event query API (#896)
 *
 * GET /api/events          — query indexed events (action, subject, txHash,
 *                            fromLedger, toLedger, before, limit)
 * GET /api/events/status   — indexer health: lag, last ledger, alert state
 */
import { Router } from "express";
import { getIndexerStatus, queryEvents } from "../lib/eventIndexer.js";

export const eventsRouter = Router();

const num = (v: unknown) => (v === undefined || v === "" ? undefined : Number(v));
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

eventsRouter.get("/status", (_req, res) => {
  const status = getIndexerStatus();
  res.status(status.alerting && status.running ? 503 : 200).json(status);
});

eventsRouter.get("/", (req, res) => {
  const started = performance.now();
  const events = queryEvents({
    action: str(req.query.action),
    subject: str(req.query.subject),
    txHash: str(req.query.txHash),
    fromLedger: num(req.query.fromLedger),
    toLedger: num(req.query.toLedger),
    before: num(req.query.before),
    limit: num(req.query.limit),
  });
  res.setHeader("X-Query-Time-Ms", (performance.now() - started).toFixed(2));
  res.json({
    events,
    nextBefore: events.length ? events[events.length - 1].ledger : null,
  });
});
