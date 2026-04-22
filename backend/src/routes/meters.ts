import { Router } from "express";
import * as StellarSdk from "@stellar/stellar-sdk";
import { adminInvoke, contractQuery, CONTRACT_ID, server, NETWORK_PASSPHRASE } from "../lib/stellar.js";
import { requireAuth } from "../middleware/auth.js";
import { getHistory, insertEvent } from "../lib/db.js";

export const meterRouter = Router();

/** GET /api/meters/:id — get meter status */
meterRouter.get("/:id", async (req, res) => {
  try {
    const result = await contractQuery("get_meter", [
      StellarSdk.nativeToScVal(req.params.id, { type: "symbol" }),
    ]);
    res.json({ meter: StellarSdk.scValToNative(result) });
  } catch (err: any) {
    res.status(404).json({ error: err.message });
  }
});

/** GET /api/meters/:id/access — check if meter is active */
meterRouter.get("/:id/access", async (req, res) => {
  try {
    const result = await contractQuery("check_access", [
      StellarSdk.nativeToScVal(req.params.id, { type: "symbol" }),
    ]);
    res.json({ active: StellarSdk.scValToNative(result) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/meters/:id/history — paginated usage history (#29)
 * Query params: page (default 1), limit (default 20)
 */
meterRouter.get("/:id/history", async (req, res) => {
  const meterId = req.params.id;
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));

  try {
    // Pull fresh events from the chain and persist any new ones
    await indexMeterEvents(meterId);
    const { rows, total } = getHistory(meterId, page, limit);
    res.json({ data: rows, page, limit, total, pages: Math.ceil(total / limit) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/meters — register a new meter (protected) */
meterRouter.post("/", requireAuth, async (req, res) => {
  const { meter_id, owner } = req.body as { meter_id: string; owner: string };
  if (!meter_id || !owner) {
    return res.status(400).json({ error: "meter_id and owner are required" });
  }
  try {
    const hash = await adminInvoke("register_meter", [
      StellarSdk.nativeToScVal(meter_id, { type: "symbol" }),
      StellarSdk.nativeToScVal(owner, { type: "address" }),
    ]);
    res.json({ hash });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/meters/:id/usage — IoT oracle reports usage (protected) */
meterRouter.post("/:id/usage", requireAuth, async (req, res) => {
  const { units, cost } = req.body as { units: number; cost: number };
  if (units == null || cost == null) {
    return res.status(400).json({ error: "units and cost are required" });
  }
  try {
    const hash = await adminInvoke("update_usage", [
      StellarSdk.nativeToScVal(req.params.id, { type: "symbol" }),
      StellarSdk.nativeToScVal(BigInt(units), { type: "u64" }),
      StellarSdk.nativeToScVal(BigInt(cost), { type: "i128" }),
    ]);
    res.json({ hash });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Event indexer ─────────────────────────────────────────────────────────────

async function indexMeterEvents(meterId: string) {
  const response = await server.getEvents({
    startLedger: 1,
    filters: [
      {
        type: "contract",
        contractIds: [CONTRACT_ID],
        topics: [
          [
            StellarSdk.xdr.ScVal.scvSymbol("usage_updated").toXDR("base64"),
            StellarSdk.nativeToScVal(meterId, { type: "symbol" }).toXDR("base64"),
          ],
        ],
      },
    ],
    limit: 200,
  });

  for (const event of response.events) {
    const native = StellarSdk.scValToNative(event.value) as {
      units: bigint;
      cost: bigint;
    };
    insertEvent({
      meter_id: meterId,
      ledger: event.ledger,
      tx_hash: event.txHash,
      units: Number(native.units),
      cost: Number(native.cost),
    });
  }
}
