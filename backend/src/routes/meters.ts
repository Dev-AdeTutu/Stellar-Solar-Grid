import { Router } from "express";
import * as StellarSdk from "@stellar/stellar-sdk";
import { contractQuery, adminInvoke } from "../lib/stellar.js";
import {
  getUsageHistory,
  persistAndSubmitUsageEvent,
} from "../lib/usageEvents.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { validateRequest, RegisterMeterSchema } from "../lib/validation.js";

export const meterRouter = Router();

/** GET /api/meters/export?format=csv|json — download all meter data */
meterRouter.get(
  "/export",
  asyncHandler(async (req, res) => {
    const format = req.query.format === "json" ? "json" : "csv";
    const result = await contractQuery("get_all_meters", []);
    const meters = (StellarSdk.scValToNative(result) as any[]) ?? [];

    if (format === "json") {
      res.setHeader("Content-Disposition", "attachment; filename=meters.json");
      return res.json(meters);
    }

    const header = "owner,active,units_used,plan,last_payment,expires_at,daily_limit";
    const rows = meters.map((m: any) =>
      [m.owner, m.active, m.units_used, m.plan, m.last_payment, m.expires_at, m.daily_limit].join(",")
    );
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=meters.csv");
    return res.send([header, ...rows].join("\n"));
  }),
);

/**
 * GET /api/meters/search?q=&page=&pageSize= — case-insensitive substring
 * search across meter ID and owner address, paginated.
 */
meterRouter.get(
  "/search",
  asyncHandler(async (req, res) => {
    const q = String(req.query.q ?? "").toLowerCase().trim();
    const page = Math.max(1, Number(req.query.page ?? 1) || 1);
    const pageSize = Math.min(
      100,
      Math.max(1, Number(req.query.pageSize ?? 25) || 25),
    );

    const result = await contractQuery("get_all_meters", []);
    const meters = (StellarSdk.scValToNative(result) as any[]) ?? [];

    const matches = q
      ? meters.filter((m: any) => {
          const id = String(m.meter_id ?? m.id ?? "").toLowerCase();
          const owner = String(m.owner ?? "").toLowerCase();
          return id.includes(q) || owner.includes(q);
        })
      : meters;

    const total = matches.length;
    const offset = (page - 1) * pageSize;
    const data = matches.slice(offset, offset + pageSize);

    res.json({
      data,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      },
    });
  }),
);

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

/** GET /api/meters/:id/history — paginated local usage history */
meterRouter.get("/:id/history", (req, res) => {
  const page = Math.max(1, Number(req.query.page ?? 1) || 1);
  const pageSize = Math.min(
    100,
    Math.max(1, Number(req.query.pageSize ?? 25) || 25),
  );

  try {
    const history = getUsageHistory(req.params.id, page, pageSize);
    res.json(history);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/meters/owner/:address — list all meters for an owner */
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
  validateRequest({ body: RegisterMeterSchema }),
  asyncHandler(async (req, res) => {
    const { meter_id, owner } = req.body;

    const hash = await adminInvoke("register_meter", [
      StellarSdk.nativeToScVal(meter_id, { type: "symbol" }),
      StellarSdk.nativeToScVal(owner, { type: "address" }),
    ]);
    res.json({ hash });
  }),
);

/** POST /api/meters/:id/usage — IoT oracle reports usage */
meterRouter.post("/:id/usage", async (req, res) => {
  const { units, cost } = req.body as { units: unknown; cost: unknown };

  if (units == null || cost == null) {
    return res.status(400).json({ error: "units and cost are required" });
  }

  const unitsNum = Number(units);
  const costNum = Number(cost);

  if (!Number.isFinite(unitsNum) || !Number.isFinite(costNum)) {
    return res.status(400).json({ error: "units and cost must be valid numbers" });
  }

  if (!Number.isInteger(unitsNum) || !Number.isInteger(costNum)) {
    return res.status(400).json({ error: "units and cost must be integers" });
  }

  if (unitsNum <= 0 || costNum <= 0) {
    return res.status(400).json({ error: "units and cost must be positive" });
  }

  try {
    const event = await persistAndSubmitUsageEvent({
      meterId: req.params.id,
      units: unitsNum,
      cost: costNum,
      sourceTopic: null,
    });

    res.json({
      event,
      hash: event.on_chain_tx_hash,
      queued: !event.on_chain_tx_hash,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
