/**
 * GET /api/widgets/summary?meterId=… (#901)
 *
 * Compact payload for the iOS / Android home-screen widgets. Widgets refresh
 * every 15 minutes, so the response is kept small (<1 KB), cached server-side
 * for WIDGET_CACHE_TTL_MS, and served with an ETag so an unchanged refresh
 * costs the phone a 304 with no body.
 *
 * {
 *   "meterId": "METER1",
 *   "active": true,
 *   "balanceXlm": 12.5,
 *   "todayUnits": 3.2,
 *   "last7DaysUnits": [4.1, 3.9, 5.0, 4.4, 3.8, 4.0, 3.2],   // oldest → today
 *   "daysRemaining": 3.1,                                    // null if unknown
 *   "priceXlmPerKwh": 0.5,                                   // latest market price (#938)
 *   "alerts": [{ "id": "…", "direction": "above", "price": 0.6, "triggered": false }],
 *   "recentTransactions": [{ "type": "topup", "amount": 5, "timestamp": "…" }],
 *   "updatedAt": "2026-09-27T10:00:00.000Z"
 * }
 *
 * Price alerts (#938): GET/POST /alerts?meterId=, DELETE /alerts/:id?meterId=
 */
import crypto from "node:crypto";
import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { getOnChainMeter } from "../lib/meterOwnership.js";
import { getUsageTotals, STROOPS_PER_XLM } from "../lib/billing.js";
import { getPrediction } from "../lib/usagePrediction.js";
import { getUsageHistory } from "../lib/usageHistory.js";
import { getPriceHistory } from "../lib/backtesting.js";
import { addPriceAlert, deletePriceAlert, isTriggered, listPriceAlerts } from "../lib/priceAlerts.js";

export const widgetsRouter = Router();

const CACHE_TTL_MS = Number(process.env.WIDGET_CACHE_TTL_MS ?? 5 * 60 * 1000);
const METER_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

export type WidgetSummary = {
  meterId: string;
  active: boolean;
  balanceXlm: number;
  todayUnits: number;
  last7DaysUnits: number[];
  daysRemaining: number | null;
  priceXlmPerKwh: number | null;
  alerts: { id: string; direction: "above" | "below"; price: number; triggered: boolean }[];
  recentTransactions: { type: "topup" | "usage"; amount: number; timestamp: string }[];
  updatedAt: string;
};

const cache = new Map<string, { body: string; etag: string; storedAt: number }>();

const round1 = (v: number) => Math.round(v * 10) / 10;

async function buildSummary(meterId: string, now = new Date()): Promise<WidgetSummary | null> {
  const meter = await getOnChainMeter(meterId);
  if (!meter) return null;
  const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const last7DaysUnits: number[] = [];
  for (let i = 6; i >= 0; i--) {
    const start = new Date(todayStart - i * 86_400_000);
    const end = i === 0 ? now : new Date(start.getTime() + 86_400_000);
    last7DaysUnits.push(round1(getUsageTotals(meterId, start, end).units));
  }
  const prediction = getPrediction(meterId, meter.balance, now);
  const price = getPriceHistory().at(-1)?.price ?? null;
  const recentTransactions = getUsageHistory(meterId, { limit: 5 }).history.map((h) => {
    const delta = (h.balance_after - h.balance_before) / STROOPS_PER_XLM;
    return {
      type: delta > 0 ? ("topup" as const) : ("usage" as const),
      amount: Math.round(Math.abs(delta) * 100) / 100,
      timestamp: h.timestamp,
    };
  });
  return {
    meterId,
    active: meter.active,
    balanceXlm: Math.round((meter.balance / STROOPS_PER_XLM) * 100) / 100,
    todayUnits: last7DaysUnits[6],
    last7DaysUnits,
    daysRemaining: prediction.estimatedDaysRemaining,
    priceXlmPerKwh: price,
    alerts: listPriceAlerts(meterId).map((a) => ({
      id: a.id,
      direction: a.direction,
      price: a.price,
      triggered: price !== null && isTriggered(a, price),
    })),
    recentTransactions,
    updatedAt: now.toISOString(),
  };
}

widgetsRouter.get(
  "/summary",
  asyncHandler(async (req, res) => {
    const meterId = String(req.query.meterId ?? "");
    if (!METER_ID_RE.test(meterId)) return res.status(400).json({ error: "meterId is required" });

    let entry = cache.get(meterId);
    if (!entry || Date.now() - entry.storedAt > CACHE_TTL_MS) {
      let summary: WidgetSummary | null;
      try {
        summary = await buildSummary(meterId);
      } catch {
        // Serve the last good value rather than blanking the widget on an RPC hiccup.
        if (entry) summary = null;
        else return res.status(502).json({ error: "Query failed", code: "CONTRACT_ERROR" });
      }
      if (summary) {
        const body = JSON.stringify(summary);
        entry = { body, etag: `"${crypto.createHash("sha1").update(body).digest("base64url")}"`, storedAt: Date.now() };
        cache.set(meterId, entry);
      } else if (!entry) {
        return res.status(404).json({ error: "Meter not found", code: "METER_NOT_FOUND" });
      }
    }

    res.setHeader("Cache-Control", `private, max-age=${Math.floor(CACHE_TTL_MS / 1000)}`);
    res.setHeader("ETag", entry!.etag);
    if (req.headers["if-none-match"] === entry!.etag) return res.status(304).end();
    res.type("application/json").send(entry!.body);
  }),
);

widgetsRouter.get("/alerts", (req, res) => {
  const meterId = String(req.query.meterId ?? "");
  if (!METER_ID_RE.test(meterId)) return res.status(400).json({ error: "meterId is required" });
  res.json({ alerts: listPriceAlerts(meterId) });
});

widgetsRouter.post("/alerts", (req, res) => {
  const { meterId, direction, price } = req.body ?? {};
  if (!METER_ID_RE.test(String(meterId ?? ""))) return res.status(400).json({ error: "meterId is required" });
  if (direction !== "above" && direction !== "below")
    return res.status(400).json({ error: "direction must be above or below" });
  if (!(Number(price) > 0)) return res.status(400).json({ error: "price must be a positive number" });
  const alert = addPriceAlert(meterId, direction, Number(price));
  cache.delete(meterId);
  res.status(201).json(alert);
});

widgetsRouter.delete("/alerts/:id", (req, res) => {
  const meterId = String(req.query.meterId ?? "");
  if (!METER_ID_RE.test(meterId)) return res.status(400).json({ error: "meterId is required" });
  if (!deletePriceAlert(meterId, req.params.id)) return res.status(404).json({ error: "Alert not found" });
  cache.delete(meterId);
  res.status(204).end();
});
