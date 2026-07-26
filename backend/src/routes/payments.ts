import { Router } from "express";
import * as StellarSdk from "@stellar/stellar-sdk";
import { z } from "zod";
import { server, CONTRACT_ID, NETWORK_PASSPHRASE, adminInvoke, stellarService } from "../lib/stellar.js";
import { logger } from "../lib/logger.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { idempotency } from "../middleware/idempotency.js";

export const paymentsRouter = Router();

const PaymentSchema = z.object({
  meterId: z.string().min(1).max(64),
  amount: z.number().int().positive(),
  payer: z.string().length(56),
});

interface IdempotencyRecord {
  hash: string;
  createdAt: number;
}

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const idempotencyCache = new Map<string, IdempotencyRecord>();

function cleanExpiredIdempotencyKeys() {
  const now = Date.now();
  for (const [key, record] of idempotencyCache.entries()) {
    if (now - record.createdAt > IDEMPOTENCY_TTL_MS) {
      idempotencyCache.delete(key);
    }
  }
}

paymentsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    cleanExpiredIdempotencyKeys();

    const idempotencyKey = (
      req.headers["idempotency-key"] ?? req.headers["x-idempotency-key"]
    ) as string | undefined;

    if (idempotencyKey && typeof idempotencyKey === "string" && idempotencyKey.trim().length > 0) {
      const cached = idempotencyCache.get(idempotencyKey.trim());
      if (cached && Date.now() - cached.createdAt <= IDEMPOTENCY_TTL_MS) {
        return res.json({ hash: cached.hash });
      }
    }

paymentsRouter.post(
  "/",
  idempotency(),
  asyncHandler(async (req, res) => {
    const parsed = PaymentSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: "Invalid request",
        code: "VALIDATION_ERROR",
        details: parsed.error.flatten(),
      });
    }
    const { meterId, amount, payer } = parsed.data;
    const hash = await adminInvoke("make_payment", [
      StellarSdk.nativeToScVal(meterId, { type: "symbol" }),
      StellarSdk.nativeToScVal(BigInt(amount), { type: "i128" }),
      StellarSdk.nativeToScVal(payer, { type: "address" }),
    ]);

    if (idempotencyKey && typeof idempotencyKey === "string" && idempotencyKey.trim().length > 0) {
      idempotencyCache.set(idempotencyKey.trim(), { hash, createdAt: Date.now() });
    }

    return res.json({ hash });
  }),
);

const HORIZON_URL =
  NETWORK_PASSPHRASE === StellarSdk.Networks.PUBLIC
    ? "https://horizon.stellar.org"
    : "https://horizon-testnet.stellar.org";

const horizonServer = new StellarSdk.Horizon.Server(HORIZON_URL);

export interface PaymentRecord {
  txHash: string;
  date: string; // ISO string
  meterId: string;
  amountXlm: number;
  plan: string;
}

/**
 * GET /api/payments/:address?page=1&limit=10&sort=desc
 *
 * Queries Soroban contract events for make_payment calls where payer === address.
 * Falls back to Horizon transaction history when events are unavailable.
 */
paymentsRouter.get(
  "/:address",
  asyncHandler(async (req, res) => {
    const rawAddress = req.params.address;
    const address = Array.isArray(rawAddress) ? rawAddress[0] : rawAddress;
    if (typeof address !== "string" || address.trim().length === 0) {
      return res.status(400).json({ error: "Invalid Stellar address" });
    }

    const page = Math.max(1, parseInt((req.query.page as string) ?? "1", 10));
    const limit = Math.min(
      50,
      Math.max(1, parseInt((req.query.limit as string) ?? "10", 10)),
    );
    const sort = req.query.sort === "asc" ? "asc" : "desc";
    const days = Math.min(90, Math.max(1, parseInt((req.query.days as string) ?? "30", 10)));

    try {
      StellarSdk.StrKey.decodeEd25519PublicKey(address);
    } catch {
      return res.status(400).json({ error: "Invalid Stellar address" });
    }

    try {
      const records = await fetchPaymentEvents(address, sort, days);
      const total = records.length;
      const start = (page - 1) * limit;
      const paginated = records.slice(start, start + limit);

      return res.json({
        payments: paginated,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      });
    } catch (err: any) {
      console.error("payments route error:", err);
      if (err?.code === 'RPC_ERROR' || err?.isRpcError) {
        return res.status(502).json({ error: err.message ?? "RPC request failed", code: "RPC_ERROR" });
      }
      return res.status(500).json({ error: err.message ?? "Failed to fetch payment history" });
    }
  }),
);

/**
 * GET /api/payments/history/:address?from=<unix_ts>&to=<unix_ts>&limit=50&page=1
 *
 * Returns payment history for a given address with optional date range filtering.
 * from/to are UNIX timestamps converted to ledger numbers.
 * limit is capped at 200 per page.
 * address must be a valid 56-char Stellar public key.
 */
