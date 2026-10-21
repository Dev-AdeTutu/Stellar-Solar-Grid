/**
 * Peer-to-peer energy trading (#879).
 *
 * Producers post sell offers; consumers post buy offers. The matching
 * algorithm pairs compatible offers (price overlap, quantity) and
 * executes settlement automatically.
 */

export type TradeDirection = "sell" | "buy";
export type TradeStatus = "open" | "matched" | "settled" | "cancelled" | "disputed";

export type TradeOffer = {
  id: string;
  userId: string;
  direction: TradeDirection;
  energyKwh: number;
  pricePerKwh: number;
  minKwh: number;
  status: TradeStatus;
  createdAt: string;
  expiresAt: string;
  meterId: string | null;
  location: string | null;
};

export type TradeMatch = {
  id: string;
  sellOfferId: string;
  buyOfferId: string;
  energyKwh: number;
  pricePerKwh: number;
  totalXlm: number;
  fee: number;
  sellerNet: number;
  matchedAt: string;
  status: TradeStatus;
  settledAt: string | null;
  disputeReason: string | null;
};

// 0.5% platform fee on each trade
const PLATFORM_FEE_RATE = 0.005;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

const offers = new Map<string, TradeOffer>();
const matches = new Map<string, TradeMatch>();

let idSeq = 1;
function nextId(prefix: string): string {
  return `${prefix}-${Date.now()}-${idSeq++}`;
}

export function createOffer(params: {
  userId: string;
  direction: TradeDirection;
  energyKwh: number;
  pricePerKwh: number;
  minKwh?: number;
  ttlMs?: number;
  meterId?: string;
  location?: string;
}): TradeOffer {
  const id = nextId("OFFER");
  const now = new Date();
  const offer: TradeOffer = {
    id,
    userId: params.userId,
    direction: params.direction,
    energyKwh: params.energyKwh,
    pricePerKwh: params.pricePerKwh,
    minKwh: params.minKwh ?? Math.max(1, params.energyKwh * 0.1),
    status: "open",
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + (params.ttlMs ?? DEFAULT_TTL_MS)).toISOString(),
    meterId: params.meterId ?? null,
    location: params.location ?? null,
  };
  offers.set(id, offer);
  return offer;
}

export function cancelOffer(offerId: string, userId: string): TradeOffer {
  const offer = offers.get(offerId);
  if (!offer) throw Object.assign(new Error("Offer not found"), { code: "NOT_FOUND" });
  if (offer.userId !== userId) throw Object.assign(new Error("Not the owner"), { code: "FORBIDDEN" });
  if (offer.status !== "open") throw Object.assign(new Error("Only open offers can be cancelled"), { code: "CONFLICT" });
  offer.status = "cancelled";
  return offer;
}

export function getOpenOffers(direction?: TradeDirection): TradeOffer[] {
  const now = new Date().toISOString();
  return [...offers.values()].filter(
    (o) =>
      o.status === "open" &&
      o.expiresAt > now &&
      (direction === undefined || o.direction === direction),
  );
}

export function getOffer(offerId: string): TradeOffer | undefined {
  return offers.get(offerId);
}

export function getUserOffers(userId: string): TradeOffer[] {
  return [...offers.values()].filter((o) => o.userId === userId);
}

export function getUserMatches(userId: string): TradeMatch[] {
  const userOfferIds = new Set(
    [...offers.values()].filter((o) => o.userId === userId).map((o) => o.id),
  );
  return [...matches.values()].filter(
    (m) => userOfferIds.has(m.sellOfferId) || userOfferIds.has(m.buyOfferId),
  );
}

/**
 * Find compatible sell/buy offer pairs.
 * Matching criteria: buyer's maxPrice >= seller's askPrice, energy overlap.
 */
