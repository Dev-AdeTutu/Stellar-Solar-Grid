/**
 * REC tokenization, compliance gating, order matching, price discovery and
 * automatic settlement (#927).
 */
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";

vi.hoisted(() => {
  process.env.ADMIN_API_KEY = "test-admin-key";
});

// adminAuth imports twoFactor, which reads this at call time.
vi.mock("../src/lib/twoFactor.js", () => ({ hasTwoFactor: vi.fn(() => false) }));

const {
  DEFAULT_REC_FEE_BPS,
  KWH_PER_REC_UNIT,
  REC_PRICE_SCALE,
  cancelOrder,
  executeTrade,
  getHoldings,
  getIndexPrice,
  getLastPrice,
  getMarketSummary,
  getRecBalance,
  issueRec,
  listRecOrders,
  listAllRecs,
  listRecs,
  listTrades,
  placeBid,
  rejectRec,
  resetRecsForTests,
  verifyRec,
} = await import("../src/lib/recs.js");
const { recsRouter } = await import("../src/routes/recs.js");

const PRODUCER = "GPRODUCER";
const BUYER = "GBUYER";
/** 12,500 kWh → 12 RECs; one unit is one MWh. */
const KWH = 12_500;
const UNITS = 12;
/** 12.50 settlement units per REC, in micro-units. */
const PRICE = 12_500_000;

function issueVerified(): string {
  const rec = issueRec({ producerId: PRODUCER, meterId: "M1", kwhGenerated: KWH, registryRef: "REG-1" });
  verifyRec(rec.id, "CERT-1");
  return rec.id;
}

describe("REC issuance and compliance", () => {
  beforeEach(() => {
    resetRecsForTests();
  });

  it("tokenizes one unit per MWh into the producer's balance", () => {
    const recId = issueVerified();
    const rec = listAllRecs().find((r) => r.id === recId)!;

    expect(rec.totalUnits).toBe(UNITS);
    expect(rec.availableUnits).toBe(UNITS);
    expect(rec.kwhGenerated).toBe(KWH);
    expect(rec.compliance).toBe("verified");
    expect(rec.complianceRef).toBe("CERT-1");
    expect(getRecBalance(recId, PRODUCER)).toBe(UNITS);
  });

  it("refuses generation with nothing to audit against", () => {
    expect(() =>
      issueRec({ producerId: PRODUCER, meterId: "M1", kwhGenerated: KWH, registryRef: "  " }),
    ).toThrow(/registryRef/);
    expect(() =>
      issueRec({ producerId: PRODUCER, meterId: "M1", kwhGenerated: 0, registryRef: "REG" }),
    ).toThrow(/positive/);
    // Below one MWh there is nothing to tokenize.
    expect(() =>
      issueRec({ producerId: PRODUCER, meterId: "M1", kwhGenerated: KWH_PER_REC_UNIT - 1, registryRef: "REG" }),
    ).toThrow(/at least/);
  });

  it("keeps unverified and rejected credits off the market", () => {
    const rec = issueRec({ producerId: PRODUCER, meterId: "M1", kwhGenerated: KWH, registryRef: "REG-1" });
    expect(rec.compliance).toBe("pending");
    expect(() => listRecs({ sellerId: PRODUCER, recId: rec.id, units: 1, priceMicro: PRICE })).toThrow(
      /awaiting compliance/,
    );
    expect(() => placeBid({ buyerId: BUYER, recId: rec.id, units: 1, priceMicro: PRICE })).toThrow(
      /awaiting compliance/,
    );
    expect(() => verifyRec(rec.id, "")).toThrow(/complianceRef/);

    verifyRec(rec.id, "CERT-1");
    expect(() => listRecs({ sellerId: PRODUCER, recId: rec.id, units: 1, priceMicro: PRICE })).not.toThrow();

    rejectRec(rec.id);
    expect(() => listRecs({ sellerId: PRODUCER, recId: rec.id, units: 1, priceMicro: PRICE })).toThrow(
      /rejected/,
    );
  });

  it("only lets a producer list units they hold and have not reserved", () => {
    const recId = issueVerified();
    expect(() =>
      listRecs({ sellerId: PRODUCER, recId, units: UNITS + 1, priceMicro: PRICE }),
    ).toThrow(/Not enough unlisted REC units/);

    listRecs({ sellerId: PRODUCER, recId, units: 5, priceMicro: PRICE });
    expect(listAllRecs().find((r) => r.id === recId)!.availableUnits).toBe(UNITS - 5);
    expect(() =>
      listRecs({ sellerId: PRODUCER, recId, units: UNITS - 4, priceMicro: PRICE }),
    ).toThrow(/Not enough unlisted REC units/);
  });
});

