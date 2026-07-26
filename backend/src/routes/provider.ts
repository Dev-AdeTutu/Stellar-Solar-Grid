import { Router } from "express";
import * as StellarSdk from "@stellar/stellar-sdk";
import { stellarService } from "../lib/stellar.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireAdminKey } from "../middleware/adminAuth.js";

export const providerRouter = Router();

/**
 * POST /api/provider/withdraw-revenue
 *
 * Allows the energy provider (admin) to withdraw accumulated revenue from
 * the smart contract vault. Calls `withdraw_revenue` on the Soroban contract.
 *
 * Body: { provider: string, amount: number }
 *
 * Closes #90.
 */
providerRouter.post(
  "/withdraw-revenue",
  requireAdminKey,
  asyncHandler(async (req, res) => {
    const { provider, amount } = req.body as { provider: unknown; amount: unknown };

    if (!provider || typeof provider !== "string") {
      return res.status(400).json({ error: "provider address is required", code: "VALIDATION_ERROR" });
    }
    try {
      StellarSdk.StrKey.decodeEd25519PublicKey(provider);
    } catch {
      return res.status(400).json({ error: "Invalid Stellar provider address", code: "VALIDATION_ERROR" });
    }

    const amountNum = Number(amount);
    if (!Number.isInteger(amountNum) || amountNum <= 0) {
      return res.status(400).json({ error: "amount must be a positive integer (stroops)", code: "VALIDATION_ERROR" });
    }

    const hash = await stellarService.invoke("withdraw_revenue", [
      StellarSdk.nativeToScVal(provider, { type: "address" }),
      StellarSdk.nativeToScVal(BigInt(amountNum), { type: "i128" }),
    ]);

    res.json({ hash, provider, amount: amountNum });
  }),
);
