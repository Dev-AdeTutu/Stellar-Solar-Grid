/**
 * Tests for GET /api/payments/:address
 *
 * Covers:
 *  - Issue #767: cursor-based pagination stays stable across requests even
 *    when new payments are inserted between page fetches (the old
 *    offset-based paging duplicated/dropped records in exactly this case).
 *  - Issue #766: the optional memo field round-trips through the
 *    `payment_received` event (present when set, absent when not).
 *  - The `plan` field is decoded correctly from the contract's unit-variant
 *    enum encoding.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Request, Response } from "express";
import { paymentsRouter } from "../src/routes/payments";
import * as StellarSdk from "@stellar/stellar-sdk";
import { server } from "../src/lib/stellar";

vi.mock("../src/lib/stellar", () => ({
  stellarService: { timestampToLedger: vi.fn() },
  CONTRACT_ID: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
  NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  server: {
    getEvents: vi.fn(),
    getLatestLedger: vi.fn().mockResolvedValue({ sequence: 1_000_000 }),
  },
  adminInvoke: vi.fn(),
}));

const PAYER = StellarSdk.Keypair.random().publicKey();
const TOKEN = StellarSdk.Keypair.random().publicKey();

/**
 * Builds a synthetic Soroban contract event matching what `make_payment`
 * actually emits: topics (EVT_NS, "payment", meter_id), data
 * (payer, token_address, amount, plan, memo). `plan` is encoded exactly as
 * the soroban-sdk enum derive does for a data-less variant — a one-element
 * tuple, i.e. `Vec([Symbol(planName)])` — which is the shape that motivated
 * the `decodePaymentPlan` fix in payments.ts.
 */
function buildPaymentEvent(opts: {
  meterId: string;
  amountStroops: bigint;
  plan: string;
  memo?: string;
  ledgerClosedAt: string;
  pagingToken: string;
  txHash: string;
}) {
  const { meterId, amountStroops, plan, memo, ledgerClosedAt, pagingToken, txHash } = opts;

  const topic = [
    StellarSdk.xdr.ScVal.scvSymbol("solargrid").toXDR("base64"),
    StellarSdk.xdr.ScVal.scvSymbol("payment").toXDR("base64"),
    StellarSdk.xdr.ScVal.scvSymbol(meterId).toXDR("base64"),
  ];

  const dataVal = StellarSdk.xdr.ScVal.scvVec([
    StellarSdk.nativeToScVal(PAYER, { type: "address" }),
    StellarSdk.nativeToScVal(TOKEN, { type: "address" }),
    StellarSdk.nativeToScVal(amountStroops, { type: "i128" }),
    StellarSdk.xdr.ScVal.scvVec([StellarSdk.xdr.ScVal.scvSymbol(plan)]),
    memo !== undefined
      ? StellarSdk.nativeToScVal(memo, { type: "string" })
      : StellarSdk.xdr.ScVal.scvVoid(),
  ]);

  return {
    topic,
    value: dataVal.toXDR("base64"),
    ledgerClosedAt,
    pagingToken,
    txHash,
    id: pagingToken,
  };
}

function getAddressHandler() {
  const layer = paymentsRouter.stack.find(
    (l: any) => l.route?.path === "/:address" && l.route?.methods.get,
  );
  if (!layer) throw new Error("GET /:address handler not found");
  return layer.route.stack[0].handle;
}

function makeReq(query: Record<string, string> = {}): Partial<Request> {
  return { params: { address: PAYER }, query };
}

/**
 * Invokes the route (wrapped in `asyncHandler`, which fires the handler's
 * promise but doesn't return it — see src/lib/asyncHandler.ts) and resolves
 * once the handler actually responds, rather than racing its internal
 * `await`s the way a plain `await handler(req, res)` would.
 */