describe("REC order book and settlement", () => {
  beforeEach(() => {
    resetRecsForTests();
  });

  it("returns reserved units to the producer when an order is cancelled", () => {
    const recId = issueVerified();
    const ask = listRecs({ sellerId: PRODUCER, recId, units: 5, priceMicro: PRICE });
    const cancelled = cancelOrder(ask.id, PRODUCER);
    expect(cancelled.status).toBe("cancelled");
    expect(listAllRecs().find((r) => r.id === recId)!.availableUnits).toBe(UNITS);
    expect(() => cancelOrder(ask.id, PRODUCER)).toThrow(/open orders/);
  });

  it("refuses to cancel an order the caller does not own", () => {
    const recId = issueVerified();
    const ask = listRecs({ sellerId: PRODUCER, recId, units: 1, priceMicro: PRICE });
    expect(() => cancelOrder(ask.id, BUYER)).toThrow(/Not the order owner/);
  });

  it("fills a crossing bid at the resting price, cheapest ask first", () => {
    const recId = issueVerified();
    // Post the dearer ask first so price priority has to choose.
    listRecs({ sellerId: PRODUCER, recId, units: 4, priceMicro: PRICE * 2 });
    const cheap = listRecs({ sellerId: PRODUCER, recId, units: 3, priceMicro: PRICE });

    const bid = placeBid({ buyerId: BUYER, recId, units: 3, priceMicro: PRICE });
    const executed = executeTrade(BUYER, bid.id);
    expect(executed).toHaveLength(1);
    // Filled at the maker's price, not the bid price.
    expect(executed[0].priceMicro).toBe(PRICE);
    expect(executed[0].sellOrderId).toBe(cheap.id);
    expect(executed[0].units).toBe(3);
  });

  it("transfers units and settles consideration automatically", () => {
    const recId = issueVerified();
    listRecs({ sellerId: PRODUCER, recId, units: 4, priceMicro: PRICE });
    const bid = placeBid({ buyerId: BUYER, recId, units: 4, priceMicro: PRICE });
    const [trade] = executeTrade(BUYER, bid.id);

    expect(getRecBalance(recId, PRODUCER)).toBe(UNITS - 4);
    expect(getRecBalance(recId, BUYER)).toBe(4);
    expect(getHoldings(BUYER)).toEqual([{ recId, units: 4 }]);

    expect(trade.consideration).toBe(Number(((4 * PRICE) / REC_PRICE_SCALE).toFixed(6)));
    expect(trade.fee).toBe(Number(((trade.consideration * DEFAULT_REC_FEE_BPS) / 10_000).toFixed(6)));
    expect(trade.proceeds).toBeCloseTo(trade.consideration - trade.fee, 6);
  });

  it("does not trade when the bid does not reach the ask", () => {
    const recId = issueVerified();
    listRecs({ sellerId: PRODUCER, recId, units: 2, priceMicro: PRICE });
    const bid = placeBid({ buyerId: BUYER, recId, units: 2, priceMicro: PRICE - 1 });
    expect(executeTrade(BUYER, bid.id)).toEqual([]);
    expect(getRecBalance(recId, BUYER)).toBe(0);
    // Nothing traded, so the market reports no price.
    expect(getLastPrice(recId)).toBe(0);
    expect(getIndexPrice(recId)).toBe(0);
  });

  it("fills one bid across several asks and leaves the rest of the book alone", () => {
    const recId = issueVerified();
    listRecs({ sellerId: PRODUCER, recId, units: 2, priceMicro: 10_000_000 });
    listRecs({ sellerId: PRODUCER, recId, units: 3, priceMicro: 11_000_000 });
    listRecs({ sellerId: PRODUCER, recId, units: 4, priceMicro: 30_000_000 });

    const bid = placeBid({ buyerId: BUYER, recId, units: 5, priceMicro: 11_000_000 });
    const executed = executeTrade(BUYER, bid.id);
    expect(executed).toHaveLength(2);
    expect(getRecBalance(recId, BUYER)).toBe(5);
    expect(listRecOrders(recId, "sell")).toHaveLength(1);
  });

  it("never lets a trader match against their own order", () => {
    const recId = issueVerified();
    // Only the producer holds units, so they are the only possible seller.
    expect(() =>
      listRecs({ sellerId: BUYER, recId, units: 1, priceMicro: PRICE }),
    ).toThrow(/Not enough unlisted REC units/);

    const ask = listRecs({ sellerId: PRODUCER, recId, units: 1, priceMicro: PRICE });
    const selfBid = placeBid({ buyerId: PRODUCER, recId, units: 1, priceMicro: PRICE });
    expect(executeTrade(PRODUCER, selfBid.id)).toEqual([]);
    // The ask survives untouched.
    expect(ask.remaining).toBe(1);
    expect(getRecBalance(recId, PRODUCER)).toBe(UNITS);
  });

  it("refuses to execute the same bid twice or execute a sell order", () => {
    const recId = issueVerified();
    listRecs({ sellerId: PRODUCER, recId, units: 2, priceMicro: PRICE });
    const bid = placeBid({ buyerId: BUYER, recId, units: 2, priceMicro: PRICE });
    executeTrade(BUYER, bid.id);
    expect(() => executeTrade(BUYER, bid.id)).toThrow(/no longer open/);

    const ask = listRecs({ sellerId: PRODUCER, recId, units: 1, priceMicro: PRICE });
    // A sell order is not a matchable bid, even for its own owner.
    expect(() => executeTrade(PRODUCER, ask.id)).toThrow(/not a buy order/);
    expect(() => executeTrade(BUYER, ask.id)).toThrow(/Not the order owner/);

    const openBid = placeBid({ buyerId: BUYER, recId, units: 1, priceMicro: PRICE });
    expect(() => executeTrade("GOTHER", openBid.id)).toThrow(/Not the order owner/);
  });
});

