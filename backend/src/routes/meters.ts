import { Router } from "express";
import * as StellarSdk from "@stellar/stellar-sdk";
import { StellarService, stellarService } from "../lib/stellar.js";
import {
  getUsageHistory,
  persistAndSubmitUsageEvent,
} from "../lib/usageEvents.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { validateRequest, RegisterMeterSchema } from "../lib/validation.js";
import { adminAuth } from "../lib/adminAuth.js";
import { requireAdminKey } from "../middleware/adminAuth.js";
import { cacheFor, invalidateCache, etagFor } from "../middleware/cache.js";

const balanceCache = new Map<string, { data: any; ts: number }>();
const BALANCE_CACHE_TTL_MS = 5_000; // 5-second cache to reduce RPC load

export function createMeterRouter(stellar: StellarService) {
  const meterRouter = Router();

  /**
   * GET /api/meters?page=1&pageSize=25 — list all meters with pagination
   *
   * Registered BEFORE /:id so the literal string "meters" is never matched
   * as a meter ID parameter.
   *
   * Fixes #268.
   */
  meterRouter.get(
    "/",
    asyncHandler(async (req, res) => {
      const page = Math.max(1, Number(req.query.page ?? 1) || 1);
      const pageSize = Math.min(
        100,
        Math.max(1, Number(req.query.pageSize ?? 25) || 25),
      );

      const result = await stellar.query("get_all_meters", []);
      const allMeters = (StellarSdk.scValToNative(result) as any[]) ?? [];

      const total = allMeters.length;
      const start = (page - 1) * pageSize;
      const meters = allMeters.slice(start, start + pageSize);

      res.json({
        meters,
        pagination: {
          page,
          pageSize,
          total,
          pages: Math.ceil(total / pageSize),
        },
      });
    }),
  );

  /** GET /api/meters/export?format=csv|json — download all meter data */
  meterRouter.get(
    "/export",
    requireAdminKey,
    asyncHandler(async (req, res) => {
      const format = req.query.format === "json" ? "json" : "csv";
      const result = await stellar.query("get_all_meters", []);
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

  /** GET /api/meters/expiring — return meters expiring within the next 24 hours */
  meterRouter.get(
    "/expiring",
    requireAdminKey,
    asyncHandler(async (req, res) => {
      const windowHours = Number(req.query.hours ?? 24);
      if (isNaN(windowHours) || windowHours <= 0) {
        return res.status(400).json({ error: "Invalid hours parameter" });
      }

      const result = await stellar.query("get_all_meters", []);
      const allMeters = (StellarSdk.scValToNative(result) as any[]) ?? [];

      const nowMs = Date.now();
      const thresholdMs = nowMs + windowHours * 60 * 60 * 1000;

      const expiring = allMeters.filter((m: any) => {
        if (!m.expires_at) return false;
        // Assume expires_at is in seconds since epoch based on Stellar types
        const expiresMs = Number(m.expires_at) * 1000;
        return expiresMs > nowMs && expiresMs <= thresholdMs;
      });

      res.json({ expiring, count: expiring.length });
    })
  );

  /** GET /api/meters/:id/status — lightweight status poll */
  meterRouter.get(
    "/:id/status",
    asyncHandler(async (req, res) => {
      const { id } = req.params;
      try {
        const result = await stellar.query("get_meter", [
          StellarSdk.nativeToScVal(id, { type: "symbol" }),
        ]);
        const meter = StellarSdk.scValToNative(result) as any;
        if (!meter) return res.status(404).json({ error: "Meter not found", code: "METER_NOT_FOUND" });
        return res.json({
          meterId: id,
          active: meter.active,
          dailyLimit: meter.daily_limit,
          daySpent: meter.day_spent,
          expiresAt: meter.expires_at,
          plan: meter.plan,
        });
      } catch {
        return res.status(500).json({ error: "Query failed", code: "CONTRACT_ERROR" });
      }
    }),
  );
  /** GET /api/meters/owner/:address — list all meters for an owner (must be before /:id) */
  meterRouter.get(
    "/owner/:address",
    asyncHandler(async (req, res) => {
      try {
        StellarSdk.StrKey.decodeEd25519PublicKey(req.params.address);
      } catch {
        return res.status(400).json({ error: "Invalid Stellar address" });
      }
      const result = await stellar.query("get_meters_by_owner", [
        StellarSdk.nativeToScVal(req.params.address, { type: "address" }),
      ]);
      res.json({ meters: StellarSdk.scValToNative(result), owner: req.params.address });
    }),
  );

  /** GET /api/meters/:id/plan — current plan type and expiry timestamp */
  meterRouter.get(
    "/:id/plan",
    cacheFor(5_000),
    asyncHandler(async (req, res) => {
      const meterId = req.params.id;
      let meter: any;
      try {
        const result = await stellar.query("get_meter", [
          StellarSdk.nativeToScVal(meterId, { type: "symbol" }),
        ]);
        meter = StellarSdk.scValToNative(result);
      } catch {
        return res.status(404).json({ error: "Meter not found", code: "NOT_FOUND" });
      }
      if (!meter) return res.status(404).json({ error: "Meter not found", code: "NOT_FOUND" });
      return res.json({
        meter_id: meterId,
        plan: meter.plan,
        expires_at: meter.expires_at,
        active: meter.active,
      });
    }),
  );

  /** GET /api/meters/:id/status — lightweight status poll */
  meterRouter.get(
    "/:id/status",
    asyncHandler(async (req, res) => {
      const { id } = req.params;
      try {
        const result = await stellar.query("get_meter", [
          StellarSdk.nativeToScVal(id, { type: "symbol" }),
        ]);
        const meter = StellarSdk.scValToNative(result) as any;
        if (!meter) return res.status(404).json({ error: "Meter not found", code: "METER_NOT_FOUND" });
        return res.json({
          meterId: id,
          active: meter.active,
          dailyLimit: meter.daily_limit,
          daySpent: meter.day_spent,
          expiresAt: meter.expires_at,
          plan: meter.plan,
        });
      } catch {
        return res.status(500).json({ error: "Query failed", code: "CONTRACT_ERROR" });
      }
    }),
  );

  /** GET /api/meters/owner/:address — list all meters for an owner (must be before /:id) */
  meterRouter.get(
    "/owner/:address",
    asyncHandler(async (req, res) => {
      try {
        StellarSdk.StrKey.decodeEd25519PublicKey(req.params.address);
      } catch {
        return res.status(400).json({ error: "Invalid Stellar address" });
      }
      const result = await stellar.query("get_meters_by_owner", [
        StellarSdk.nativeToScVal(req.params.address, { type: "address" }),
      ]);
      res.json({ meters: StellarSdk.scValToNative(result), owner: req.params.address });
    }),
  );

  /**
   * GET /api/meters/:id — get meter status with ETag support.
   * Sets ETag header based on a hash of the meter JSON so clients can make
   * conditional requests with If-None-Match to avoid redundant downloads.
   *
   * Closes #462.
   */
  meterRouter.get(
    "/:id",
    cacheFor(5_000),
    asyncHandler(async (req, res) => {
      const result = await stellar.query("get_meter", [
        StellarSdk.nativeToScVal(req.params.id, { type: "symbol" }),
      ]);
      const data = { meter: StellarSdk.scValToNative(result) };
      const etag = etagFor(data);

      res.setHeader("ETag", etag);

      if (req.headers["if-none-match"] === etag) {
        return res.status(304).end();
      }

      res.json(data);
    }),
  );

  /** GET /api/meters/:id/access — check if meter is active */
  meterRouter.get(
    "/:id/access",
    cacheFor(5_000),
    asyncHandler(async (req, res) => {
      const result = await stellar.query("check_access", [
        StellarSdk.nativeToScVal(req.params.id, { type: "symbol" }),
      ]);
      res.json({ active: StellarSdk.scValToNative(result) });
    }),
  );

  /** POST /api/meters/:id/deactivate — admin manually deactivates a meter */
  meterRouter.post(
    "/:id/deactivate",
    requireAdminKey,
    asyncHandler(async (req, res) => {
      const meterId = req.params.id;
      try {
        await stellar.query("get_meter", [
          StellarSdk.nativeToScVal(meterId, { type: "symbol" }),
        ]);
      } catch {
        return res.status(404).json({ error: "Meter not found", code: "NOT_FOUND" });
      }
      const hash = await stellar.invoke("set_active", [
        StellarSdk.nativeToScVal(meterId, { type: "symbol" }),
        StellarSdk.nativeToScVal(false, { type: "bool" }),
      ]);
      res.json({ hash, meter_id: meterId, active: false });
    }),
  );

  /** POST /api/meters/:id/activate — admin manually activates a meter */
  meterRouter.post(
    "/:id/activate",
    requireAdminKey,
    asyncHandler(async (req, res) => {
      const meterId = req.params.id;
      try {
        await stellar.query("get_meter", [
          StellarSdk.nativeToScVal(meterId, { type: "symbol" }),
        ]);
      } catch {
        return res.status(404).json({ error: "Meter not found", code: "NOT_FOUND" });
      }
      const hash = await stellar.invoke("set_active", [
        StellarSdk.nativeToScVal(meterId, { type: "symbol" }),
        StellarSdk.nativeToScVal(true, { type: "bool" }),
      ]);
      res.json({ hash, meter_id: meterId, active: true });
    }),
  );

  /** GET /api/meters/:id/balance — live balance for a single meter */
  meterRouter.get(
    "/:id/balance",
    asyncHandler(async (req, res) => {
      const meterId = req.params.id;

      // Check cache first
      const cached = balanceCache.get(meterId);
      if (cached && Date.now() - cached.ts < BALANCE_CACHE_TTL_MS) {
        return res.json(cached.data);
      }

      try {
        const result = await stellar.query("get_meter", [
          StellarSdk.nativeToScVal(meterId, { type: "symbol" }),
        ]);
        const meter = StellarSdk.scValToNative(result) as any;
        const payload = {
          meter_id: meterId,
          balance: meter.balance,
          units_used: meter.units_used,
          active: meter.active,
        };
        balanceCache.set(meterId, { data: payload, ts: Date.now() });
        res.json(payload);
      } catch (err: any) {
        res.status(404).json({ error: "Meter not found", code: "NOT_FOUND" });
      }
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
      res.status(500).json({ error: err.message, code: "INTERNAL_ERROR" });
    }
  });

  /** GET /api/meters/:id/events — paginated on-chain events for a single meter */
  meterRouter.get(
    "/:id/events",
    asyncHandler(async (req, res) => {
      const meterId = req.params.id;
      const page = Math.max(1, parseInt((req.query.page as string) ?? "1", 10));
      const limit = Math.min(
        50,
        Math.max(1, parseInt((req.query.limit as string) ?? "20", 10)),
      );
      const days = Math.min(
        90,
        Math.max(1, parseInt((req.query.days as string) ?? "30", 10)),
      );

      // Check if meter exists
      try {
        await stellar.query("get_meter", [
          StellarSdk.nativeToScVal(meterId, { type: "symbol" }),
        ]);
      } catch {
        return res.status(404).json({ error: "Meter not found", code: "NOT_FOUND" });
      }

      try {
        // Query Soroban RPC for contract events filtered by meter ID
        const EVT_NS = StellarSdk.xdr.ScVal.scvSymbol("solargrid").toXDR("base64");
        const meterTopic = StellarSdk.nativeToScVal(meterId, { type: "symbol" }).toXDR("base64");

        const response = await (stellar.server as any).getEvents({
          startLedger: 1,
          filters: [
            {
              type: "contract",
              contractIds: [stellar.contractId],
              topics: [
                [EVT_NS],
                [],
                [meterTopic], // Filter by meter ID in topic[2]
              ],
            },
          ],
          limit: 1000,
        });

        const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
        const events: any[] = [];

        for (const event of response?.events ?? []) {
          try {
            const parsed = parseContractEvent(event);
            if (parsed && new Date(parsed.timestamp).getTime() >= cutoff) {
              events.push(parsed);
            }
          } catch {
            // skip malformed events
          }
        }

        // Sort by timestamp descending (newest first)
        events.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

        const total = events.length;
        const start = (page - 1) * limit;
        const paginated = events.slice(start, start + limit);

        return res.json({
          events: paginated,
          pagination: { page, limit, total, pages: Math.ceil(total / limit) },
        });
      } catch (err: any) {
        if (err?.code === "RPC_ERROR" || err?.isRpcError) {
          return res.status(502).json({
            error: err.message ?? "RPC request failed",
            code: "RPC_ERROR",
          });
        }
        return res.status(500).json({
          error: err.message ?? "Failed to fetch events",
          code: "INTERNAL_ERROR",
        });
      }
    }),
  );

  /** POST /api/meters/:id/set-daily-limit — admin sets daily spending limit for a meter */
  meterRouter.post(
    "/:id/set-daily-limit",
    requireAdminKey,
    asyncHandler(async (req, res) => {
      const limit = Number(req.body.limit);
      if (!Number.isInteger(limit) || limit < 0) {
        return res.status(400).json({ error: "limit must be a non-negative integer (stroops)" });
      }
      const hash = await stellar.invoke("set_daily_limit", [
        StellarSdk.nativeToScVal(req.params.id, { type: "symbol" }),
        StellarSdk.nativeToScVal(BigInt(limit), { type: "i128" }),
      ]);
      res.json({ hash, meter_id: req.params.id, daily_limit: limit });
    }),
  );

  /** POST /api/meters — register a new meter (admin only) */
  meterRouter.post(
    "/",
    requireAdminKey,
    validateRequest({ body: RegisterMeterSchema }),
    asyncHandler(async (req, res) => {
      const { meter_id, owner } = req.body;

      const hash = await stellar.invoke("register_meter", [
        StellarSdk.nativeToScVal(meter_id, { type: "symbol" }),
        StellarSdk.nativeToScVal(owner, { type: "address" }),
      ]);
      res.json({ hash });
    }),
  );

  /** POST /api/meters/batch — batch register meters (admin only) */
  meterRouter.post(
    "/batch",
    requireAdminKey,
    asyncHandler(async (req, res) => {
      const { meters } = req.body;
      if (!meters || !Array.isArray(meters)) {
        return res.status(400).json({ error: "meters array is required", code: "VALIDATION_ERROR" });
      }
      if (meters.length > 50) {
        return res.status(400).json({ error: "At most 50 meters can be registered in a batch", code: "VALIDATION_ERROR" });
      }

      const STELLAR_ACCOUNT_REGEX = /^G[A-Z2-7]{55}$/;
      const results: Array<{ meter_id: string; hash?: string; error?: string }> = [];

      for (const item of meters) {
        const meterId = item?.meter_id;
        const owner = item?.owner;

        if (!meterId || typeof meterId !== "string" || meterId.trim().length === 0) {
          results.push({ meter_id: String(meterId ?? ""), error: "meter_id is required" });
          continue;
        }

        const trimmedId = meterId.trim();
        if (trimmedId.length > 12) {
          results.push({ meter_id: trimmedId, error: "meter_id must be at most 12 characters" });
          continue;
        }

        if (!owner || typeof owner !== "string" || !STELLAR_ACCOUNT_REGEX.test(owner)) {
          results.push({ meter_id: trimmedId, error: "Invalid Stellar account address format" });
          continue;
        }

        try {
          const hash = await stellar.invoke("register_meter", [
            StellarSdk.nativeToScVal(trimmedId, { type: "symbol" }),
            StellarSdk.nativeToScVal(owner, { type: "address" }),
          ]);
          results.push({ meter_id: trimmedId, hash });
        } catch (err: any) {
          results.push({ meter_id: trimmedId, error: err.message ?? "Registration failed" });
        }
      }

      res.json({ results });
    }),
  );


  /** POST /api/meters/:id/usage — IoT oracle reports usage */
  meterRouter.post("/:id/usage", requireAdminKey, async (req, res) => {
    const { units, cost } = req.body as { units: unknown; cost: unknown };

    if (units == null || cost == null) {
      return res.status(400).json({ error: "units and cost are required", code: "VALIDATION_ERROR" });
    }

    const unitsNum = Number(units);
    const costNum = Number(cost);

    if (!Number.isFinite(unitsNum) || !Number.isFinite(costNum)) {
      return res.status(400).json({ error: "units and cost must be valid numbers", code: "VALIDATION_ERROR" });
    }

    if (!Number.isInteger(unitsNum) || !Number.isInteger(costNum)) {
      return res.status(400).json({ error: "units and cost must be integers", code: "VALIDATION_ERROR" });
    }

    if (unitsNum <= 0 || costNum <= 0) {
      return res.status(400).json({ error: "units and cost must be positive", code: "VALIDATION_ERROR" });
    }

    try {
      const event = await persistAndSubmitUsageEvent({
        meterId: req.params.id,
        units: unitsNum,
        cost: costNum,
        sourceTopic: null,
      });

      invalidateCache(`/api/meters/${req.params.id}`);

      res.json({
        event,
        hash: event.on_chain_tx_hash,
        queued: !event.on_chain_tx_hash,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message, code: "INTERNAL_ERROR" });
    }
  });

  /** POST /api/meters/:id/topup — top up meter token balance (admin only) */
  meterRouter.post(
    "/:id/topup",
    adminAuth,
    asyncHandler(async (req, res) => {
      const { id } = req.params;
      const { amount } = req.body;
      if (!Number.isInteger(amount) || amount <= 0) {
        return res.status(400).json({ error: "Invalid amount", code: "VALIDATION_ERROR" });
      }
      try {
        const txHash = await stellar.invoke("topup_meter", [
          StellarSdk.nativeToScVal(id, { type: "symbol" }),
          StellarSdk.nativeToScVal(BigInt(amount), { type: "i128" }),
        ]);
        return res.json({ success: true, txHash, meterId: id, amount });
      } catch (err: any) {
        return res.status(500).json({ error: err.message, code: "CONTRACT_ERROR" });
      }
    }),
  );

  /** POST /api/meters/:id/transfer — admin transfers meter ownership to a new owner */
  meterRouter.post(
    "/:id/transfer",
    requireAdminKey,
    asyncHandler(async (req, res) => {
      const meterId = req.params.id;
      const { new_owner } = req.body;

      // Validate new_owner is provided
      if (!new_owner) {
        return res.status(400).json({ error: "new_owner is required", code: "VALIDATION_ERROR" });
      }

      // Validate new_owner is a valid Stellar address
      try {
        StellarSdk.StrKey.decodeEd25519PublicKey(new_owner);
      } catch {
        return res.status(400).json({ error: "Invalid Stellar address", code: "VALIDATION_ERROR" });
      }

      // Check if meter exists
      try {
        await stellar.query("get_meter", [
          StellarSdk.nativeToScVal(meterId, { type: "symbol" }),
        ]);
      } catch {
        return res.status(404).json({ error: "Meter not found", code: "NOT_FOUND" });
      }

      // Invoke transfer_meter_ownership contract function
      const hash = await stellar.invoke("transfer_meter_ownership", [
        StellarSdk.nativeToScVal(meterId, { type: "symbol" }),
        StellarSdk.nativeToScVal(new_owner, { type: "address" }),
      ]);

      res.json({ hash, meter_id: meterId, new_owner });
    }),
  );

  /** DELETE /api/meters/:id — admin deregisters a meter */
  meterRouter.delete(
    "/:id",
    requireAdminKey,
    asyncHandler(async (req, res) => {
      const meterId = req.params.id;
      let meter: any;
      try {
        const result = await stellar.query("get_meter", [
          StellarSdk.nativeToScVal(meterId, { type: "symbol" }),
        ]);
        meter = StellarSdk.scValToNative(result);
      } catch {
        return res.status(404).json({ error: "Meter not found", code: "NOT_FOUND" });
      }
      if (!meter) return res.status(404).json({ error: "Meter not found", code: "NOT_FOUND" });
      const hash = await stellar.invoke("deregister_meter", [
        StellarSdk.nativeToScVal(meterId, { type: "symbol" }),
      ]);
      invalidateCache(`/api/meters/${meterId}`);
      return res.json({ hash, meter_id: meterId, deleted: true });
    }),
  );

  /** POST /api/meters/:id/renew — trigger plan renewal payment for an expired meter */
  meterRouter.post(
    "/:id/renew",
    requireAdminKey,
    asyncHandler(async (req, res) => {
      const meterId = req.params.id;
      const { amount_xlm, plan } = req.body as { amount_xlm: unknown; plan: unknown };

      const amount = Number(amount_xlm);
      if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({ error: "amount_xlm must be a positive number", code: "VALIDATION_ERROR" });
      }

      let meter: any;
      try {
        const result = await stellar.query("get_meter", [
          StellarSdk.nativeToScVal(meterId, { type: "symbol" }),
        ]);
        meter = StellarSdk.scValToNative(result);
      } catch {
        return res.status(404).json({ error: "Meter not found", code: "NOT_FOUND" });
      }
      if (!meter) return res.status(404).json({ error: "Meter not found", code: "NOT_FOUND" });

      const planValue = plan ?? meter.plan;
      const hash = await stellar.invoke("make_payment", [
        StellarSdk.nativeToScVal(meterId, { type: "symbol" }),
        StellarSdk.nativeToScVal(BigInt(Math.round(amount * 1e7)), { type: "i128" }),
        StellarSdk.nativeToScVal(planValue, { type: "symbol" }),
      ]);
      return res.json({ hash, meter_id: meterId, renewed: true });
    }),
  );

  // ── Helper Functions ──────────────────────────────────────────────────────

  /**
   * Parse a contract event into a structured format.
   * Contract events have topics: (EVT_NS, action, meter_id)
   * and data varies by event type (payment, usage, etc.)
   */
  function parseContractEvent(event: any): any | null {
    try {
      const topics: StellarSdk.xdr.ScVal[] = (event.topic ?? []).map((t: string) =>
        StellarSdk.xdr.ScVal.fromXDR(t, "base64"),
      );

      if (topics.length < 2) return null;

      // topics[0] = namespace "solargrid", topics[1] = action (payment, usage, etc.)
      const actionVal = topics[1];
      const action =
        actionVal.switch().name === "scvSymbol"
          ? actionVal.sym().toString()
          : "unknown";

      // topics[2] = meter_id (if present)
      let meterId = "unknown";
      if (topics.length >= 3) {
        const meterVal = topics[2];
        meterId =
          meterVal.switch().name === "scvSymbol"
            ? meterVal.sym().toString()
            : "unknown";
      }

      // Parse event data
      const dataXdr = event.value ?? event.data;
      let eventData: any = null;

      if (dataXdr) {
        try {
          const dataVal = StellarSdk.xdr.ScVal.fromXDR(dataXdr, "base64");
          eventData = StellarSdk.scValToNative(dataVal);
        } catch {
          // leave null
        }
      }

      const timestamp = event.ledgerClosedAt
        ? new Date(event.ledgerClosedAt).toISOString()
        : new Date().toISOString();

      return {
        id: event.id ?? event.txHash ?? `${event.ledger}-${event.contractId}`,
        txHash: event.txHash ?? "",
        timestamp,
        action,
        meterId,
        data: eventData,
      };
    } catch {
      return null;
    }
  }

  return meterRouter;
}

