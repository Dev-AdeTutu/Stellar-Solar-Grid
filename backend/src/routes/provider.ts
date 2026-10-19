/**
 * Energy provider endpoints.
 *
 * Provides read/write access to provider-specific data:
 *   GET  /api/provider          — provider revenue and meter summary
 *   POST /api/provider/webhook  — register or replace the low-balance webhook URL
 *                                  (alias for POST /api/webhooks/low-balance, kept
 *                                   here for a cleaner provider-facing namespace)
 */

import { Router } from "express";
import * as StellarSdk from "@stellar/stellar-sdk";
import ExcelJS from "exceljs";
import { stellarService } from "../lib/stellar.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireAdminKey } from "../middleware/adminAuth.js";
import { registerWebhook } from "../lib/webhookRegistry.js";
import { logger } from "../lib/logger.js";
import { z } from "zod";
import { validateRequest } from "../lib/validation.js";
import { getRevenueEvents, type RevenueEventRecord } from "../lib/revenueStore.js";
import {
  buildRevenueAnalyticsSummary,
  stroopsToXlm,
  type RevenueGranularity,
  type RevenueRow,
} from "../lib/revenueAnalytics.js";
import { createPagedTextPdf } from "../lib/pdf.js";

export const providerRouter = Router();

function toRevenueRow(e: RevenueEventRecord): RevenueRow {
  return {
    paymentId: e.payment_id,
    meterId: e.meter_id,
    amount: Number(e.amount),
    payer: e.payer,
    region: e.region,
    createdAt: e.created_at,
  };
}

function parseAnalyticsQuery(req: {
  query: Record<string, unknown>;
}): { from: Date; to: Date; granularity: RevenueGranularity } {
  const now = new Date();
  const to = (() => {
    const raw = req.query.to;
    if (typeof raw === "string" && raw.trim()) {
      const d = new Date(raw);
      if (!Number.isNaN(d.getTime())) return d;
    }
    return now;
  })();
  const from = (() => {
    const raw = req.query.from;
    if (typeof raw === "string" && raw.trim()) {
      const d = new Date(raw);
      if (!Number.isNaN(d.getTime())) return d;
    }
    // Default window: trailing 12 months, so monthly/yearly trends are
    // meaningful out of the box.
    const d = new Date(to);
    d.setUTCMonth(d.getUTCMonth() - 12);
    return d;
  })();
  const granularity: RevenueGranularity =
    req.query.granularity === "daily" || req.query.granularity === "yearly"
      ? (req.query.granularity as RevenueGranularity)
      : "monthly";
  return { from, to, granularity };
}

function buildSummaryFromQuery(query: Record<string, unknown>) {
  const { from, to, granularity } = parseAnalyticsQuery({ query });
  const allRows = getRevenueEvents().map(toRevenueRow);
  const windowRows = allRows.filter((r) => {
    const t = new Date(r.createdAt).getTime();
    return !Number.isNaN(t) && t >= from.getTime() && t <= to.getTime();
  });
  return buildRevenueAnalyticsSummary(allRows, windowRows, from, to, granularity);
}

// 30-second cache so repeated dashboard polls don't hammer the RPC node.
let revenueCache: { data: object; expiresAt: number } | null = null;

/**
 * GET /api/provider
 *
 * Returns the energy provider's revenue and an aggregate summary of all
 * meters on the network.  Requires the X-Admin-Key header.
 *
 * Response shape:
 * ```json
 * {
 *   "provider":       "G...",
 *   "totalRevenue":   12500000,
 *   "totalMeters":    42,
 *   "activeMeters":   37,
 *   "totalUnitsUsed": 182400
 * }
 * ```
 *
 * Cache TTL: 30 seconds.
 */
