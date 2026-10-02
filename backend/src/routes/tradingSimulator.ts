import { Router } from "express";
import { ownsMeter } from "../lib/meterOwnership.js";
import {
  executeSimulatorTrade,
  getMarketHistory,
  getMarketQuote,
  getSimulatorAccount,
  getSimulatorLeaderboard,
  listSimulatorTrades,
  SIMULATOR_FEE_RATE,
} from "../lib/tradingSimulator.js";

export const tradingSimulatorRouter = Router();
const STELLAR_ADDRESS_RE = /^G[A-Z2-7]{55}$/;
const METER_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

async function verifiedIdentity(meterId: unknown, stellarAddress: unknown): Promise<string | null> {
  if (typeof meterId !== "string" || !METER_ID_RE.test(meterId)) return null;
  if (typeof stellarAddress !== "string" || !STELLAR_ADDRESS_RE.test(stellarAddress)) return null;
  return await ownsMeter(meterId, stellarAddress) ? stellarAddress : null;
}

tradingSimulatorRouter.get("/market", async (_req, res) => {
  const hours = Number(_req.query.hours ?? 24);
  if (!Number.isFinite(hours) || hours < 1 || hours > 168) return res.status(400).json({ error: "hours must be between 1 and 168" });
  res.setHeader("Cache-Control", "public, max-age=30");
  res.json({ ...(await getMarketHistory(hours)), feeRate: SIMULATOR_FEE_RATE });
});

tradingSimulatorRouter.get("/leaderboard", async (req, res) => {
  const limit = Math.min(100, Math.max(1, Math.trunc(Number(req.query.limit) || 20)));
  const quote = await getMarketQuote();
  const entries = getSimulatorLeaderboard(quote.pricePerKwh, limit).map(({ userId: _userId, ...account }, index) => ({
    rank: index + 1,
    ...account,
  }));
  res.json({ quote, entries });
});

tradingSimulatorRouter.get("/account", async (req, res) => {
  let userId: string | null;
  try {
    userId = await verifiedIdentity(req.query.meterId, req.query.stellarAddress);
  } catch {
    return res.status(502).json({ error: "Could not verify meter ownership", code: "CONTRACT_ERROR" });
  }
  if (!userId) return res.status(403).json({ error: "A valid wallet that owns the meter is required" });
  const quote = await getMarketQuote();
  res.json({ quote, feeRate: SIMULATOR_FEE_RATE, account: getSimulatorAccount(userId, quote.pricePerKwh), trades: listSimulatorTrades(userId) });
});

tradingSimulatorRouter.post("/trade", async (req, res) => {
  const { meterId, stellarAddress, side, quantityKwh } = req.body ?? {};
  if (side !== "buy" && side !== "sell") return res.status(400).json({ error: "side must be buy or sell" });
  if (typeof quantityKwh !== "number" || !Number.isFinite(quantityKwh) || quantityKwh < 0.001 || quantityKwh > 100_000) {
    return res.status(400).json({ error: "quantityKwh must be between 0.001 and 100000" });
  }
  let userId: string | null;
  try {
    userId = await verifiedIdentity(meterId, stellarAddress);
  } catch {
    return res.status(502).json({ error: "Could not verify meter ownership", code: "CONTRACT_ERROR" });
  }
  if (!userId) return res.status(403).json({ error: "A valid wallet that owns the meter is required" });
  const market = await getMarketQuote();
  try {
    res.status(201).json({ ...executeSimulatorTrade({ userId, side, quantityKwh, market }), feeRate: SIMULATOR_FEE_RATE });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Trade rejected";
    return res.status(409).json({ error: message });
  }
});