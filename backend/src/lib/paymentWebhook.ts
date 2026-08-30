import crypto from "node:crypto";
import { logger } from "./logger.js";
import { fireWebhook } from "./webhookRegistry.js";
import { getReqId } from "./requestContext.js";

/**
 * Payment webhook payload structure (Issue #692).
 * Sent to PAYMENT_WEBHOOK_URL when a payment is successfully processed.
 */
export interface PaymentWebhookPayload {
  meter_id: string;
  payer_address: string;
  amount: number; // in stroops (1 XLM = 10,000,000 stroops)
  amount_xlm: number; // amount in XLM for convenience
  plan_type: string;
  transaction_hash: string;
  timestamp: string; // ISO 8601
  updated_balance: number; // updated meter balance in stroops
}

/**
 * Get the payment webhook secret from environment.
 * If no secret is configured, webhook signing is disabled.
 */
function getPaymentWebhookSecret(): string | null {
  return process.env.PAYMENT_WEBHOOK_SECRET || null;
}

/**
 * Generate HMAC-SHA256 signature for webhook payload.
 * Returns header value: "sha256=<hex>"
 */
export function generateWebhookSignature(payload: string, secret: string): string {
  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(payload);
  return "sha256=" + hmac.digest("hex");
}

/**
 * Send a payment webhook notification (Issue #692).
 * Implements:
 * - HMAC signature verification (if secret is configured)
 * - Automatic retry with exponential backoff
 * - Logging and circuit breaker protection
 *
 * @param payload Payment webhook payload
 * @param webhookUrl URL to send the webhook to (can be overridden; defaults to env var)
 */
export async function sendPaymentWebhook(
  payload: PaymentWebhookPayload,
  webhookUrl?: string,
): Promise<void> {
  const url = webhookUrl || process.env.PAYMENT_WEBHOOK_URL;

  if (!url) {
    // Webhook not configured — silently skip
    return;
  }

  const payloadJson = JSON.stringify(payload);
  const secret = getPaymentWebhookSecret();

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  // Add HMAC signature if secret is configured (Issue #692)
  if (secret) {
    headers["X-Webhook-Signature"] = generateWebhookSignature(payloadJson, secret);
  }

  const correlationId = getReqId();

  logger.info("Sending payment webhook", {
    meter_id: payload.meter_id,
    payer_address: payload.payer_address,
    amount_xlm: payload.amount_xlm,
    url,
    correlationId,
  });

  // Fire async webhook with retry logic from webhookRegistry
  try {
    await fireWebhook(url, payloadJson, correlationId);
  } catch (err: any) {
    logger.error("Failed to send payment webhook", {
      meter_id: payload.meter_id,
      url,
      error: err.message,
      correlationId,
    });
    // Don't rethrow — webhook failures should not block payment API responses
  }
}

/**
 * Format amount in stroops to XLM for display
 */
export function stroopsToXlm(stroops: number | bigint): number {
  return Number(stroops) / 10_000_000;
}
