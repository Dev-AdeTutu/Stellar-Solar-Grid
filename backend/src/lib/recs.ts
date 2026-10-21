/**
 * Renewable Energy Credit (REC) marketplace (#927).
 *
 * Mirrors `contracts/solar_grid/src/recs.rs` so the API and the chain agree on
 * quantities, prices, matching order and settlement arithmetic — the backend is
 * the read/aggregate surface over the same state machine the contract enforces.
 *
 * One REC unit represents 1 MWh of verified renewable generation. Prices are
 * quoted in micro-units of the settlement asset, exactly as on-chain, so a
 * value never changes meaning in transit.
 *
 * Compliance is a gate, not a label: a credit is `pending` from issuance and
 * cannot be listed or traded until the compliance authority attests it.
 * Settlement is automatic and atomic within `executeTrade`: units move
 * seller→buyer and consideration moves buyer→seller, less the marketplace fee.
 */

export type RecCompliance = "pending" | "verified" | "rejected";
export type RecSide = "sell" | "buy";
export type RecOrderStatus = "open" | "filled" | "cancelled";

export type Rec = {
  id: string;
  producerId: string;
  meterId: string;
  /** Generation backing the issue, in kWh. */
  kwhGenerated: number;
  vintage: number;
  registryRef: string;
  /** Total units issued (1 unit = 1 MWh). */
  totalUnits: number;
  /** Units not reserved by an open sell order. */
  availableUnits: number;
  compliance: RecCompliance;
  complianceRef: string | null;
  issuedAt: string;
  verifiedAt: string | null;
};

export type RecOrder = {
  id: string;
  recId: string;
  side: RecSide;
  ownerId: string;
  remaining: number;
  /** Price per unit, in micro-units of the settlement asset. */
  priceMicro: number;
  status: RecOrderStatus;
  createdAt: string;
};

export type RecTrade = {
  id: string;
  recId: string;
  sellerId: string;
  buyerId: string;
  sellOrderId: string;
  buyOrderId: string;
  units: number;
  priceMicro: number;
  /** Gross consideration in settlement-asset units. */
  consideration: number;
  fee: number;
  /** Consideration credited to the seller after the fee. */
  proceeds: number;
  settledAt: string;
};

/** Fixed-point scale for REC prices (micro-units per unit). */
export const REC_PRICE_SCALE = 1_000_000;
/** Basis-point denominator for the marketplace fee. */
export const REC_BPS_SCALE = 10_000;
/** Default marketplace fee (0.5%). */
export const DEFAULT_REC_FEE_BPS = 50;
/** kWh per REC unit — one unit is one MWh. */
export const KWH_PER_REC_UNIT = 1_000;

const recs = new Map<string, Rec>();
const orders = new Map<string, RecOrder>();
const trades = new Map<string, RecTrade>();
/** Units of each REC held by each holder, `${recId}:${holderId}`. */
const holdings = new Map<string, number>();
/** Rolling price-discovery inputs per REC. */
const indexes = new Map<string, { lastPriceMicro: number; totalUnits: number; totalValue: number; tradeCount: number }>();

let idSeq = 1;
function nextId(prefix: string): string {
  return `${prefix}-${Date.now()}-${idSeq++}`;
}

function fail(message: string, code: string): never {
  throw Object.assign(new Error(message), { code });
}

function holdingKey(recId: string, holderId: string): string {
  return `${recId}:${holderId}`;
}

function balanceOf(recId: string, holderId: string): number {
  return holdings.get(holdingKey(recId, holderId)) ?? 0;
}

function setBalance(recId: string, holderId: string, units: number): void {
  const key = holdingKey(recId, holderId);
  if (units === 0) holdings.delete(key);
  else holdings.set(key, units);
}

function loadRec(recId: string): Rec {
  const rec = recs.get(recId);
  if (!rec) fail("REC not found", "NOT_FOUND");
  return rec;
}

function loadOrder(orderId: string): RecOrder {
  const order = orders.get(orderId);
  if (!order) fail("Order not found", "NOT_FOUND");
  return order;
}

function requireTradable(rec: Rec): void {
  if (rec.compliance === "pending") fail("REC is awaiting compliance verification", "CONFLICT");
  if (rec.compliance === "rejected") fail("REC was rejected by the compliance authority", "CONFLICT");
}

