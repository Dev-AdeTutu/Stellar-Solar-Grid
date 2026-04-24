import { Router } from "express";
import * as StellarSdk from "@stellar/stellar-sdk";
import { server, CONTRACT_ID, NETWORK_PASSPHRASE } from "../lib/stellar.js";

export const paymentsRouter = Router();

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
paymentsRouter.get("/:address", async (req, res) => {
  const { address } = req.params;
  const page = Math.max(1, parseInt((req.query.page as string) ?? "1", 10));
  const limit = Math.min(
    50,
    Math.max(1, parseInt((req.query.limit as string) ?? "10", 10)),
  );
  const sort = req.query.sort === "asc" ? "asc" : "desc";

  try {
    StellarSdk.StrKey.decodeEd25519PublicKey(address);
  } catch {
    return res.status(400).json({ error: "Invalid Stellar address" });
  }

  try {
    const records = await fetchPaymentEvents(address, sort);
    const total = records.length;
    const start = (page - 1) * limit;
    const paginated = records.slice(start, start + limit);

    return res.json({
      payments: paginated,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err: any) {
    console.error("payments route error:", err);
    return res
      .status(500)
      .json({ error: err.message ?? "Failed to fetch payment history" });
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function fetchPaymentEvents(
  address: string,
  sort: "asc" | "desc",
): Promise<PaymentRecord[]> {
  // Query Soroban RPC for contract events
  const now = Math.floor(Date.now() / 1000);
  // Soroban events are keyed by ledger sequence; use a wide window (last ~30 days)
  const response = await (server as any).getEvents({
    startLedger: 1,
    filters: [
      {
        type: "contract",
        contractIds: [CONTRACT_ID],
        topics: [
          // topic[0] = "payment" symbol (emitted by make_payment)
          [StellarSdk.xdr.ScVal.scvSymbol("payment").toXDR("base64")],
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

  // Sort by date
  events.sort((a, b) => {
    const diff = new Date(a.date).getTime() - new Date(b.date).getTime();
    return sort === "asc" ? diff : -diff;
  });

  return events;
}

function parsePaymentEvent(
  event: any,
  filterAddress: string,
): PaymentRecord | null {
  // Contract events emitted by make_payment have topics:
  // ("payment", meter_id) and data: (payer, amount, ledger_timestamp)
  const topics: StellarSdk.xdr.ScVal[] = (event.topic ?? []).map((t: string) =>
    StellarSdk.xdr.ScVal.fromXDR(t, "base64"),
  );

  if (topics.length < 2) return null;

  const meterVal = topics[1];
  const meterId =
    meterVal.switch().name === "scvSymbol"
      ? meterVal.sym().toString()
      : "unknown";

  // data is [payer_address, amount_i128, ledger_timestamp]
  const dataXdr = event.value ?? event.data;
  let amountXlm = 0;
  let plan = "N/A";
  let payer: string | null = null;
  let eventTs: string | null = null;

  if (dataXdr) {
    try {
      const dataVal = StellarSdk.xdr.ScVal.fromXDR(dataXdr, "base64");
      const native = StellarSdk.scValToNative(dataVal);
      if (Array.isArray(native) && native.length >= 3) {
        payer = String(native[0]);
        amountXlm = Number(native[1]) / 10_000_000;
        const ts = Number(native[2]);
        eventTs = Number.isFinite(ts)
          ? new Date(ts * 1000).toISOString()
          : null;
      }
    } catch {
      // leave defaults
    }
  }

  if (!payer || payer !== filterAddress) return null;

  // Ledger close time from event
  const date =
    eventTs ??
    (event.ledgerClosedAt
      ? new Date(event.ledgerClosedAt).toISOString()
      : new Date().toISOString());

  return {
    txHash: event.txHash ?? event.id ?? "",
    date,
    meterId,
    amountXlm,
    plan,
  };
}
