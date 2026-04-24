import { Router } from "express";
import * as StellarSdk from "@stellar/stellar-sdk";
import { adminInvoke, contractQuery } from "../lib/stellar.js";
import { activeMeters, paymentVolume } from "../lib/metrics.js";
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
    // Decrement active meters gauge when cost drains balance (best-effort)
    activeMeters.dec();
    res.json({ hash });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

const TTL_MS = 24 * 60 * 60 * 1_000; // 24 hours
const idempotencyCache = new Map<string, { hash: string; timestamp: number }>();

/**
 * POST /api/meters/:id/pay
 *
 * Body: { token_address, payer, amount_stroops, plan }
 * Header: Idempotency-Key: <uuid>  (optional — duplicate within 24 h returns cached txHash)
 */
meterRouter.post("/:id/pay", async (req, res) => {
  const ikey = req.headers["idempotency-key"] as string | undefined;

  if (ikey) {
    const cached = idempotencyCache.get(ikey);
    if (cached && Date.now() - cached.timestamp < TTL_MS) {
      return res.json({ hash: cached.hash });
    }
  }

  const { token_address, payer, amount_stroops, plan } = req.body as {
    token_address: string;
    payer: string;
    amount_stroops: number;
    plan: string;
  };

  if (!token_address || !payer || amount_stroops == null || !plan) {
    return res.status(400).json({ error: "token_address, payer, amount_stroops, and plan are required" });
  }

  try {
    const hash = await adminInvoke("make_payment", [
      StellarSdk.nativeToScVal(req.params.id, { type: "symbol" }),
      StellarSdk.nativeToScVal(token_address, { type: "address" }),
      StellarSdk.nativeToScVal(payer, { type: "address" }),
      StellarSdk.nativeToScVal(BigInt(amount_stroops), { type: "i128" }),
      StellarSdk.xdr.ScVal.scvVec([StellarSdk.xdr.ScVal.scvSymbol(plan)]),
    ]);

    if (ikey) {
      // Evict expired entries lazily before inserting
      for (const [k, v] of idempotencyCache) {
        if (Date.now() - v.timestamp >= TTL_MS) idempotencyCache.delete(k);
      }
      idempotencyCache.set(ikey, { hash, timestamp: Date.now() });
    }

    paymentVolume.inc(amount_stroops / 10_000_000);
    activeMeters.inc();
    res.json({ hash });
  }),
);