export function runMatchingAlgorithm(): TradeMatch[] {
  const now = new Date().toISOString();
  const sells = [...offers.values()].filter(
    (o) => o.direction === "sell" && o.status === "open" && o.expiresAt > now,
  );
  const buys = [...offers.values()].filter(
    (o) => o.direction === "buy" && o.status === "open" && o.expiresAt > now,
  );

  const newMatches: TradeMatch[] = [];

  for (const sell of sells) {
    for (const buy of buys) {
      if (buy.userId === sell.userId) continue;
      if (buy.pricePerKwh < sell.pricePerKwh) continue;

      const tradableKwh = Math.min(sell.energyKwh, buy.energyKwh);
      if (tradableKwh < Math.max(sell.minKwh, buy.minKwh)) continue;

      const settlementPrice = (sell.pricePerKwh + buy.pricePerKwh) / 2;
      const totalXlm = tradableKwh * settlementPrice;
      const fee = totalXlm * PLATFORM_FEE_RATE;
      const sellerNet = totalXlm - fee;

      const match: TradeMatch = {
        id: nextId("MATCH"),
        sellOfferId: sell.id,
        buyOfferId: buy.id,
        energyKwh: Number(tradableKwh.toFixed(4)),
        pricePerKwh: Number(settlementPrice.toFixed(4)),
        totalXlm: Number(totalXlm.toFixed(4)),
        fee: Number(fee.toFixed(4)),
        sellerNet: Number(sellerNet.toFixed(4)),
        matchedAt: new Date().toISOString(),
        status: "matched",
        settledAt: null,
        disputeReason: null,
      };

      sell.status = "matched";
      buy.status = "matched";
      matches.set(match.id, match);
      newMatches.push(match);
      break; // one match per sell offer per run
    }
  }

  return newMatches;
}

export function settleMatch(matchId: string): TradeMatch {
  const match = matches.get(matchId);
  if (!match) throw Object.assign(new Error("Match not found"), { code: "NOT_FOUND" });
  if (match.status !== "matched") throw Object.assign(new Error("Match is not in matched state"), { code: "CONFLICT" });

  match.status = "settled";
  match.settledAt = new Date().toISOString();

  const sell = offers.get(match.sellOfferId);
  const buy = offers.get(match.buyOfferId);
  if (sell) sell.status = "settled";
  if (buy) buy.status = "settled";

  return match;
}

export function raiseDispute(matchId: string, reason: string): TradeMatch {
  const match = matches.get(matchId);
  if (!match) throw Object.assign(new Error("Match not found"), { code: "NOT_FOUND" });
  if (match.status === "settled") throw Object.assign(new Error("Cannot dispute a settled trade"), { code: "CONFLICT" });

  match.status = "disputed";
  match.disputeReason = reason;
  return match;
}

export function getMatch(matchId: string): TradeMatch | undefined {
  return matches.get(matchId);
}

export function getTradingStats(): {
  openSellOffers: number;
  openBuyOffers: number;
  totalMatches: number;
  totalSettled: number;
  totalVolumeKwh: number;
  totalVolumeXlm: number;
} {
  const now = new Date().toISOString();
  let openSell = 0;
  let openBuy = 0;
  for (const o of offers.values()) {
    if (o.status === "open" && o.expiresAt > now) {
      if (o.direction === "sell") openSell++;
      else openBuy++;
    }
  }
  let totalMatches = 0;
  let totalSettled = 0;
  let totalVolumeKwh = 0;
  let totalVolumeXlm = 0;
  for (const m of matches.values()) {
    totalMatches++;
    if (m.status === "settled") {
      totalSettled++;
      totalVolumeKwh += m.energyKwh;
      totalVolumeXlm += m.totalXlm;
    }
  }
  return {
    openSellOffers: openSell,
    openBuyOffers: openBuy,
    totalMatches,
    totalSettled,
    totalVolumeKwh: Number(totalVolumeKwh.toFixed(4)),
    totalVolumeXlm: Number(totalVolumeXlm.toFixed(4)),
  };
}

export function getRecentMatches(limit = 50): TradeMatch[] {
  return [...matches.values()].sort((a, b) => b.matchedAt.localeCompare(a.matchedAt)).slice(0, limit);
}