// ── Issuance and compliance ──────────────────────────────────────────────────

/**
 * Issue RECs backed by `kwhGenerated` production. The registry reference is
 * required: a generation claim with nothing to audit against is not issuable.
 */
export function issueRec(params: {
  producerId: string;
  meterId: string;
  kwhGenerated: number;
  vintage?: number;
  registryRef: string;
}): Rec {
  if (!params.registryRef?.trim()) fail("registryRef is required", "VALIDATION_ERROR");
  if (!Number.isFinite(params.kwhGenerated) || params.kwhGenerated <= 0) {
    fail("kwhGenerated must be a positive number", "VALIDATION_ERROR");
  }
  const totalUnits = Math.floor(params.kwhGenerated / KWH_PER_REC_UNIT);
  if (totalUnits <= 0) {
    fail(`kwhGenerated must be at least ${KWH_PER_REC_UNIT} kWh (one REC is 1 MWh)`, "VALIDATION_ERROR");
  }

  const now = new Date().toISOString();
  const rec: Rec = {
    id: nextId("REC"),
    producerId: params.producerId,
    meterId: params.meterId,
    kwhGenerated: params.kwhGenerated,
    vintage: params.vintage ?? new Date().getUTCFullYear(),
    registryRef: params.registryRef.trim(),
    totalUnits,
    availableUnits: totalUnits,
    compliance: "pending",
    complianceRef: null,
    issuedAt: now,
    verifiedAt: null,
  };
  recs.set(rec.id, rec);
  // The registry mints straight into the producer's balance.
  setBalance(rec.id, params.producerId, totalUnits);
  return rec;
}

/** Compliance authority: attest a REC so it may be traded. */
export function verifyRec(recId: string, complianceRef: string): Rec {
  const rec = loadRec(recId);
  if (rec.compliance === "rejected") fail("REC was rejected by the compliance authority", "CONFLICT");
  if (!complianceRef?.trim()) fail("complianceRef is required", "VALIDATION_ERROR");
  rec.compliance = "verified";
  rec.complianceRef = complianceRef.trim();
  rec.verifiedAt = new Date().toISOString();
  return rec;
}

/** Compliance authority: reject a REC permanently. */
export function rejectRec(recId: string): Rec {
  const rec = loadRec(recId);
  rec.compliance = "rejected";
  return rec;
}

// ── Order book ───────────────────────────────────────────────────────────────

/** Producer: post a sell order for up to `units` of `recId`. */
export function listRecs(params: {
  sellerId: string;
  recId: string;
  units: number;
  priceMicro: number;
}): RecOrder {
  const rec = loadRec(params.recId);
  requireTradable(rec);
  if (!Number.isInteger(params.units) || params.units <= 0) {
    fail("units must be a positive integer", "VALIDATION_ERROR");
  }
  if (!Number.isFinite(params.priceMicro) || params.priceMicro <= 0) {
    fail("priceMicro must be a positive number", "VALIDATION_ERROR");
  }
  // Only what the seller holds and has not already reserved can be listed.
  if (params.units > balanceOf(params.recId, params.sellerId) || params.units > rec.availableUnits) {
    fail("Not enough unlisted REC units to sell", "VALIDATION_ERROR");
  }

  rec.availableUnits -= params.units;
  const order: RecOrder = {
    id: nextId("ORDER"),
    recId: params.recId,
    side: "sell",
    ownerId: params.sellerId,
    remaining: params.units,
    priceMicro: params.priceMicro,
    status: "open",
    createdAt: new Date().toISOString(),
  };
  orders.set(order.id, order);
  return order;
}

/** Buyer: post a buy order. Consideration moves on fill, not on placement. */
export function placeBid(params: {
  buyerId: string;
  recId: string;
  units: number;
  priceMicro: number;
}): RecOrder {
  const rec = loadRec(params.recId);
  requireTradable(rec);
  if (!Number.isInteger(params.units) || params.units <= 0) {
    fail("units must be a positive integer", "VALIDATION_ERROR");
  }
  if (!Number.isFinite(params.priceMicro) || params.priceMicro <= 0) {
    fail("priceMicro must be a positive number", "VALIDATION_ERROR");
  }

  const order: RecOrder = {
    id: nextId("ORDER"),
    recId: params.recId,
    side: "buy",
    ownerId: params.buyerId,
    remaining: params.units,
    priceMicro: params.priceMicro,
    status: "open",
    createdAt: new Date().toISOString(),
  };
  orders.set(order.id, order);
  return order;
}

