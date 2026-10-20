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
  /** Island this offer is restricted to (island mode only). Null = grid-wide. */
  islandId: string | null;
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
  islandId?: string;
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
    islandId: params.islandId ?? null,
  };
  offers.set(id, offer);
  return offer;
}

// ---------------------------------------------------------------------------
// Island mode support (#1041)
//
// When the main grid is disconnected, meters form a self-sufficient island.
// P2P energy sharing is then restricted to meters within the same island and
// only allowed while both parties are operating in island mode.
// ---------------------------------------------------------------------------

export type IslandModeState = {
  islandId: string;
  active: boolean;
  members: Set<string>;
};

const islands = new Map<string, IslandModeState>();

function islandError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

/** Register (or update) an island and its member meters. */
export function registerIsland(islandId: string, memberMeterIds: string[] = []): IslandModeState {
  const existing = islands.get(islandId);
  const state: IslandModeState = existing ?? {
    islandId,
    active: false,
    members: new Set<string>(),
  };
  for (const meterId of memberMeterIds) state.members.add(meterId);
  islands.set(islandId, state);
  return state;
}

export function getIsland(islandId: string): IslandModeState | undefined {
  return islands.get(islandId);
}

/** Add a meter to an island. */
export function addMeterToIsland(islandId: string, meterId: string): IslandModeState {
  const state = islands.get(islandId) ?? registerIsland(islandId);
  state.members.add(meterId);
  return state;
}

/** Remove a meter from an island. */
export function removeMeterFromIsland(islandId: string, meterId: string): IslandModeState {
  const state = islands.get(islandId);
  if (!state) throw islandError("Island not found", "NOT_FOUND");
  state.members.delete(meterId);
  return state;
}

/** Enter island mode for the given island. */
export function enterIslandMode(islandId: string): IslandModeState {
  const state = islands.get(islandId) ?? registerIsland(islandId);
  state.active = true;
  return state;
}

/** Exit island mode (grid reconnected / resync). */
export function exitIslandMode(islandId: string): IslandModeState {
  const state = islands.get(islandId);
  if (!state) throw islandError("Island not found", "NOT_FOUND");
  state.active = false;
  return state;
}

export function isIslandActive(islandId: string): boolean {
  return islands.get(islandId)?.active === true;
}

export function isMeterInIsland(islandId: string, meterId: string): boolean {
  return islands.get(islandId)?.members.has(meterId) === true;
}

/**
 * Create an island-restricted P2P offer. Both the meter and the island must be
 * valid: the island must be active and the meter must belong to it.
 */
export function createIslandOffer(params: {
  userId: string;
  direction: TradeDirection;
  energyKwh: number;
  pricePerKwh: number;
  minKwh?: number;
  ttlMs?: number;
  meterId: string;
  location?: string;
  islandId: string;
}): TradeOffer {
  const state = islands.get(params.islandId);
  if (!state) throw islandError("Island not found", "NOT_FOUND");
  if (!state.active) throw islandError("Island is not in island mode", "CONFLICT");
  if (!state.members.has(params.meterId)) {
    throw islandError("Meter is not a member of this island", "FORBIDDEN");
  }
  return createOffer({ ...params, islandId: params.islandId });
}

/**
 * Validate that a sell and buy offer may trade with each other under island
 * rules. Grid-wide offers (islandId === null) are only allowed when neither
 * side is island-restricted.
 */
export function validateIslandTrade(sell: TradeOffer, buy: TradeOffer): void {
  if (sell.islandId === null && buy.islandId === null) return;

  if (sell.islandId !== buy.islandId) {
    throw islandError("Offers belong to different islands", "CONFLICT");
  }

  const islandId = sell.islandId as string;
  const state = islands.get(islandId);
  if (!state) throw islandError("Island not found", "NOT_FOUND");
  if (!state.active) throw islandError("Island is not in island mode", "CONFLICT");

  const sellMeter = sell.meterId;
  const buyMeter = buy.meterId;
  if (!sellMeter || !state.members.has(sellMeter)) {
    throw islandError("Seller meter is not a member of this island", "FORBIDDEN");
  }
  if (!buyMeter || !state.members.has(buyMeter)) {
    throw islandError("Buyer meter is not a member of this island", "FORBIDDEN");
  }
}

/** List open offers restricted to a given island. */
export function getIslandOffers(islandId: string, direction?: TradeDirection): TradeOffer[] {
  const now = new Date().toISOString();
  return [...offers.values()].filter(
    (o) =>
      o.islandId === islandId &&
      o.status === "open" &&
      o.expiresAt > now &&
      (direction === undefined || o.direction === direction),
  );
}

/** List matches that occurred within a given island. */
export function getIslandMatches(islandId: string): TradeMatch[] {
  return [...matches.values()].filter((m) => {
    const sell = offers.get(m.sellOfferId);
    const buy = offers.get(m.buyOfferId);
    return sell?.islandId === islandId || buy?.islandId === islandId;
  });
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
      // Island-restricted offers may only match within the same active island.
      if (sell.islandId !== null || buy.islandId !== null) {
        try {
          validateIslandTrade(sell, buy);
        } catch {
          continue;
        }
      }

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
