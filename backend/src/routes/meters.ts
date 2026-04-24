import { Router } from "express";
import * as StellarSdk from "@stellar/stellar-sdk";
import { adminInvoke, contractQuery } from "../lib/stellar.js";
import { asyncHandler } from "../lib/asyncHandler.js";

export const meterRouter = Router();

/** GET /api/meters/:id — get meter status */
meterRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const result = await contractQuery("get_meter", [
      StellarSdk.nativeToScVal(req.params.id, { type: "symbol" }),
    ]);
    res.json({ meter: StellarSdk.scValToNative(result) });
  }),
);

/** GET /api/meters/:id/access — check if meter is active */
meterRouter.get(
  "/:id/access",
  asyncHandler(async (req, res) => {
    const result = await contractQuery("check_access", [
      StellarSdk.nativeToScVal(req.params.id, { type: "symbol" }),
    ]);
    res.json({ active: StellarSdk.scValToNative(result) });
  }),
);

/** GET /api/meters/owner/:address — list all meters for an owner (#32) */
meterRouter.get(
  "/owner/:address",
  asyncHandler(async (req, res) => {
    const result = await contractQuery("get_meters_by_owner", [
      StellarSdk.nativeToScVal(req.params.address, { type: "address" }),
    ]);
    res.json({ meters: StellarSdk.scValToNative(result) });
  }),
);

/** POST /api/meters — register a new meter (admin only) */
meterRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    if (!req.body || typeof req.body !== "object") {
      return res
        .status(400)
        .json({ error: "Request body must be a JSON object" });
    }

    const { meter_id, owner } = req.body as {
      meter_id?: unknown;
      owner?: unknown;
    };

    if (
      typeof meter_id !== "string" ||
      meter_id.trim().length === 0 ||
      typeof owner !== "string" ||
      owner.trim().length === 0
    ) {
      return res
        .status(400)
        .json({ error: "meter_id and owner must be non-empty strings" });
    }

    const hash = await adminInvoke("register_meter", [
      StellarSdk.nativeToScVal(meter_id, { type: "symbol" }),
      StellarSdk.nativeToScVal(owner, { type: "address" }),
    ]);
    res.json({ hash });
  }),
);

/** POST /api/meters/:id/usage — IoT oracle reports usage */
meterRouter.post(
  "/:id/usage",
  asyncHandler(async (req, res) => {
    if (!req.body || typeof req.body !== "object") {
      return res
        .status(400)
        .json({ error: "Request body must be a JSON object" });
    }

    const { units, cost } = req.body as { units?: unknown; cost?: unknown };
    if (
      typeof units !== "number" ||
      !Number.isFinite(units) ||
      units < 0 ||
      typeof cost !== "number" ||
      !Number.isFinite(cost)
    ) {
      return res
        .status(400)
        .json({ error: "units and cost must be valid numbers" });
    }

    const hash = await adminInvoke("update_usage", [
      StellarSdk.nativeToScVal(req.params.id, { type: "symbol" }),
      StellarSdk.nativeToScVal(BigInt(Math.trunc(units)), { type: "u64" }),
      StellarSdk.nativeToScVal(BigInt(Math.trunc(cost)), { type: "i128" }),
    ]);
    res.json({ hash });
  }),
);