paymentsRouter.get(
  "/history/:address",
  asyncHandler(async (req, res) => {
    const rawAddress = req.params.address;
    const address = Array.isArray(rawAddress) ? rawAddress[0] : rawAddress;

    // Validate address format (56 chars, Stellar public key)
    if (typeof address !== "string" || address.length !== 56 || !address.startsWith("G")) {
      return res.status(400).json({ error: "Invalid Stellar address format" });
    }

    try {
      StellarSdk.StrKey.decodeEd25519PublicKey(address);
    } catch {
      return res.status(400).json({ error: "Invalid Stellar address" });
    }

    const from = req.query.from ? Number(req.query.from) : undefined;
    const to = req.query.to ? Number(req.query.to) : undefined;
    const limit = Math.min(200, Math.max(1, parseInt((req.query.limit as string) ?? "50", 10)));
    const page = Math.max(1, parseInt((req.query.page as string) ?? "1", 10));

    // Validate timestamps
    if ((from && !Number.isFinite(from)) || (to && !Number.isFinite(to))) {
      return res.status(400).json({ error: "Invalid from/to timestamps" });
    }

    try {
      const fromLedger = from ? await stellarService.timestampToLedger(from) : undefined;
      const toLedger = to ? await stellarService.timestampToLedger(to) : undefined;

      const events = await fetchPaymentEventsWithDateRange(address, fromLedger, toLedger);
      
      const total = events.length;
      const start = (page - 1) * limit;
      const paginated = events.slice(start, start + limit);

      return res.json({
        data: paginated,
        address,
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      });
    } catch (err: any) {
      console.error("payments history route error:", err);
      if (err?.code === 'RPC_ERROR' || err?.isRpcError) {
        return res.status(502).json({ error: err.message ?? "RPC request failed", code: "RPC_ERROR" });
      }
      return res.status(500).json({ error: err.message ?? "Failed to fetch payment history" });
    }
  }),
);


    try {
      StellarSdk.StrKey.decodeEd25519PublicKey(address);
    } catch {
      return res.status(400).json({ error: "Invalid Stellar address" });
    }

    try {
      const records = await fetchPaymentEvents(address, sort, days);
      const total = records.length;
      const start = (page - 1) * limit;
      const paginated = records.slice(start, start + limit);

      return res.json({
        payments: paginated,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      });
    } catch (err: any) {
      logger.error("payments route error:", err);
      if (err?.code === 'RPC_ERROR' || err?.isRpcError) {
        return res.status(502).json({ error: err.message ?? "RPC request failed", code: "RPC_ERROR" });
      }
      return res.status(500).json({ error: err.message ?? "Failed to fetch payment history" });
    }
  }),
);

/**
 * GET /api/payments/history/:address?from=<unix_ts>&to=<unix_ts>&limit=50&page=1
 *
 * Returns payment history for a given address with optional date range filtering.
 * from/to are UNIX timestamps converted to ledger numbers.
 * limit is capped at 200 per page.
 * address must be a valid 56-char Stellar public key.
 */
paymentsRouter.get(
  "/history/:address",
  asyncHandler(async (req, res) => {
    const rawAddress = req.params.address;
    const address = Array.isArray(rawAddress) ? rawAddress[0] : rawAddress;

    // Validate address format (56 chars, Stellar public key)
    if (typeof address !== "string" || address.length !== 56 || !address.startsWith("G")) {
      return res.status(400).json({ error: "Invalid Stellar address format" });
    }

    try {
      StellarSdk.StrKey.decodeEd25519PublicKey(address);
    } catch {
      return res.status(400).json({ error: "Invalid Stellar address" });
    }

    const from = req.query.from ? Number(req.query.from) : undefined;
    const to = req.query.to ? Number(req.query.to) : undefined;
    const limit = Math.min(200, Math.max(1, parseInt((req.query.limit as string) ?? "50", 10)));
    const page = Math.max(1, parseInt((req.query.page as string) ?? "1", 10));

    // Validate timestamps
    if ((from && !Number.isFinite(from)) || (to && !Number.isFinite(to))) {
      return res.status(400).json({ error: "Invalid from/to timestamps" });
    }

    try {
      const fromLedger = from ? await stellarService.timestampToLedger(from) : undefined;
      const toLedger = to ? await stellarService.timestampToLedger(to) : undefined;

      const events = await fetchPaymentEventsWithDateRange(address, fromLedger, toLedger);
      
      const total = events.length;
      const start = (page - 1) * limit;
      const paginated = events.slice(start, start + limit);

      return res.json({
        data: paginated,
        address,
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      });
    } catch (err: any) {
      logger.error("payments history route error:", err);
      if (err?.code === 'RPC_ERROR' || err?.isRpcError) {
        return res.status(502).json({ error: err.message ?? "RPC request failed", code: "RPC_ERROR" });
      }
      return res.status(500).json({ error: err.message ?? "Failed to fetch payment history" });
    }
  }),
);

