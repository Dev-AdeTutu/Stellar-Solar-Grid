import { Router } from "express";
import * as StellarSdk from "@stellar/stellar-sdk";
import { z } from "zod";
import { stellarService } from "../lib/stellar.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { logger } from "../lib/logger.js";

export const delegatesRouter = Router();

const AddDelegateSchema = z.object({
  meterId: z.string().min(1).max(64),
  delegate: z.string().length(56),
  owner: z.string().length(56),
});

const RemoveDelegateSchema = z.object({
  meterId: z.string().min(1).max(64),
  delegate: z.string().length(56),
  owner: z.string().length(56),
});

const DelegatedPaymentSchema = z.object({
  meterId: z.string().min(1).max(64),
  delegate: z.string().length(56),
  amount: z.number().int().positive(),
  plan: z.enum(["Daily", "Weekly", "UsageBased"]).optional().default("Daily"),
  memo: z.string().max(100).optional(),
});

/**
 * POST /api/delegates/add
 * Add a delegate who can make payments on behalf of the meter owner.
 */
delegatesRouter.post(
  "/add",
  asyncHandler(async (req, res) => {
    const parsed = AddDelegateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: "Invalid request",
        code: "VALIDATION_ERROR",
        details: parsed.error.flatten(),
      });
    }

    const { meterId, delegate, owner } = parsed.data;

    try {
      // Validate addresses
      StellarSdk.StrKey.decodeEd25519PublicKey(delegate);
      StellarSdk.StrKey.decodeEd25519PublicKey(owner);
    } catch {
      return res.status(400).json({
        error: "Invalid Stellar address format",
        code: "VALIDATION_ERROR",
      });
    }

    try {
      const hash = await stellarService.invoke("add_delegate", [
        StellarSdk.nativeToScVal(meterId, { type: "symbol" }),
        StellarSdk.nativeToScVal(delegate, { type: "address" }),
      ]);

      logger.info("Delegate added", { meterId, delegate, owner, hash });

      return res.json({
        success: true,
        hash,
        meterId,
        delegate,
      });
    } catch (err: any) {
      logger.error("Failed to add delegate", { meterId, delegate, err });
      return res.status(500).json({
        error: err.message || "Failed to add delegate",
        code: "CONTRACT_ERROR",
      });
    }
  }),
);

/**
 * POST /api/delegates/remove
 * Remove a delegate's authorization to make payments.
 */
delegatesRouter.post(
  "/remove",
  asyncHandler(async (req, res) => {
    const parsed = RemoveDelegateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: "Invalid request",
        code: "VALIDATION_ERROR",
        details: parsed.error.flatten(),
      });
    }

    const { meterId, delegate, owner } = parsed.data;

    try {
      StellarSdk.StrKey.decodeEd25519PublicKey(delegate);
      StellarSdk.StrKey.decodeEd25519PublicKey(owner);
    } catch {
      return res.status(400).json({
        error: "Invalid Stellar address format",
        code: "VALIDATION_ERROR",
      });
    }

    try {
      const hash = await stellarService.invoke("remove_delegate", [
        StellarSdk.nativeToScVal(meterId, { type: "symbol" }),
        StellarSdk.nativeToScVal(delegate, { type: "address" }),
      ]);

      logger.info("Delegate removed", { meterId, delegate, owner, hash });

      return res.json({
        success: true,
        hash,
        meterId,
        delegate,
      });
    } catch (err: any) {
      logger.error("Failed to remove delegate", { meterId, delegate, err });
      return res.status(500).json({
        error: err.message || "Failed to remove delegate",
        code: "CONTRACT_ERROR",
      });
    }
  }),
);

/**
 * GET /api/delegates/:meterId
 * Get all delegates authorized to make payments for a meter.
 */
delegatesRouter.get(
  "/:meterId",
  asyncHandler(async (req, res) => {
    const meterId = req.params.meterId;

    if (!meterId || meterId.trim().length === 0) {
      return res.status(400).json({
        error: "meterId is required",
        code: "VALIDATION_ERROR",
      });
    }

    try {
      const result = await stellarService.query("get_delegates", [
        StellarSdk.nativeToScVal(meterId, { type: "symbol" }),
      ]);

      const delegates = StellarSdk.scValToNative(result) as string[];

      return res.json({
        meterId,
        delegates: delegates || [],
        count: delegates?.length || 0,
      });
    } catch (err: any) {
      logger.error("Failed to get delegates", { meterId, err });
      return res.status(500).json({
        error: err.message || "Failed to get delegates",
        code: "CONTRACT_ERROR",
      });
    }
  }),
);

/**
 * POST /api/delegates/payment
 * Make a payment on behalf of a meter owner as an authorized delegate.
 */
delegatesRouter.post(
  "/payment",
  asyncHandler(async (req, res) => {
    const parsed = DelegatedPaymentSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: "Invalid request",
        code: "VALIDATION_ERROR",
        details: parsed.error.flatten(),
      });
    }

    const { meterId, delegate, amount, plan, memo } = parsed.data;

    try {
      StellarSdk.StrKey.decodeEd25519PublicKey(delegate);
    } catch {
      return res.status(400).json({
        error: "Invalid Stellar address format",
        code: "VALIDATION_ERROR",
      });
    }

    try {
      // Convert amount to stroops (XLM * 10^7)
      const amountStroops = BigInt(amount);

      // Prepare memo parameter
      const memoScVal =
        memo && memo.trim().length > 0
          ? StellarSdk.nativeToScVal(memo.trim(), { type: "string" })
          : StellarSdk.xdr.ScVal.scvVoid();

      const hash = await stellarService.invoke("make_delegated_payment", [
        StellarSdk.nativeToScVal(meterId, { type: "symbol" }),
        StellarSdk.nativeToScVal(delegate, { type: "address" }),
        StellarSdk.nativeToScVal(amountStroops, { type: "i128" }),
        StellarSdk.nativeToScVal(plan, { type: "symbol" }),
        memoScVal,
      ]);

      logger.info("Delegated payment successful", {
        meterId,
        delegate,
        amount,
        plan,
        hash,
      });

      return res.json({
        success: true,
        hash,
        meterId,
        delegate,
        amount,
        plan,
      });
    } catch (err: any) {
      logger.error("Delegated payment failed", {
        meterId,
        delegate,
        amount,
        err,
      });
      return res.status(500).json({
        error: err.message || "Failed to process delegated payment",
        code: "CONTRACT_ERROR",
      });
    }
  }),
);
