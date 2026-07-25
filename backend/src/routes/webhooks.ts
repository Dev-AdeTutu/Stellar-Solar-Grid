import { Router } from "express";
import * as crypto from "crypto";
import * as StellarSdk from "@stellar/stellar-sdk";
import { stellarService } from "../lib/stellar.js";
import { registerWebhook, getWebhookUrls } from "../lib/webhookRegistry.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { validateRequest } from "../lib/validation.js";
import { requireAdminKey } from "../middleware/adminAuth.js";
import { logger } from "../lib/logger.js";
import { activeMeters, paymentVolume } from "../lib/metrics.js";
import { z } from "zod";
import { SmsPaymentWebhookSchema } from "../lib/validation.js";

export const webhookRouter = Router();

/**
 * Verify the HMAC-SHA256 signature sent by the telecom partner.
 * Header: X-Webhook-Signature: sha256=<hex>
 */
function verifySignature(rawBody: Buffer, signature: string): boolean {
  const secret = process.env.TELECOM_WEBHOOK_SECRET;
  if (!secret) return false;
  const expected =
    "sha256=" +
    crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

/**
 * POST /api/webhooks/sms-payment
 *
 * Payload from telecom partner:
 *   { "meter_id": "METER1", "amount_xlm": 5.0 }
 *
 * Triggers make_payment on-chain using the admin keypair as payer.
 */
webhookRouter.post(
  "/sms-payment",
  validateRequest({ body: SmsPaymentWebhookSchema }),
  asyncHandler(async (req, res) => {
    const signature = req.headers["x-webhook-signature"] as string | undefined;
    if (
      !signature ||
      !verifySignature(
        (req as any).rawBody ?? Buffer.from(JSON.stringify(req.body)),
        signature,
      )
    ) {
      return res.status(401).json({ error: "Invalid webhook signature" });
    }

    const { meter_id, amount_xlm, plan } = req.body;

    const stroops = BigInt(Math.round(amount_xlm * 10_000_000));
    const hash = await stellarService.invoke("make_payment", [
      StellarSdk.nativeToScVal(meter_id, { type: "symbol" }),
      StellarSdk.nativeToScVal(process.env.ADMIN_PUBLIC_KEY!, {
        type: "address",
      }),
      StellarSdk.nativeToScVal(stroops, { type: "i128" }),
      StellarSdk.nativeToScVal({ [plan]: null }),
    ]);
    paymentVolume.inc(amount_xlm);
    return res.status(200).json({ hash });
  }),
);

/**
 * POST /api/webhooks/low-balance
 *
 * Register webhook URL for low-balance notifications.
 * Providers can configure their webhook endpoint to receive alerts
 * when a customer's meter balance drops below the threshold.
 * Requires X-Admin-Key header.
 *
 * Payload:
 *   { "webhook_url": "https://example.com/webhook" }
 */
webhookRouter.post(
  "/low-balance",
  requireAdminKey,
  validateRequest({
    body: z.object({
      webhook_url: z.string().url("Invalid webhook URL format"),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { webhook_url } = req.body;

    registerWebhook(webhook_url);

    logger.info("Low-balance webhook registered", { webhook_url });

    return res.status(200).json({
      message: "Webhook registered successfully",
      webhook_url,
    });
  }),
);

/**
 * GET /api/webhooks
 *
 * List all registered low-balance webhook URLs.
 */
webhookRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const urls = Array.from(getWebhookUrls());
    return res.status(200).json({
      webhooks: urls,
      count: urls.length,
    });
  }),
);
