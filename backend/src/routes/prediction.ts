/**
 * GET /api/meters/:meterId/prediction (#835)
 *
 * Returns the estimated days until the meter balance reaches zero, based on a
 * linear regression over the last 30 days of usage, with a 95% confidence
 * interval. Balance is read from the contract (`get_meter`) unless supplied
 * via `?balance=` (stroops).
 */
import { Router } from "express";
import * as StellarSdk from "@stellar/stellar-sdk";
import { asyncHandler } from "../lib/asyncHandler.js";
import { stellarService } from "../lib/stellar.js";
import { getPrediction } from "../lib/usagePrediction.js";

export const predictionRouter = Router();

predictionRouter.get(
  "/:meterId/prediction",
  asyncHandler(async (req, res) => {
    const { meterId } = req.params;
    let balance: number;

    if (req.query.balance !== undefined) {
      balance = Number(req.query.balance);
      if (!Number.isFinite(balance) || balance < 0) {
        return res.status(400).json({ error: "balance must be a non-negative number" });
      }
    } else {
      try {
        const result = await stellarService.query("get_meter", [
          StellarSdk.nativeToScVal(meterId, { type: "symbol" }),
        ]);
        const meter = StellarSdk.scValToNative(result) as { balance?: bigint | number } | null;
        if (!meter) return res.status(404).json({ error: "Meter not found", code: "METER_NOT_FOUND" });
        balance = Number(meter.balance ?? 0);
      } catch {
        return res.status(500).json({ error: "Query failed", code: "CONTRACT_ERROR" });
      }
    }

    res.json(getPrediction(meterId, balance));
  }),
);