describe("REC price discovery", () => {
  beforeEach(() => {
    resetRecsForTests();
  });

  it("moves the last price and the volume-weighted index with trades", () => {
    const recId = issueVerified();
    // 2 units at 10.00
    listRecs({ sellerId: PRODUCER, recId, units: 2, priceMicro: 10_000_000 });
    executeTrade(BUYER, placeBid({ buyerId: BUYER, recId, units: 2, priceMicro: 10_000_000 }).id);
    expect(getLastPrice(recId)).toBe(10_000_000);
    expect(getIndexPrice(recId)).toBe(10_000_000);

    // 6 units at 20.00 → weighted average (2*10 + 6*20)/8 = 17.50
    listRecs({ sellerId: PRODUCER, recId, units: 6, priceMicro: 20_000_000 });
    executeTrade(BUYER, placeBid({ buyerId: BUYER, recId, units: 6, priceMicro: 20_000_000 }).id);
    expect(getLastPrice(recId)).toBe(20_000_000);
    expect(getIndexPrice(recId)).toBe(17_500_000);

    const summary = getMarketSummary();
    expect(summary.totalIssuedUnits).toBe(UNITS);
    expect(summary.totalTradedUnits).toBe(8);
    expect(summary.totalTradedValue).toBe(140);
    expect(summary.verifiedRecs).toBe(1);
  });

  it("reports best bid and ask without inventing a price", () => {
    const recId = issueVerified();
    listRecs({ sellerId: PRODUCER, recId, units: 2, priceMicro: 20_000_000 });
    listRecs({ sellerId: PRODUCER, recId, units: 2, priceMicro: 30_000_000 });
    placeBid({ buyerId: BUYER, recId, units: 1, priceMicro: 15_000_000 });
    placeBid({ buyerId: BUYER, recId, units: 1, priceMicro: 25_000_000 });

    const summary = getMarketSummary().recs.find((r) => r.recId === recId)!;
    expect(summary.bestAskMicro).toBe(20_000_000);
    expect(summary.bestBidMicro).toBe(25_000_000);
    expect(summary.lastPriceMicro).toBe(0);
    expect(summary.openAsks).toBe(2);
    expect(summary.openBids).toBe(2);
  });
});