/** Cancel an open order the caller owns; sell units return to availability. */
export function cancelOrder(orderId: string, requesterId: string): RecOrder {
  const order = loadOrder(orderId);
  if (order.ownerId !== requesterId) fail("Not the order owner", "FORBIDDEN");
  if (order.status !== "open") fail("Only open orders can be cancelled", "CONFLICT");

  order.status = "cancelled";
  if (order.side === "sell") {
    const rec = loadRec(order.recId);
    rec.availableUnits += order.remaining;
  }
  return order;
}

/**
 * Cross a bid against resting asks and settle each fill immediately.
 *
 * Fills happen in price-then-time priority at the resting (maker) price, so the
 * traded price reflects what sellers actually accepted rather than what the
 * aggressor was willing to pay.
 */
export function executeTrade(buyerId: string, buyOrderId: string, feeBps = DEFAULT_REC_FEE_BPS): RecTrade[] {
  const buy = loadOrder(buyOrderId);
  // Ownership before status, so a non-owner is refused without learning
  // whether the order is still open.
  if (buy.ownerId !== buyerId) fail("Not the order owner", "FORBIDDEN");
  if (buy.side !== "buy") fail("Order is not a buy order", "CONFLICT");
  if (buy.status !== "open") fail("Order is no longer open", "CONFLICT");
  requireTradable(loadRec(buy.recId));

  // listRecOrders already returns price-then-time priority, so filtering
  // preserves the intended fill order.
  const asks = listRecOrders(buy.recId, "sell").filter(
    (ask) => ask.priceMicro <= buy.priceMicro && ask.ownerId !== buyerId,
  );

  const executed: RecTrade[] = [];
  for (const ask of asks) {
    if (buy.remaining === 0) break;
    const units = Math.min(buy.remaining, ask.remaining);
    executed.push(settle({ recId: buy.recId, sellerId: ask.ownerId, buyerId, ask, buy, units, feeBps }));

    ask.remaining -= units;
    ask.status = ask.remaining === 0 ? "filled" : "open";
    buy.remaining -= units;
  }
  buy.status = buy.remaining === 0 ? "filled" : "open";
  return executed;
}

