import { Router } from "express";
import * as crypto from "crypto";
import * as StellarSdk from "@stellar/stellar-sdk";
import { adminInvoke } from "../lib/stellar.js";
import { activeMeters, paymentVolume } from "../lib/metrics.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { SmsPaymentWebhookSchema, validateRequest } from "../lib/validation.js";

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