providerRouter.get(
  "/",
  requireAdminKey,
  asyncHandler(async (_req, res) => {
    if (revenueCache && Date.now() < revenueCache.expiresAt) {
      return res.json(revenueCache.data);
    }

    // Fetch all meters for aggregate stats
    const allMetersResult = await stellarService.query("get_all_meters", []);
    const meters = (StellarSdk.scValToNative(allMetersResult) as any[]) ?? [];
    const totalMeters = meters.length;
    const activeMeters = meters.filter((m: any) => m.active).length;
    const totalUnitsUsed = meters.reduce(
      (sum: number, m: any) => sum + Number(m.units_used ?? 0),
      0,
    );

    // Fetch provider revenue
    let totalRevenue = 0;
    const adminAddr = process.env.ADMIN_ADDRESS;
    if (adminAddr) {
      const rev = await stellarService.query("get_provider_revenue", [
        StellarSdk.nativeToScVal(adminAddr, { type: "address" }),
      ]);
      totalRevenue = Number(StellarSdk.scValToNative(rev));
    }

    const data = {
      provider: adminAddr ?? null,
      totalRevenue,
      totalMeters,
      activeMeters,
      totalUnitsUsed,
    };

    revenueCache = { data, expiresAt: Date.now() + 30_000 };
    return res.json(data);
  }),
);

/**
 * POST /api/provider/webhook
 *
 * Register or replace the low-balance webhook URL for this provider.
 * When a meter's balance drops below LOW_BALANCE_THRESHOLD, the IoT bridge
 * will POST a low_balance event to this URL.
 *
 * Body:
 * ```json
 * { "webhook_url": "https://your-service.example.com/hooks/low-balance" }
 * ```
 *
 * Response (200):
 * ```json
 * { "message": "Webhook registered", "webhook_url": "https://..." }
 * ```
 */