// ---------------------------------------------------------------------------
// Energy credit derivatives (#1062)
// ---------------------------------------------------------------------------

export type DerivativeKind = "future" | "call" | "put";
export type DerivativeStatus = "open" | "matched" | "settled" | "expired" | "liquidated" | "cancelled";

export type DerivativeOrder = {
  id: string;
  userId: string;
  kind: DerivativeKind;
  /** Underlying energy credits (kWh) covered by the contract. */
  quantityKwh: number;
  /** Strike price per kWh for options; forward price per kWh for futures. */
  strikePrice: number;
  /** Premium per kWh paid by the buyer (options only; 0 for futures). */
  premiumPerKwh: number;
  /** Initial margin required per kWh from each side. */
  marginPerKwh: number;
  status: DerivativeStatus;
  createdAt: string;
  expiresAt: string;
  /** Counterparty user id once matched. */
  counterpartyId: string | null;
  matchedAt: string | null;
  settledAt: string | null;
  settlementPrice: number | null;
  settlementXlm: number | null;
};

export type MarginAccount = {
  userId: string;
  balanceXlm: number;
  lockedXlm: number;
  updatedAt: string;
};

export type LiquidationCheck = {
  userId: string;
  balanceXlm: number;
  lockedXlm: number;
  requiredXlm: number;
  maintenanceXlm: number;
  healthy: boolean;
  shortfallXlm: number;
};

// Derivatives use the same platform fee rate and default TTL as spot trades.
const DERIVATIVE_MAINTENANCE_RATIO = 0.5; // maintenance margin = 50% of initial
const DEFAULT_DERIVATIVE_TTL_MS = DEFAULT_TTL_MS;

const derivativeOrders = new Map<string, DerivativeOrder>();
const marginAccounts = new Map<string, MarginAccount>();

function getOrCreateMarginAccount(userId: string): MarginAccount {
  let account = marginAccounts.get(userId);
  if (!account) {
    account = { userId, balanceXlm: 0, lockedXlm: 0, updatedAt: new Date().toISOString() };
    marginAccounts.set(userId, account);
  }
  return account;
}

export function depositMargin(userId: string, amountXlm: number): MarginAccount {
  if (!(amountXlm > 0)) throw Object.assign(new Error("Deposit must be positive"), { code: "INVALID" });
  const account = getOrCreateMarginAccount(userId);
  account.balanceXlm = Number((account.balanceXlm + amountXlm).toFixed(4));
  account.updatedAt = new Date().toISOString();
  return account;
}

export function getMarginAccount(userId: string): MarginAccount {
  return { ...getOrCreateMarginAccount(userId) };
}

export function createDerivativeOrder(params: {
  userId: string;
  kind: DerivativeKind;
  quantityKwh: number;
  strikePrice: number;
  premiumPerKwh?: number;
  marginPerKwh?: number;
  ttlMs?: number;
}): DerivativeOrder {
  if (!(params.quantityKwh > 0)) throw Object.assign(new Error("Quantity must be positive"), { code: "INVALID" });
  if (!(params.strikePrice > 0)) throw Object.assign(new Error("Strike price must be positive"), { code: "INVALID" });
  const premiumPerKwh = params.kind === "future" ? 0 : (params.premiumPerKwh ?? 0);
  if (premiumPerKwh < 0) throw Object.assign(new Error("Premium cannot be negative"), { code: "INVALID" });

  const marginPerKwh = params.marginPerKwh ?? Number((params.strikePrice * 0.1).toFixed(4));
  const requiredMargin = Number((marginPerKwh * params.quantityKwh).toFixed(4));

  const account = getOrCreateMarginAccount(params.userId);
  if (account.balanceXlm - account.lockedXlm < requiredMargin) {
    throw Object.assign(new Error("Insufficient margin"), { code: "INSUFFICIENT_MARGIN" });
  }
  account.lockedXlm = Number((account.lockedXlm + requiredMargin).toFixed(4));
  account.updatedAt = new Date().toISOString();

  const now = new Date();
  const order: DerivativeOrder = {
    id: nextId("DERIV"),
    userId: params.userId,
    kind: params.kind,
    quantityKwh: params.quantityKwh,
    strikePrice: params.strikePrice,
    premiumPerKwh,
    marginPerKwh,
    status: "open",
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + (params.ttlMs ?? DEFAULT_DERIVATIVE_TTL_MS)).toISOString(),
    counterpartyId: null,
    matchedAt: null,
    settledAt: null,
    settlementPrice: null,
    settlementXlm: null,
  };
  derivativeOrders.set(order.id, order);
  return order;
}