function settle(params: {
  recId: string;
  sellerId: string;
  buyerId: string;
  ask: RecOrder;
  buy: RecOrder;
  units: number;
  feeBps: number;
}): RecTrade {
  const consideration = round6((params.units * params.ask.priceMicro) / REC_PRICE_SCALE);
  if (consideration <= 0) fail("Trade consideration rounds to zero", "VALIDATION_ERROR");
  const fee = round6((consideration * params.feeBps) / REC_BPS_SCALE);
  const proceeds = round6(consideration - fee);

  // Effects before the trade is recorded, so a failure cannot half-settle.
  const from = balanceOf(params.recId, params.sellerId);
  if (params.units > from) fail("Seller no longer holds these REC units", "CONFLICT");
  setBalance(params.recId, params.sellerId, from - params.units);
  setBalance(params.recId, params.buyerId, balanceOf(params.recId, params.buyerId) + params.units);

  const trade: RecTrade = {
    id: nextId("TRADE"),
    recId: params.recId,
    sellerId: params.sellerId,
    buyerId: params.buyerId,
    sellOrderId: params.ask.id,
    buyOrderId: params.buy.id,
    units: params.units,
    priceMicro: params.ask.priceMicro,
    consideration,
    fee,
    proceeds,
    settledAt: new Date().toISOString(),
  };
  trades.set(trade.id, trade);

  const index = indexes.get(params.recId) ?? {
    lastPriceMicro: 0,
    totalUnits: 0,
    totalValue: 0,
    tradeCount: 0,
  };
  index.lastPriceMicro = params.ask.priceMicro;
  index.totalUnits += params.units;
  index.totalValue += consideration;
  index.tradeCount += 1;
  indexes.set(params.recId, index);

  return trade;
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** Open orders for a REC in price-time priority: cheapest ask first, highest bid first. */
export function listRecOrders(recId: string, side: RecSide): RecOrder[] {
  return [...orders.values()]
    .filter((order) => order.recId === recId && order.side === side && order.status === "open" && order.remaining > 0)
    .sort((a, b) => (a.priceMicro - b.priceMicro) || a.id.localeCompare(b.id));
}

export function getOrder(orderId: string): RecOrder | undefined {
  return orders.get(orderId);
}

export function getRec(recId: string): Rec | undefined {
  return recs.get(recId);
}

/** Every issued credit, newest first. */
export function listAllRecs(): Rec[] {
  return [...recs.values()].sort((a, b) => b.issuedAt.localeCompare(a.issuedAt));
}

export function getTrade(tradeId: string): RecTrade | undefined {
  return trades.get(tradeId);
}

export function listRecsByProducer(producerId: string): Rec[] {
  return [...recs.values()].filter((rec) => rec.producerId === producerId);
}

/** REC unit balances held by one address. */
export function getHoldings(holderId: string): Array<{ recId: string; units: number }> {
  return [...holdings.entries()]
    .filter(([key, units]) => units > 0 && key.endsWith(`:${holderId}`))
    .map(([key, units]) => ({ recId: key.slice(0, key.length - holderId.length - 1), units }));
}

export function getRecBalance(recId: string, holderId: string): number {
  return balanceOf(recId, holderId);
}

export function listTrades(recId?: string): RecTrade[] {
  return [...trades.values()]
    .filter((trade) => recId === undefined || trade.recId === recId)
    .sort((a, b) => Date.parse(b.settledAt) - Date.parse(a.settledAt));
}

/** Last traded price in micro-units; 0 before any trade. */
export function getLastPrice(recId: string): number {
  return indexes.get(recId)?.lastPriceMicro ?? 0;
}

/**
 * Volume-weighted average traded price in micro-units. Falls back to the last
 * price until volume exists, and reports 0 before the first trade — the market
 * never reports a price nobody has agreed to.
 */
export function getIndexPrice(recId: string): number {
  const index = indexes.get(recId);
  if (!index || index.totalUnits <= 0) return index?.lastPriceMicro ?? 0;
  return (index.totalValue * REC_PRICE_SCALE) / index.totalUnits;
}

export type RecMarketSummary = {
  recId: string;
  bestAskMicro: number | null;
  bestBidMicro: number | null;
  lastPriceMicro: number;
  indexPriceMicro: number;
  availableUnits: number;
  openAsks: number;
  openBids: number;
  tradeCount: number;
};

/** Price discovery snapshot for one credit, plus platform-wide totals. */
export function getMarketSummary(): {
  recs: RecMarketSummary[];
  totalIssuedUnits: number;
  totalTradedUnits: number;
  totalTradedValue: number;
  verifiedRecs: number;
  pendingRecs: number;
  rejectedRecs: number;
} {
  const summaries = [...recs.values()].map((rec): RecMarketSummary => {
    const asks = listRecOrders(rec.id, "sell");
    const bids = listRecOrders(rec.id, "buy");
    return {
      recId: rec.id,
      bestAskMicro: asks[0]?.priceMicro ?? null,
      bestBidMicro: bids[bids.length - 1]?.priceMicro ?? null,
      lastPriceMicro: getLastPrice(rec.id),
      indexPriceMicro: round6(getIndexPrice(rec.id)),
      availableUnits: rec.availableUnits,
      openAsks: asks.length,
      openBids: bids.length,
      tradeCount: indexes.get(rec.id)?.tradeCount ?? 0,
    };
  });

  return {
    recs: summaries,
    totalIssuedUnits: [...recs.values()].reduce((sum, rec) => sum + rec.totalUnits, 0),
    totalTradedUnits: [...trades.values()].reduce((sum, trade) => sum + trade.units, 0),
    totalTradedValue: round6([...trades.values()].reduce((sum, trade) => sum + trade.consideration, 0)),
    verifiedRecs: [...recs.values()].filter((rec) => rec.compliance === "verified").length,
    pendingRecs: [...recs.values()].filter((rec) => rec.compliance === "pending").length,
    rejectedRecs: [...recs.values()].filter((rec) => rec.compliance === "rejected").length,
  };
}

function round6(value: number): number {
  return Number(value.toFixed(6));
}

/** Reset all marketplace state. Test-only. */
export function resetRecsForTests(): void {
  recs.clear();
  orders.clear();
  trades.clear();
  holdings.clear();
  indexes.clear();
  idSeq = 1;
}