function invoke(query: Record<string, string> = {}): Promise<{ json: any }> {
  return new Promise((resolve, reject) => {
    const res: any = {};
    res.status = vi.fn().mockReturnValue(res);
    res.json = vi.fn((body: unknown) => {
      resolve({ json: body });
      return res;
    });
    const next = (err?: unknown) => {
      if (err) reject(err);
    };
    getAddressHandler()(makeReq(query) as any, res as any, next);
  });
}

describe("paymentsRouter - GET /api/payments/:address", () => {
  beforeEach(() => {
    vi.mocked(server.getEvents).mockReset();
  });

  it("decodes plan and omits memo when the payment had none", async () => {
    vi.mocked(server.getEvents).mockResolvedValue({
      events: [
        buildPaymentEvent({
          meterId: "M1",
          amountStroops: 50_000_000n,
          plan: "Daily",
          ledgerClosedAt: new Date().toISOString(),
          pagingToken: "0000000001",
          txHash: "tx1",
        }),
      ],
    } as any);

    const { json: body } = await invoke({ limit: "10" });
    expect(body.payments).toHaveLength(1);
    expect(body.payments[0].plan).toBe("Daily");
    expect(body.payments[0].memo).toBeUndefined();
  });

  it("includes memo when the payment set one", async () => {
    vi.mocked(server.getEvents).mockResolvedValue({
      events: [
        buildPaymentEvent({
          meterId: "M1",
          amountStroops: 50_000_000n,
          plan: "Weekly",
          memo: "August electricity",
          ledgerClosedAt: new Date().toISOString(),
          pagingToken: "0000000001",
          txHash: "tx1",
        }),
      ],
    } as any);

    const { json: body } = await invoke({ limit: "10" });
    expect(body.payments[0].memo).toBe("August electricity");
    expect(body.payments[0].plan).toBe("Weekly");
  });

  it("paginates via cursor without duplicating or dropping records when a new payment lands between requests (Issue #767)", async () => {
    const now = Date.now();
    const initialEvents = Array.from({ length: 3 }, (_, i) =>
      buildPaymentEvent({
        meterId: `M${i}`,
        amountStroops: 10_000_000n,
        plan: "UsageBased",
        ledgerClosedAt: new Date(now - i * 1000).toISOString(),
        pagingToken: String(1000 - i).padStart(10, "0"),
        txHash: `tx-${i}`,
      }),
    );

    // Page 1: only the first 2 of 3 records exist so far.
    vi.mocked(server.getEvents).mockResolvedValueOnce({ events: initialEvents } as any);
    const { json: body1 } = await invoke({ limit: "2" });
    expect(body1.payments).toHaveLength(2);
    expect(body1.payments.map((p: any) => p.txHash)).toEqual(["tx-0", "tx-1"]);
    expect(body1.pagination.hasMore).toBe(true);
    const nextCursor = body1.pagination.nextCursor;
    expect(nextCursor).toBeTruthy();

    // Between page 1 and page 2, a brand-new payment is inserted at the
    // front (most recent) of the dataset — this is exactly the scenario
    // that broke offset-based pagination (Issue #767's repro).
    const newEvent = buildPaymentEvent({
      meterId: "M_NEW",
      amountStroops: 5_000_000n,
      plan: "UsageBased",
      ledgerClosedAt: new Date(now + 1000).toISOString(),
      pagingToken: "0000001001",
      txHash: "tx-new",
    });
    const eventsAfterInsert = [newEvent, ...initialEvents];

    // Page 2, using the cursor from page 1's last record — must return
    // exactly the remaining record (tx-2), not re-show tx-1 or skip tx-2.
    vi.mocked(server.getEvents).mockResolvedValueOnce({ events: eventsAfterInsert } as any);
    const { json: body2 } = await invoke({ limit: "2", cursor: nextCursor });
    expect(body2.payments.map((p: any) => p.txHash)).toEqual(["tx-2"]);
    expect(body2.pagination.hasMore).toBe(false);
  });
});