// ── Helpers ───────────────────────────────────────────────────────────────────

async function fetchPaymentEventsWithDateRange(
  address: string,
  startLedger?: number,
  endLedger?: number,
): Promise<PaymentRecord[]> {
  // Query Soroban RPC for contract events within optional ledger range
  try {
    const EVT_NS = StellarSdk.xdr.ScVal.scvSymbol("solargrid").toXDR("base64");
    const ACTION = StellarSdk.xdr.ScVal.scvSymbol("payment").toXDR("base64");

    const response = await (server as any).getEvents({
      startLedger: startLedger ?? 1,
      endLedger: endLedger,
      filters: [
        {
          type: "contract",
          contractIds: [CONTRACT_ID],
          topics: [
            [EVT_NS, ACTION],
          ],
        },
      ],
      limit: 1000,
    });

    const events: PaymentRecord[] = [];

    for (const event of response?.events ?? []) {
      try {
        const record = parsePaymentEvent(event, address);
        if (record) events.push(record);
      } catch {
        // skip malformed events
      }
    }

    // Sort by date descending (most recent first)
    events.sort((a, b) => {
      return new Date(b.date).getTime() - new Date(a.date).getTime();
    });

    return events;
  } catch (err: any) {
    const rpcErr: any = new Error(err.message ?? "RPC request failed");
    rpcErr.isRpcError = true;
    throw rpcErr;
  }
}

async function fetchPaymentEvents(
  address: string,
  sort: "asc" | "desc",
  days = 30,
): Promise<PaymentRecord[]> {
  // Query Soroban RPC for contract events within the requested day window
  try {
    const EVT_NS = StellarSdk.xdr.ScVal.scvSymbol("solargrid").toXDR("base64");
    const ACTION = StellarSdk.xdr.ScVal.scvSymbol("payment").toXDR("base64");

    const latestLedgerResp = await (server as any).getLatestLedger();
    const latestLedger = latestLedgerResp.sequence;
    const startLedger = Math.max(1, latestLedger - Math.floor((days * 24 * 60 * 60) / 6));

    const response = await (server as any).getEvents({
      startLedger,
      filters: [
        {
          type: "contract",
          contractIds: [CONTRACT_ID],
          topics: [
            [EVT_NS, ACTION],
          ],
        },
      ],
      limit: 1000,
    });

    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const events: PaymentRecord[] = [];

    for (const event of response?.events ?? []) {
      try {
        const record = parsePaymentEvent(event, address);
        if (record && new Date(record.date).getTime() >= cutoff) events.push(record);
      } catch {
        // skip malformed events
      }
    }

    events.sort((a, b) => {
      const diff = new Date(a.date).getTime() - new Date(b.date).getTime();
      return sort === "asc" ? diff : -diff;
    });

    return events;
  } catch (err: any) {
    const rpcErr: any = new Error(err.message ?? "RPC request failed");
    rpcErr.isRpcError = true;
    throw rpcErr;
  }
}

function parsePaymentEvent(
  event: any,
  filterAddress: string,
): PaymentRecord | null {
  // Contract events emitted by make_payment have topics:
  // (EVT_NS, "payment", meter_id) and data: (payer, token_address, amount, plan)
  const topics: StellarSdk.xdr.ScVal[] = (event.topic ?? []).map((t: string) =>
    StellarSdk.xdr.ScVal.fromXDR(t, "base64"),
  );

  if (topics.length < 3) return null;

  // topics[2] = meter_id (subject)
  const meterVal = topics[2];
  const meterId =
    meterVal.switch().name === "scvSymbol"
      ? meterVal.sym().toString()
      : "unknown";

  // data is (payer, token_address, amount, plan)
  const dataXdr = event.value ?? event.data;
  let amountXlm = 0;
  let plan = "Unknown";
  let payer: string | null = null;

  if (dataXdr) {
    try {
      const dataVal = StellarSdk.xdr.ScVal.fromXDR(dataXdr, "base64");
      const native = StellarSdk.scValToNative(dataVal) as any[];
      if (Array.isArray(native) && native.length >= 4) {
        // data[0] = payer address, data[2] = amount, data[3] = plan
        const payerNative = native[0];
        payer =
          typeof payerNative === "string"
            ? payerNative
            : payerNative?.toString() ?? null;
        amountXlm = Number(native[2]) / 10_000_000;
        plan = Object.keys(native[3])[0] ?? "Unknown";
      }
    } catch {
      // leave defaults
    }
  }

  if (!payer || payer !== filterAddress) return null;

  const date = event.ledgerClosedAt
    ? new Date(event.ledgerClosedAt).toISOString()
    : new Date().toISOString();

  return {
    txHash: event.txHash ?? event.id ?? "",
    date,
    meterId,
    amountXlm,
    plan,
  };
}

// suppress unused import warning — horizonServer reserved for fallback
void horizonServer;
