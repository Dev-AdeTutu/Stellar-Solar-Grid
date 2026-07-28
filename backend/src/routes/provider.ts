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
import { stellarService } from "../lib/stellar.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireAdminKey } from "../middleware/adminAuth.js";
import { registerWebhook } from "../lib/webhookRegistry.js";
import { logger } from "../lib/logger.js";
import { z } from "zod";
import { validateRequest } from "../lib/validation.js";

export const providerRouter = Router();

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
    registerWebhook(webhook_url);
    logger.info("Provider webhook registered", { webhook_url });
    return res.json({ message: "Webhook registered", webhook_url });
  }),
);
