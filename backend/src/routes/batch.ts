import { Router } from "express";
import * as StellarSdk from "@stellar/stellar-sdk";
import { adminInvoke } from "../lib/stellar.js";
import { asyncHandler } from "../lib/asyncHandler.js";

export const batchRouter = Router();

export type BatchAction =
  | { type: "SetActive"; meterId: string; active: boolean }
  | { type: "SetDailyLimit"; meterId: string; limit: string }
  | { type: "AllowlistAdd" | "AllowlistRemove" | "SetOracle"; address: string };

const MAX_BATCH_ACTIONS = 25;
const sym = (s: string) => StellarSdk.xdr.ScVal.scvSymbol(s);

/** Encode an action as a Soroban `AdminAction` enum value: Vec[Symbol(variant), ...fields]. */
export function encodeAction(a: BatchAction): StellarSdk.xdr.ScVal {
  switch (a.type) {
    case "SetActive":
      return StellarSdk.xdr.ScVal.scvVec([
        sym(a.type),
        StellarSdk.nativeToScVal(a.meterId, { type: "string" }),
        StellarSdk.nativeToScVal(a.active, { type: "bool" }),
      ]);
    case "SetDailyLimit":
      return StellarSdk.xdr.ScVal.scvVec([
        sym(a.type),
        StellarSdk.nativeToScVal(a.meterId, { type: "string" }),
        StellarSdk.nativeToScVal(BigInt(a.limit), { type: "i128" }),
      ]);
    default:
      return StellarSdk.xdr.ScVal.scvVec([sym(a.type), new StellarSdk.Address(a.address).toScVal()]);
  }
}

/**
 * POST /api/batch { actions: BatchAction[] }
 * Submits every action in one `execute_batch` transaction, so a multi-sig
 * admin account collects signatures once for the whole bundle.
 */
batchRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const actions = req.body?.actions as BatchAction[] | undefined;
    if (!Array.isArray(actions) || actions.length === 0 || actions.length > MAX_BATCH_ACTIONS) {
      return res.status(400).json({ error: `actions must contain 1-${MAX_BATCH_ACTIONS} items` });
    }
    let encoded;
    try {
      encoded = actions.map(encodeAction);
    } catch (e) {
      return res.status(400).json({ error: `invalid action: ${(e as Error).message}` });
    }
    const hash = await adminInvoke("execute_batch", [StellarSdk.xdr.ScVal.scvVec(encoded)]);
    res.json({ hash, count: actions.length });
  }),
);
