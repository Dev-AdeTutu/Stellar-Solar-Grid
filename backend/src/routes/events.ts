/**
 * Contract event query & replay API (#896, #1007)
 *
 * GET  /api/events          — query indexed events (action, subject, txHash,
 *                             fromLedger, toLedger, before, limit)
 * GET  /api/events/status   — indexer health: lag, last ledger, alert state
 * POST /api/events/replay   — replay events across a block range and reconstruct state (#1007)
 * GET  /api/events/state/:block — reconstruct state at a specific block (#1007)
 * GET  /api/events/compare  — compare historical state vs current state (#1007)
 */
import { Router } from "express";
import { getIndexerStatus, queryEvents } from "../lib/eventIndexer.js";
import {
  compareContractStates,
  reconstructStateAtBlock,
  replayEvents,
} from "../lib/eventReplay.js";

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

/**
 * POST /api/events/replay
 * Replays events from a block/ledger range and returns reconstructed state and optional comparison.
 */
eventsRouter.post("/replay", (req, res) => {
  const body = req.body ?? {};
  const fromBlock = num(body.fromBlock ?? body.fromLedger ?? 0);
  const toBlock = num(body.toBlock ?? body.toLedger);
  const compareWithCurrent = Boolean(body.compareWithCurrent);
  const subject = str(body.subject ?? body.meterId);
  const action = str(body.action);

  if (fromBlock !== undefined && (!Number.isFinite(fromBlock) || fromBlock < 0)) {
    return res.status(400).json({ error: "Invalid fromBlock parameter" });
  }
  if (toBlock !== undefined && (!Number.isFinite(toBlock) || toBlock < (fromBlock ?? 0))) {
    return res.status(400).json({ error: "Invalid toBlock parameter" });
  }

  const replayResult = replayEvents({
    fromBlock,
    toBlock,
    subject,
    action,
  });

  const comparison =
    compareWithCurrent && toBlock !== undefined
      ? compareContractStates(toBlock, undefined, subject)
      : undefined;

  return res.json({
    fromBlock: replayResult.fromBlock,
    toBlock: replayResult.toBlock,
    eventsReplayed: replayResult.events.length,
    events: replayResult.events,
    state: replayResult.state,
    ...(comparison ? { comparison } : {}),
  });
});

/**
 * GET /api/events/state/:block
 * Reconstructs contract state at a specific block number.
 */
eventsRouter.get("/state/:block", (req, res) => {
  const block = Number(req.params.block);
  if (!Number.isFinite(block) || block < 0) {
    return res.status(400).json({ error: "Invalid block number" });
  }
  const subject = str(req.query.subject ?? req.query.meterId);
  const state = reconstructStateAtBlock(block, subject);
  return res.json(state);
});

/**
 * GET /api/events/compare
 * Compares historical state at `historicalBlock` against `currentBlock` (or latest).
 */
eventsRouter.get("/compare", (req, res) => {
  const historicalBlock = num(req.query.historicalBlock ?? req.query.block);
  const currentBlock = num(req.query.currentBlock);
  const subject = str(req.query.subject ?? req.query.meterId);

  if (historicalBlock === undefined || !Number.isFinite(historicalBlock) || historicalBlock < 0) {
    return res.status(400).json({ error: "historicalBlock query parameter is required" });
  }

  const comparison = compareContractStates(historicalBlock, currentBlock, subject);
  return res.json(comparison);
});