export function getDerivativeOrder(orderId: string): DerivativeOrder | undefined {
  return derivativeOrders.get(orderId);
}

export function getUserDerivativeOrders(userId: string): DerivativeOrder[] {
  return [...derivativeOrders.values()].filter(
    (o) => o.userId === userId || o.counterpartyId === userId,
  );
}

export function cancelDerivativeOrder(orderId: string, userId: string): DerivativeOrder {
  const order = derivativeOrders.get(orderId);
  if (!order) throw Object.assign(new Error("Derivative order not found"), { code: "NOT_FOUND" });
  if (order.userId !== userId) throw Object.assign(new Error("Not the owner"), { code: "FORBIDDEN" });
  if (order.status !== "open") throw Object.assign(new Error("Only open orders can be cancelled"), { code: "CONFLICT" });

  order.status = "cancelled";
  const account = getOrCreateMarginAccount(userId);
  const release = Number((order.marginPerKwh * order.quantityKwh).toFixed(4));
  account.lockedXlm = Number(Math.max(0, account.lockedXlm - release).toFixed(4));
  account.updatedAt = new Date().toISOString();
  return order;
}

/**
 * Match open derivative orders of the same kind and strike price.
 * Futures match on equal strike; options match on equal strike and premium.
 */
export function runDerivativeMatching(): DerivativeOrder[] {
  const now = new Date().toISOString();
  const open = [...derivativeOrders.values()].filter(
    (o) => o.status === "open" && o.expiresAt > now,
  );

  const matched: DerivativeOrder[] = [];

  for (const order of open) {
    if (order.status !== "open") continue;
    const counterparty = open.find(
      (o) =>
        o.id !== order.id &&
        o.status === "open" &&
        o.userId !== order.userId &&
        o.kind === order.kind &&
        o.strikePrice === order.strikePrice &&
        o.quantityKwh === order.quantityKwh &&
        (order.kind === "future" || o.premiumPerKwh === order.premiumPerKwh),
    );
    if (!counterparty) continue;

    const matchedAt = new Date().toISOString();
    order.status = "matched";
    order.counterpartyId = counterparty.userId;
    order.matchedAt = matchedAt;
    counterparty.status = "matched";
    counterparty.counterpartyId = order.userId;
    counterparty.matchedAt = matchedAt;

    matched.push(order, counterparty);
  }

  return matched;
}

/**
 * Compute the settlement value (XLM) of a derivative at a given underlying price.
 * Futures settle on the price difference; options settle on intrinsic value.
 */
export function computeDerivativeSettlement(order: DerivativeOrder, underlyingPrice: number): number {
  const diff =
    order.kind === "call"
      ? Math.max(0, underlyingPrice - order.strikePrice)
      : order.kind === "put"
        ? Math.max(0, order.strikePrice - underlyingPrice)
        : underlyingPrice - order.strikePrice;
  return Number((diff * order.quantityKwh).toFixed(4));
}

/**
 * Settle a matched derivative at expiry using the given underlying price.
 * Applies the platform fee and releases locked margin back to both parties.
 */
