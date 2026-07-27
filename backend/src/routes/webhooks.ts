import { Router } from "express";
import * as crypto from "crypto";
import * as StellarSdk from "@stellar/stellar-sdk";
import { adminInvoke, contractQuery } from "../lib/stellar.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { validateRequest } from "../lib/validation.js";
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

    const { meter_id, amount_xlm } = req.body;

    const stroops = BigInt(Math.round(amount_xlm * 10_000_000));
    const hash = await adminInvoke("make_payment", [
      StellarSdk.nativeToScVal(meter_id, { type: "symbol" }),
      StellarSdk.nativeToScVal(process.env.ADMIN_PUBLIC_KEY!, {
        type: "address",
      }),
      StellarSdk.nativeToScVal(stroops, { type: "i128" }),
      StellarSdk.xdr.ScVal.scvVec([StellarSdk.xdr.ScVal.scvSymbol("Daily")]),
    ]);
    paymentVolume.inc(amount_xlm);
    activeMeters.inc();
    return res.status(200).json({ hash });
  }),
);

/**
 * POST /api/webhooks/low-balance
 *
 * Register webhook URL for low-balance notifications.
 * Providers can configure their webhook endpoint to receive alerts
 * when a customer's meter balance drops below the threshold.
 *
 * Payload:
 *   { "webhook_url": "https://example.com/webhook", "secret": "optional-signing-secret" }
 *
 * When a secret is provided, outbound low-balance webhook calls are signed
 * with X-SolarGrid-Signature: sha256=HMAC-SHA256(secret, body). Only a hash
 * of the secret is kept in the registry response/logs; the raw secret is
 * held only in-process to sign outbound requests.
 */
webhookRouter.post(
  "/low-balance",
  validateRequest({
    body: z.object({
      webhook_url: z.string().url("Invalid webhook URL format"),
      secret: z.string().min(1).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { webhook_url, secret } = req.body as {
      webhook_url: string;
      secret?: string;
    };

    // For now, store in environment variables (in production, use a database).
    process.env.PROVIDER_WEBHOOK_URL = webhook_url;

    let secretHash: string | undefined;
    if (secret) {
      process.env.PROVIDER_WEBHOOK_SECRET = secret;
      secretHash = crypto.createHash("sha256").update(secret).digest("hex");
    }

    logger.info("Low-balance webhook registered", {
      webhook_url,
      secretHash,
    });

    return res.status(200).json({
      message: "Webhook registered successfully",
      webhook_url,
      secretHash,
    });
  }),
);
