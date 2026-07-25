import { Router } from "express";
import * as StellarSdk from "@stellar/stellar-sdk";
import { server, CONTRACT_ID } from "../lib/stellar.js";
import { asyncHandler } from "../lib/asyncHandler.js";

export const statsRouter = Router();

const DEFAULT_DAYS = 30;
const MAX_DAYS = 90;
const CACHE_TTL_MS = 60_000;

interface RevenueHistoryEntry {
  date: string; // YYYY-MM-DD
  revenue_xlm: number;
}

const revenueHistoryCache = new Map<
  number,
  { data: RevenueHistoryEntry[]; ts: number }
>();

/**
 * GET /api/stats/revenue-history?days=30
 *
 * Aggregates Soroban "payment" contract events by day for the requested
 * window (capped at MAX_DAYS) and returns daily revenue totals in XLM.
 */
statsRouter.get(
  "/revenue-history",
  asyncHandler(async (req, res) => {
    const requestedDays = parseInt((req.query.days as string) ?? String(DEFAULT_DAYS), 10);
    const days = Math.min(
      MAX_DAYS,
      Math.max(1, Number.isFinite(requestedDays) ? requestedDays : DEFAULT_DAYS),
    );

    const cached = revenueHistoryCache.get(days);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
      return res.json({ history: cached.data });
    }

    const history = await fetchRevenueHistory(days);
    revenueHistoryCache.set(days, { data: history, ts: Date.now() });

    res.json({ history });
  }),
);

// ── Helpers ───────────────────────────────────────────────────────────────────

async function fetchRevenueHistory(days: number): Promise<RevenueHistoryEntry[]> {
  const response = await (server as any).getEvents({
    startLedger: 1,
    filters: [
      {
        type: "contract",
        contractIds: [CONTRACT_ID],
        topics: [[StellarSdk.xdr.ScVal.scvSymbol("payment").toXDR("base64")]],
      },
    ],
    limit: 1000,
  });

  const totalsByDay = new Map<string, number>();
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  for (const event of response?.events ?? []) {
    try {
      const parsed = parsePaymentEvent(event);
      if (!parsed) continue;
      if (new Date(parsed.date).getTime() < cutoff) continue;

      const day = parsed.date.slice(0, 10); // YYYY-MM-DD
      totalsByDay.set(day, (totalsByDay.get(day) ?? 0) + parsed.amountXlm);
    } catch {
      // skip malformed events
    }
  }

  return buildDayRange(days).map((date) => ({
    date,
    revenue_xlm: totalsByDay.get(date) ?? 0,
  }));
}

function buildDayRange(days: number): string[] {
  const result: string[] = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    result.push(d.toISOString().slice(0, 10));
  }
  return result;
}

function parsePaymentEvent(event: any): { date: string; amountXlm: number } | null {
  const dataXdr = event.value ?? event.data;
  if (!dataXdr) return null;

  const dataVal = StellarSdk.xdr.ScVal.fromXDR(dataXdr, "base64");
  const native = StellarSdk.scValToNative(dataVal);
  if (!Array.isArray(native) || native.length < 1) return null;

  const amountXlm = Number(native[0]) / 10_000_000;
  const date = event.ledgerClosedAt
    ? new Date(event.ledgerClosedAt).toISOString()
    : new Date().toISOString();

  return { date, amountXlm };
}