describe("REC API", () => {
  let server: Server;
  let baseUrl = "";
  let recId = "";

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use("/api/recs", recsRouter);
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  });

  beforeEach(() => {
    resetRecsForTests();
  });

  /** Issue a verified credit over the API, returning its id. */
  async function issueOverApi(registryRef: string): Promise<string> {
    const res = await fetch(`${baseUrl}/api/recs/issue`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ producerId: PRODUCER, meterId: "M1", kwhGenerated: KWH, registryRef }),
    });
    expect(res.status).toBe(201);
    const id = (await res.json()).id as string;
    await fetch(`${baseUrl}/api/recs/${id}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ complianceRef: "CERT-API" }),
    });
    return id;
  }

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const auth = { "Content-Type": "application/json", "X-Admin-Key": "test-admin-key" };

  it("issues a credit with the admin key and rejects unauthenticated issuance", async () => {
    const payload = { producerId: PRODUCER, meterId: "M1", kwhGenerated: KWH, registryRef: "REG-API" };
    const unauthorized = await fetch(`${baseUrl}/api/recs/issue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect(unauthorized.status).toBe(401);

    const res = await fetch(`${baseUrl}/api/recs/issue`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(201);
    recId = (await res.json()).id;
    expect(recId).toBeTruthy();
  });

  it("runs the full issue → verify → list → trade → settle flow", async () => {
    recId = await issueOverApi("REG-FLOW");

    const listed = await fetch(`${baseUrl}/api/recs/${recId}/list`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ownerId: PRODUCER, units: 3, priceMicro: PRICE }),
    });
    expect(listed.status).toBe(201);
    const ask = await listed.json();
    expect(ask.remaining).toBe(3);

    const book = await fetch(`${baseUrl}/api/recs/${recId}/orders?side=sell`);
    expect((await book.json()).count).toBe(1);

    const bid = await (
      await fetch(`${baseUrl}/api/recs/${recId}/bid`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ownerId: BUYER, units: 3, priceMicro: PRICE }),
      })
    ).json();

    const executed = await fetch(`${baseUrl}/api/recs/orders/${bid.id}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ buyerId: BUYER }),
    });
    expect(executed.status).toBe(200);
    const { trades, count } = await executed.json();
    expect(count).toBe(1);
    // 3 units at 12.50 = 37.50, less the 0.5% marketplace fee.
    expect(trades[0].consideration).toBeCloseTo(37.5, 6);
    expect(trades[0].fee).toBeCloseTo(37.5 * (DEFAULT_REC_FEE_BPS / 10_000), 6);
    expect(trades[0].proceeds).toBeCloseTo(37.5 * (1 - DEFAULT_REC_FEE_BPS / 10_000), 6);
    expect(ask.id).toBe(trades[0].sellOrderId);

    const holder = await (await fetch(`${baseUrl}/api/recs/holder/${BUYER}`)).json();
    expect(holder.holdings).toEqual([{ recId, units: 3 }]);

    const market = await (await fetch(`${baseUrl}/api/recs/market`)).json();
    const summary = market.recs.find((r: { recId: string }) => r.recId === recId);
    expect(summary.lastPriceMicro).toBe(PRICE);
    expect(summary.indexPriceMicro).toBe(PRICE);
    expect(summary.tradeCount).toBe(1);

    const recTrades = await (await fetch(`${baseUrl}/api/recs/${recId}/trades`)).json();
    expect(recTrades.count).toBe(1);
    const produced = await (await fetch(`${baseUrl}/api/recs/producer/${PRODUCER}`)).json();
    expect(produced.recs.length).toBe(1);
  });

  it("reports domain failures with meaningful statuses", async () => {
    recId = await issueOverApi("REG-ERR");

    const missing = await fetch(`${baseUrl}/api/recs/REC-NOPE`);
    expect(missing.status).toBe(404);
    expect((await fetch(`${baseUrl}/api/recs/REC-NOPE/orders`)).status).toBe(404);

    const badBody = await fetch(`${baseUrl}/api/recs/${recId}/list`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ownerId: PRODUCER, units: 0, priceMicro: PRICE }),
    });
    expect(badBody.status).toBe(400);
    expect((await badBody.json()).code).toBe("VALIDATION_ERROR");

    // Selling more than is held is a validation failure, not a crash.
    const oversell = await fetch(`${baseUrl}/api/recs/${recId}/list`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ownerId: PRODUCER, units: UNITS + 1, priceMicro: PRICE }),
    });
    expect(oversell.status).toBe(400);

    const unknownOrder = await fetch(`${baseUrl}/api/recs/orders/ORDER-NOPE/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requesterId: PRODUCER }),
    });
    expect(unknownOrder.status).toBe(404);
  });

  it("blocks listing an unverified credit over the API", async () => {
    const res = await fetch(`${baseUrl}/api/recs/issue`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ producerId: PRODUCER, meterId: "M1", kwhGenerated: KWH, registryRef: "REG-P" }),
    });
    const pending = (await res.json()).id as string;

    const listed = await fetch(`${baseUrl}/api/recs/${pending}/list`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ownerId: PRODUCER, units: 1, priceMicro: PRICE }),
    });
    expect(listed.status).toBe(409);
    expect((await listed.json()).error).toMatch(/compliance/);
  });
});
