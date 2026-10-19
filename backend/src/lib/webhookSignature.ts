import crypto from "node:crypto";

/**
 * Shared HMAC-SHA256 webhook signing helpers.
 *
 * Outbound webhook requests (low-balance notifications, etc.) are signed
 * with the registered provider secret (or the global `WEBHOOK_SECRET` env
 * var as a fallback) so recipients can verify the request actually
 * originated from the SolarGrid backend. See backend/API.md for the
 * verification recipe.
 *
 * Closes #688.
 */

export const SIGNATURE_HEADER = "X-Signature-256";

/** Compute the `sha256=<hex>` signature for a given payload + secret. */
export function signWebhookPayload(secret: string, payload: string): string {
  const digest = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return `sha256=${digest}`;
}

/**
 * Constant-time comparison of an inbound `X-Signature-256` header against
 * the signature computed from the payload + secret.
 */
export function verifyWebhookSignature(
  secret: string,
  payload: string,
  signatureHeader: string,
): boolean {
  const expected = signWebhookPayload(secret, payload);
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signatureHeader);
  if (expectedBuf.length !== actualBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}

/** Generate a new random webhook signing secret (32 bytes, hex-encoded). */
export function generateWebhookSecret(): string {
  return crypto.randomBytes(32).toString("hex");
}
