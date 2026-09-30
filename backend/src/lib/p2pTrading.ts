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
