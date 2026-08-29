import { Router } from "express";
import * as StellarSdk from "@stellar/stellar-sdk";
import { server, CONTRACT_ID, stellarService } from "../lib/stellar.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { logger } from "../lib/logger.js";
import { register } from "../lib/metrics.js";

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

/** Billing plans reported by /meters-by-plan, keyed exactly as the contract names them. */
type PlanKey = "Daily" | "Weekly" | "Monthly" | "UsageBased";

type PlanBreakdown = Record<PlanKey, number> & { total: number };

function emptyPlanBreakdown(): PlanBreakdown {
  return { Daily: 0, Weekly: 0, Monthly: 0, UsageBased: 0, total: 0 };
}

/**
 * scValToNative decodes a Soroban enum either as its bare name ("Daily") or as
 * a single-key object ({ Daily: [] }), so accept both. Unknown plans return
 * null and are left out of the breakdown rather than silently miscounted.
 */
function normalizePlan(raw: unknown): PlanKey | null {
  let name: string | undefined;
  if (typeof raw === "string") {
    name = raw;
  } else if (raw && typeof raw === "object") {
    name = Object.keys(raw)[0];
  }
  switch (name) {
    case "Daily":
      return "Daily";
    case "Weekly":
      return "Weekly";
    case "Monthly":
      return "Monthly";
    case "Usage":
    case "UsageBased":
      return "UsageBased";
    default:
      return null;
  }
}

interface ContractStats {
  totalMeters: number;
  activeMeters: number;
  inactiveMeters: number;
  totalUnits: number;
  avgUnitsPerMeter: number;
  totalRevenue: number;
  avgRevenue: number;
}

interface MetricsSummary {
  mqttMessages: number;
  contractCalls: number;
  activeMeters: number;
  paymentVolumeXlm: number;
}

let meterPlanCache: { data: PlanBreakdown; expiresAt: number } | null = null;
let contractCache: { data: ContractStats; expiresAt: number } | null = null;
let metricsCache: { data: MetricsSummary; expiresAt: number } | null = null;

/**
 * GET /api/stats/revenue-history?days=30
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

/**
 * GET /api/stats/meters-by-plan
 */
statsRouter.get("/meters-by-plan", asyncHandler(async (_req, res) => {
  if (meterPlanCache && Date.now() < meterPlanCache.expiresAt) {
    return res.json(meterPlanCache.data);
  }

  const result = await stellarService.query("get_all_meters", []);
  const meters = (StellarSdk.scValToNative(result) as any[]) ?? [];
  const data = emptyPlanBreakdown();

  for (const meter of meters) {
    const plan = normalizePlan(meter?.plan);
    if (plan) data[plan] += 1;
  }

  data.total = meters.length;
  meterPlanCache = { data, expiresAt: Date.now() + 30_000 };
  res.json(data);
}));

/**
 * GET /api/stats — contract-derived meter statistics
 */
statsRouter.get("/", asyncHandler(async (_req, res) => {
  if (contractCache && Date.now() < contractCache.expiresAt) {
    return res.json(contractCache.data);
  }

  const result = await stellarService.query("get_all_meters", []);
  const meters = (StellarSdk.scValToNative(result) as any[]) ?? [];
  const total = meters.length;
  const active = meters.filter((m: any) => m.active).length;
  const units = meters.reduce((s: number, m: any) => s + Number(m.units_used), 0);

  let revenue = 0;
  const adminAddr = process.env.ADMIN_ADDRESS;
  if (adminAddr) {
    const rev = await stellarService.query("get_provider_revenue", [
      StellarSdk.nativeToScVal(adminAddr, { type: "address" }),
    ]);
    revenue = Number(StellarSdk.scValToNative(rev));
  } else {
    logger.warn("ADMIN_ADDRESS environment variable is not set; provider revenue query skipped");
  }

  const avgUnitsPerMeter = total > 0 ? units / total : 0;
  const avgRevenue = total > 0 ? revenue / total : 0;

  const data = { totalMeters: total, activeMeters: active, inactiveMeters: total - active,
    totalUnits: units, avgUnitsPerMeter, totalRevenue: revenue, avgRevenue };
  contractCache = { data, expiresAt: Date.now() + 30_000 };
  res.json(data);
}));

/**
 * GET /api/stats/summary — prom-client counter/gauge snapshot
 */
statsRouter.get("/summary", asyncHandler(async (_req, res) => {
  if (metricsCache && Date.now() < metricsCache.expiresAt) {
    return res.json(metricsCache.data);
  }

  const metrics = await register.getMetricsAsJSON();
  const find = (name: string): number => {
    const metric = metrics.find((m: any) => m.name === name);
    if (!metric?.values) return 0;
    return metric.values.reduce((acc: number, val: any) => acc + val.value, 0);
  };

  const data = {
    mqttMessages: find("solargrid_mqtt_messages_total"),
    contractCalls: find("solargrid_contract_invocations_total"),
    activeMeters: find("solargrid_active_meters"),
    paymentVolumeXlm: find("solargrid_payment_volume_xlm"),
  };
  metricsCache = { data, expiresAt: Date.now() + 15_000 };
  res.json(data);
}));

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

      const day = parsed.date.slice(0, 10);
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