export function settleDerivative(orderId: string, underlyingPrice: number): DerivativeOrder {
  const order = derivativeOrders.get(orderId);
  if (!order) throw Object.assign(new Error("Derivative order not found"), { code: "NOT_FOUND" });
  if (order.status !== "matched") throw Object.assign(new Error("Order is not matched"), { code: "CONFLICT" });
  if (!(underlyingPrice > 0)) throw Object.assign(new Error("Underlying price must be positive"), { code: "INVALID" });

  const settlement = computeDerivativeSettlement(order, underlyingPrice);
  const fee = Number((Math.abs(settlement) * PLATFORM_FEE_RATE).toFixed(4));
  const net = Number((settlement - fee).toFixed(4));

  order.status = "settled";
  order.settledAt = new Date().toISOString();
  order.settlementPrice = underlyingPrice;
  order.settlementXlm = net;

  const release = Number((order.marginPerKwh * order.quantityKwh).toFixed(4));
  const account = getOrCreateMarginAccount(order.userId);
  account.lockedXlm = Number(Math.max(0, account.lockedXlm - release).toFixed(4));
  account.balanceXlm = Number((account.balanceXlm + net).toFixed(4));
  account.updatedAt = new Date().toISOString();

  if (order.counterpartyId) {
    const cp = getOrCreateMarginAccount(order.counterpartyId);
    cp.lockedXlm = Number(Math.max(0, cp.lockedXlm - release).toFixed(4));
    cp.balanceXlm = Number((cp.balanceXlm - net).toFixed(4));
    cp.updatedAt = new Date().toISOString();
  }

  return order;
}

/**
 * Check whether an account's margin is healthy against its open derivative exposure.
 */
export function checkLiquidation(userId: string): LiquidationCheck {
  const account = getOrCreateMarginAccount(userId);
  const openOrders = [...derivativeOrders.values()].filter(
    (o) =>
      (o.userId === userId || o.counterpartyId === userId) &&
      (o.status === "open" || o.status === "matched"),
  );
  const requiredXlm = Number(
    openOrders.reduce((sum, o) => sum + o.marginPerKwh * o.quantityKwh, 0).toFixed(4),
  );
  const maintenanceXlm = Number((requiredXlm * DERIVATIVE_MAINTENANCE_RATIO).toFixed(4));
  const equity = Number((account.balanceXlm - account.lockedXlm).toFixed(4));
  const healthy = equity >= maintenanceXlm;
  return {
    userId,
    balanceXlm: account.balanceXlm,
    lockedXlm: account.lockedXlm,
    requiredXlm,
    maintenanceXlm,
    healthy,
    shortfallXlm: healthy ? 0 : Number((maintenanceXlm - equity).toFixed(4)),
  };
}

/**
 * Liquidate an unhealthy account's open derivative positions.
 */
export function liquidateAccount(userId: string): DerivativeOrder[] {
  const check = checkLiquidation(userId);
  if (check.healthy) throw Object.assign(new Error("Account is healthy"), { code: "CONFLICT" });

  const liquidated: DerivativeOrder[] = [];
  for (const order of derivativeOrders.values()) {
    if (order.userId !== userId && order.counterpartyId !== userId) continue;
    if (order.status !== "open" && order.status !== "matched") continue;
    order.status = "liquidated";
    liquidated.push(order);
  }

  const account = getOrCreateMarginAccount(userId);
  account.lockedXlm = 0;
  account.updatedAt = new Date().toISOString();
  return liquidated;
}

export function getDerivativeStats(): {
  openOrders: number;
  matchedOrders: number;
  settledOrders: number;
  totalNotionalXlm: number;
} {
  let openOrders = 0;
  let matchedOrders = 0;
  let settledOrders = 0;
  let totalNotionalXlm = 0;
  for (const o of derivativeOrders.values()) {
    if (o.status === "open") openOrders++;
    else if (o.status === "matched") matchedOrders++;
    else if (o.status === "settled") settledOrders++;
    if (o.status === "open" || o.status === "matched" || o.status === "settled") {
      totalNotionalXlm += o.strikePrice * o.quantityKwh;
    }
  }
  return {
    openOrders,
    matchedOrders,
    settledOrders,
    totalNotionalXlm: Number(totalNotionalXlm.toFixed(4)),
  };
}
