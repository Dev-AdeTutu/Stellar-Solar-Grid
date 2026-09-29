import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import * as StellarSdk from "@stellar/stellar-sdk";
import { stellarService } from "../lib/stellar.js";
import { fetchPaymentEventsWithDateRange } from "./payments.js";
import { getUsageHistory } from "../lib/usageEvents.js";

export const exportRouter = Router();

const exportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 1,
  keyGenerator: (req: Request) => req.params.address,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res: Response) => res.status(429).json({ error: "Export is limited to one request per hour", code: "RATE_LIMITED" }),
});

function verifyWalletSignature(address: string, req: Request): boolean {
  const signature = req.header("x-wallet-signature");
  const message = req.header("x-wallet-message");
  if (!signature || !message || message !== `Stellar SolarGrid GDPR export:${address}`) return false;
  try {
    const decoded = /^[0-9a-f]+$/i.test(signature)
      ? Buffer.from(signature, "hex")
      : Buffer.from(signature, "base64");
    return StellarSdk.Keypair.fromPublicKey(address).verify(Buffer.from(message, "utf8"), decoded);
  } catch {
    return false;
  }
}

exportRouter.get("/user/:address", exportLimiter, async (req, res) => {
  const { address } = req.params;
  try {
    StellarSdk.StrKey.decodeEd25519PublicKey(address);
  } catch {
    return res.status(400).json({ error: "Invalid Stellar address", code: "VALIDATION_ERROR" });
  }
  if (!verifyWalletSignature(address, req)) {
    return res.status(401).json({ error: "A valid wallet signature is required", code: "WALLET_SIGNATURE_REQUIRED" });
  }

  try {
    const meterResult = await stellarService.query("get_meters_by_owner", [
      StellarSdk.nativeToScVal(address, { type: "address" }),
    ]);
    const meterIds = ((StellarSdk.scValToNative(meterResult) as string[]) ?? []).map(String);
    const normalizedMeters = await Promise.all(meterIds.map(async (meterId) => {
      const meterResult = await stellarService.query("get_meter", [StellarSdk.nativeToScVal(meterId, { type: "symbol" })]);
      const balanceResult = await stellarService.query("get_meter_balance", [StellarSdk.nativeToScVal(meterId, { type: "symbol" })]);
      return { meterId, meter: StellarSdk.scValToNative(meterResult), balance: StellarSdk.scValToNative(balanceResult), owner: address };
    }));
    const usage = meterIds.flatMap((meterId) => getUsageHistory(meterId, 1, 10_000).events);
    const payments = await fetchPaymentEventsWithDateRange(address);
    return res.json({
      schema: "stellar-solargrid.user-export.v1",
      exportedAt: new Date().toISOString(),
      subject: address,
      meters: normalizedMeters,
      payments,
      usage,
      metadata: { meterCount: normalizedMeters.length, paymentCount: payments.length, usageEventCount: usage.length },
    });
  } catch (error: any) {
    return res.status(502).json({ error: error?.message ?? "Unable to export user data", code: "EXPORT_UNAVAILABLE" });
  }
});