providerRouter.post(
  "/webhook",
  requireAdminKey,
  validateRequest({
    body: z.object({
      webhook_url: z.string().url("webhook_url must be a valid URL"),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { webhook_url } = req.body;
    registerWebhook(process.env.ADMIN_ADDRESS ?? "system", webhook_url);
    logger.info("Provider webhook registered", { webhook_url });
    return res.json({ message: "Webhook registered", webhook_url });
  }),
);

/**
 * GET /api/provider/analytics (#1002)
 *
 * Provider revenue analytics: total revenue, MRR, ARPU, churn/retention,
 * revenue trends (daily/monthly/yearly), customer acquisition, and a
 * geographic revenue breakdown. Computed from the historical payment events
 * recorded in lib/revenueStore.ts (hooked into POST /api/payments' success
 * path) — distinct from the single running total exposed by GET
 * /api/provider (which reads `get_provider_revenue` directly from the
 * contract and has no historical breakdown).
 *
 * Query params:
 *   from         ISO date — start of window (default: 12 months before `to`)
 *   to           ISO date — end of window (default: now)
 *   granularity  "daily" | "monthly" | "yearly" (default: "monthly")
 *
 * Requires the X-Admin-Key header.
 */
providerRouter.get(
  "/analytics",
  requireAdminKey,
  asyncHandler(async (req, res) => {
    const summary = buildSummaryFromQuery(req.query as Record<string, unknown>);
    return res.json(summary);
  }),
);

/**
 * GET /api/provider/analytics/export?format=pdf|xlsx (#1002)
 *
 * Exports the same analytics summary as GET /api/provider/analytics as a
 * downloadable PDF or Excel report. Accepts the same from/to/granularity
 * query params. Requires the X-Admin-Key header.
 */
providerRouter.get(
  "/analytics/export",
  requireAdminKey,
  asyncHandler(async (req, res) => {
    const format = req.query.format === "xlsx" ? "xlsx" : req.query.format === "pdf" ? "pdf" : null;
    if (!format) {
      return res.status(400).json({ error: "format must be 'pdf' or 'xlsx'" });
    }

    const summary = buildSummaryFromQuery(req.query as Record<string, unknown>);

    if (format === "pdf") {
      const lines: Array<string | { text: string; bold?: boolean; mono?: boolean }> = [
        { text: "SolarGrid Provider Revenue Analytics", bold: true, size: 18 },
        `Period: ${summary.range.from.slice(0, 10)} to ${summary.range.to.slice(0, 10)} (${summary.range.granularity})`,
        "",
        { text: "Summary", bold: true },
        `Total revenue: ${summary.totalRevenueXlm.toFixed(4)} XLM`,
        `MRR: ${summary.mrrXlm.toFixed(4)} XLM`,
        `ARPU: ${summary.arpuXlm.toFixed(4)} XLM`,
        `Total payments: ${summary.totalPayments}`,
        `Active customers: ${summary.activeCustomers}`,
        `Churn rate: ${(summary.churn.churnRate * 100).toFixed(2)}%`,
        `Retention rate: ${(summary.churn.retentionRate * 100).toFixed(2)}%`,
        "",
        { text: "Revenue trend", bold: true },
        ...summary.trend.map(
          (p) =>
            ({
              text: `${p.bucket}  revenue=${stroopsToXlm(p.revenue).toFixed(4)} XLM  payments=${p.paymentCount}  customers=${p.uniqueCustomers}`,
              mono: true,
            }) as const,
        ),
        "",
        { text: "Geographic breakdown", bold: true },
        ...summary.geoBreakdown.map(
          (g) =>
            ({
              text: `${g.region}  revenue=${stroopsToXlm(g.revenue).toFixed(4)} XLM (${g.percentageOfTotal.toFixed(1)}%)  customers=${g.customers}`,
              mono: true,
            }) as const,
        ),
      ];
      const pdf = createPagedTextPdf(lines);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", 'attachment; filename="provider-revenue-analytics.pdf"');
      return res.send(pdf);
    }

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "SolarGrid";
    workbook.created = new Date();

    const summarySheet = workbook.addWorksheet("Summary");
    summarySheet.addRow(["Metric", "Value"]);
    summarySheet.addRow(["Period from", summary.range.from]);
    summarySheet.addRow(["Period to", summary.range.to]);
    summarySheet.addRow(["Granularity", summary.range.granularity]);
    summarySheet.addRow(["Total revenue (XLM)", summary.totalRevenueXlm]);
    summarySheet.addRow(["MRR (XLM)", summary.mrrXlm]);
    summarySheet.addRow(["ARPU (XLM)", summary.arpuXlm]);
    summarySheet.addRow(["Total payments", summary.totalPayments]);
    summarySheet.addRow(["Active customers", summary.activeCustomers]);
    summarySheet.addRow(["Churn rate (%)", summary.churn.churnRate * 100]);
    summarySheet.addRow(["Retention rate (%)", summary.churn.retentionRate * 100]);
    summarySheet.getRow(1).font = { bold: true };

    const trendSheet = workbook.addWorksheet("Revenue Trend");
    trendSheet.addRow(["Bucket", "Revenue (XLM)", "Payment Count", "Unique Customers"]);
    for (const p of summary.trend) {
      trendSheet.addRow([p.bucket, stroopsToXlm(p.revenue), p.paymentCount, p.uniqueCustomers]);
    }
    trendSheet.getRow(1).font = { bold: true };

    const acquisitionSheet = workbook.addWorksheet("Customer Acquisition");
    acquisitionSheet.addRow(["Bucket", "New Customers"]);
    for (const p of summary.acquisition) {
      acquisitionSheet.addRow([p.bucket, p.newCustomers]);
    }
    acquisitionSheet.getRow(1).font = { bold: true };

    const geoSheet = workbook.addWorksheet("Geographic Breakdown");
    geoSheet.addRow(["Region", "Revenue (XLM)", "Payment Count", "Customers", "% of Total"]);
    for (const g of summary.geoBreakdown) {
      geoSheet.addRow([g.region, stroopsToXlm(g.revenue), g.paymentCount, g.customers, g.percentageOfTotal]);
    }
    geoSheet.getRow(1).font = { bold: true };

    const buffer = await workbook.xlsx.writeBuffer();
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="provider-revenue-analytics.xlsx"');
    return res.send(Buffer.from(buffer));
  }),
);
