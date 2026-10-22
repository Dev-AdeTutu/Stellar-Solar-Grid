/**
 * Carbon credit tracking (#878).
 *
 * 1 carbon credit = offsetting 1 tonne of CO2.
 * Renewable solar generation offsets ~0.5 kg CO2/kWh (grid average).
 * So 1 credit is issued per 2000 kWh generated.
 */

export type CreditStatus = "issued" | "retired" | "listed" | "sold";

export type VerificationStatus = "unverified" | "pending" | "verified" | "rejected";

export type CarbonCredit = {
  id: string;
  ownerId: string;
  kwhProduced: number;
  creditsIssued: number;
  vintage: string;
  registryRef: string;
  status: CreditStatus;
  issuedAt: string;
  retiredAt: string | null;
  meterId: string | null;
  auditTrail: AuditEntry[];
  /** On-chain token id once the credit has been tokenized (fungible token). */
  tokenId: string | null;
  tokenized: boolean;
  verificationStatus: VerificationStatus;
  verifiedBy: string | null;
  verifiedAt: string | null;
  certificationRef: string | null;
  certifiedBy: string | null;
  certifiedAt: string | null;
};

export type AuditEntry = {
  action: string;
  actor: string;
  timestamp: string;
  detail?: string;
};

export type MarketListing = {
  creditId: string;
  sellerId: string;
  pricePerCredit: number;
  quantity: number;
  listedAt: string;
};

// kg CO2 offset per kWh of renewable generation (IPCC grid average)
export const KG_CO2_PER_KWH = 0.5;
export const KWH_PER_CREDIT = 2000; // 1 credit = 1 tonne = 2000 kWh × 0.5 kg

const credits = new Map<string, CarbonCredit>();
const listings = new Map<string, MarketListing>();

let idSeq = 1;
function nextId(prefix: string): string {
  return `${prefix}-${Date.now()}-${idSeq++}`;
}

export function calculateCredits(kwhProduced: number): number {
  return Number((kwhProduced / KWH_PER_CREDIT).toFixed(6));
}

export function issueCredit(params: {
  ownerId: string;
  kwhProduced: number;
  meterId?: string;
  vintage?: string;
}): CarbonCredit {
  const id = nextId("CC");
  const creditsIssued = calculateCredits(params.kwhProduced);
  const now = new Date().toISOString();
  const credit: CarbonCredit = {
    id,
    ownerId: params.ownerId,
    kwhProduced: params.kwhProduced,
    creditsIssued,
    vintage: params.vintage ?? new Date().getFullYear().toString(),
    registryRef: `SSG-${id}`,
    status: "issued",
    issuedAt: now,
    retiredAt: null,
    meterId: params.meterId ?? null,
    auditTrail: [
      {
        action: "issued",
        actor: params.ownerId,
        timestamp: now,
        detail: `${creditsIssued.toFixed(4)} credits for ${params.kwhProduced} kWh`,
      },
    ],
    tokenId: null,
    tokenized: false,
    verificationStatus: "unverified",
    verifiedBy: null,
    verifiedAt: null,
    certificationRef: null,
    certifiedBy: null,
    certifiedAt: null,
  };
  credits.set(id, credit);
  return credit;
}

// ── Tokenization (#1043) ─────────────────────────────────────────────────────

let tokenSeq = 1;

/**
 * Tokenize a credit as a fungible token. Only verified credits may be
 * tokenized so that marketplace buyers can trust the underlying asset.
 */
export function tokenizeCredit(creditId: string, actor: string): CarbonCredit {
  const credit = credits.get(creditId);
  if (!credit) throw Object.assign(new Error("Credit not found"), { code: "NOT_FOUND" });
  if (credit.tokenized) throw Object.assign(new Error("Credit already tokenized"), { code: "CONFLICT" });
  if (credit.verificationStatus !== "verified") {
    throw Object.assign(new Error("Credit must be verified before tokenization"), { code: "CONFLICT" });
  }
  const now = new Date().toISOString();
  credit.tokenId = `CCT-${tokenSeq++}`;
  credit.tokenized = true;
  credit.auditTrail.push({
    action: "tokenized",
    actor,
    timestamp: now,
    detail: `Token ${credit.tokenId} minted for ${credit.creditsIssued.toFixed(4)} credits`,
  });
  return credit;
}

// ── Verification and certification (#1043) ───────────────────────────────────

/** Submit a credit for third-party verification. */
export function submitForVerification(creditId: string, actor: string): CarbonCredit {
  const credit = credits.get(creditId);
  if (!credit) throw Object.assign(new Error("Credit not found"), { code: "NOT_FOUND" });
  if (credit.verificationStatus === "verified") {
    throw Object.assign(new Error("Credit already verified"), { code: "CONFLICT" });
  }
  const now = new Date().toISOString();
  credit.verificationStatus = "pending";
  credit.auditTrail.push({ action: "verification_requested", actor, timestamp: now });
  return credit;
}

/** A verifier attests (or rejects) the generation data behind a credit. */
export function verifyCredit(creditId: string, verifier: string, approved = true): CarbonCredit {
  const credit = credits.get(creditId);
  if (!credit) throw Object.assign(new Error("Credit not found"), { code: "NOT_FOUND" });
  if (credit.verificationStatus === "verified") {
    throw Object.assign(new Error("Credit already verified"), { code: "CONFLICT" });
  }
  const now = new Date().toISOString();
  credit.verificationStatus = approved ? "verified" : "rejected";
  credit.verifiedBy = verifier;
  credit.verifiedAt = now;
  credit.auditTrail.push({
    action: approved ? "verified" : "verification_rejected",
    actor: verifier,
    timestamp: now,
  });
  return credit;
}

/** Issue a certification reference for a verified credit. */
export function certifyCredit(creditId: string, certifier: string, certificationRef?: string): CarbonCredit {
  const credit = credits.get(creditId);
  if (!credit) throw Object.assign(new Error("Credit not found"), { code: "NOT_FOUND" });
  if (credit.verificationStatus !== "verified") {
    throw Object.assign(new Error("Credit must be verified before certification"), { code: "CONFLICT" });
  }
  if (credit.certificationRef) {
    throw Object.assign(new Error("Credit already certified"), { code: "CONFLICT" });
  }
  const now = new Date().toISOString();
  credit.certificationRef = certificationRef ?? `CERT-${credit.id}`;
  credit.certifiedBy = certifier;
  credit.certifiedAt = now;
  credit.auditTrail.push({
    action: "certified",
    actor: certifier,
    timestamp: now,
    detail: credit.certificationRef,
  });
  return credit;
}

// ── Automated issuance from solar generation (#1043) ─────────────────────────

/** Per-meter cumulative kWh tracking used for automated issuance. */
const meterTotals = new Map<string, number>();

/**
 * Record solar generation for a meter and automatically issue a credit once
 * enough kWh have accumulated to mint at least one whole credit.
 * Returns the newly issued credit, or null if the threshold was not reached.
 */
export function issueFromGeneration(params: {
  ownerId: string;
  meterId: string;
  kwhProduced: number;
  vintage?: string;
}): CarbonCredit | null {
  if (params.kwhProduced <= 0) {
    throw Object.assign(new Error("kWh produced must be positive"), { code: "VALIDATION_ERROR" });
  }
  const total = (meterTotals.get(params.meterId) ?? 0) + params.kwhProduced;
  meterTotals.set(params.meterId, total);
  if (total < KWH_PER_CREDIT) return null;

  // Consume the accumulated kWh that map to whole credits; keep the remainder.
  const wholeCredits = Math.floor(total / KWH_PER_CREDIT);
  const consumedKwh = wholeCredits * KWH_PER_CREDIT;
  meterTotals.set(params.meterId, total - consumedKwh);

  return issueCredit({
    ownerId: params.ownerId,
    kwhProduced: consumedKwh,
    meterId: params.meterId,
    vintage: params.vintage,
  });
}

export function getMeterAccumulatedKwh(meterId: string): number {
  return meterTotals.get(meterId) ?? 0;
}

export function retireCredit(creditId: string, actor: string): CarbonCredit {
  const credit = credits.get(creditId);
  if (!credit) throw Object.assign(new Error("Credit not found"), { code: "NOT_FOUND" });
  if (credit.status === "retired") throw Object.assign(new Error("Credit already retired"), { code: "CONFLICT" });

  const now = new Date().toISOString();
  credit.status = "retired";
  credit.retiredAt = now;
  credit.auditTrail.push({ action: "retired", actor, timestamp: now });
  listings.delete(creditId);
  return credit;
}

export function listForSale(creditId: string, sellerId: string, pricePerCredit: number, quantity: number): MarketListing {
  const credit = credits.get(creditId);
  if (!credit) throw Object.assign(new Error("Credit not found"), { code: "NOT_FOUND" });
  if (credit.ownerId !== sellerId) throw Object.assign(new Error("Not the owner"), { code: "FORBIDDEN" });
  if (credit.status === "retired") throw Object.assign(new Error("Retired credits cannot be listed"), { code: "CONFLICT" });
  if (quantity > credit.creditsIssued) throw Object.assign(new Error("Quantity exceeds available credits"), { code: "VALIDATION_ERROR" });

  const listing: MarketListing = {
    creditId,
    sellerId,
    pricePerCredit,
    quantity,
    listedAt: new Date().toISOString(),
  };
  credit.status = "listed";
  credit.auditTrail.push({
    action: "listed",
    actor: sellerId,
    timestamp: listing.listedAt,
    detail: `${quantity} credits at ${pricePerCredit} XLM each`,
  });
  listings.set(creditId, listing);
  return listing;
}

export function purchaseCredit(creditId: string, buyerId: string): CarbonCredit {
  const listing = listings.get(creditId);
  if (!listing) throw Object.assign(new Error("Listing not found"), { code: "NOT_FOUND" });

  const credit = credits.get(creditId);
  if (!credit) throw Object.assign(new Error("Credit not found"), { code: "NOT_FOUND" });

  const now = new Date().toISOString();
  const prevOwner = credit.ownerId;
  credit.ownerId = buyerId;
  credit.status = "sold";
  credit.auditTrail.push({
    action: "sold",
    actor: buyerId,
    timestamp: now,
    detail: `Purchased from ${prevOwner} at ${listing.pricePerCredit} XLM`,
  });
  listings.delete(creditId);
  return credit;
}

export function getCredit(creditId: string): CarbonCredit | undefined {
  return credits.get(creditId);
}

export function listCreditsByOwner(ownerId: string): CarbonCredit[] {
  return [...credits.values()].filter((c) => c.ownerId === ownerId);
}

export function getMarketListings(): MarketListing[] {
  return [...listings.values()];
}

// ── Order book and price discovery (#1043) ───────────────────────────────────

export type OrderSide = "bid" | "ask";

export type Order = {
  id: string;
  side: OrderSide;
  traderId: string;
  pricePerCredit: number;
  quantity: number;
  remaining: number;
  createdAt: string;
};

export type Trade = {
  id: string;
  bidId: string;
  askId: string;
  buyerId: string;
  sellerId: string;
  pricePerCredit: number;
  quantity: number;
  executedAt: string;
};

const bids: Order[] = [];
const asks: Order[] = [];
const trades: Trade[] = [];

let orderSeq = 1;
let tradeSeq = 1;

function insertSorted(book: Order[], order: Order): void {
  book.push(order);
  book.sort((a, b) => (order.side === "bid" ? b.pricePerCredit - a.pricePerCredit : a.pricePerCredit - b.pricePerCredit));
}

/** Place a limit order and attempt to match it against the opposite book. */
export function placeOrder(params: {
  side: OrderSide;
  traderId: string;
  pricePerCredit: number;
  quantity: number;
}): { order: Order; trades: Trade[] } {
  if (params.pricePerCredit <= 0) {
    throw Object.assign(new Error("Price must be positive"), { code: "VALIDATION_ERROR" });
  }
  if (params.quantity <= 0) {
    throw Object.assign(new Error("Quantity must be positive"), { code: "VALIDATION_ERROR" });
  }
  const order: Order = {
    id: `ORD-${orderSeq++}`,
    side: params.side,
    traderId: params.traderId,
    pricePerCredit: params.pricePerCredit,
    quantity: params.quantity,
    remaining: params.quantity,
    createdAt: new Date().toISOString(),
  };
  const book = order.side === "bid" ? bids : asks;
  insertSorted(book, order);
  const executed = matchOrders();
  return { order, trades: executed };
}

function matchOrders(): Trade[] {
  const executed: Trade[] = [];
  while (bids.length > 0 && asks.length > 0) {
    const bestBid = bids[0];
    const bestAsk = asks[0];
    if (bestBid.pricePerCredit < bestAsk.pricePerCredit) break;

    const quantity = Math.min(bestBid.remaining, bestAsk.remaining);
    const price = bestAsk.pricePerCredit; // price-time priority: resting ask sets price
    const trade: Trade = {
      id: `TRD-${tradeSeq++}`,
      bidId: bestBid.id,
      askId: bestAsk.id,
      buyerId: bestBid.traderId,
      sellerId: bestAsk.traderId,
      pricePerCredit: price,
      quantity,
      executedAt: new Date().toISOString(),
    };
    trades.push(trade);
    executed.push(trade);

    bestBid.remaining -= quantity;
    bestAsk.remaining -= quantity;
    if (bestBid.remaining === 0) bids.shift();
    if (bestAsk.remaining === 0) asks.shift();
  }
  return executed;
}

export function getOrderBook(): { bids: Order[]; asks: Order[] } {
  return {
    bids: bids.map((o) => ({ ...o })),
    asks: asks.map((o) => ({ ...o })),
  };
}

export function getTrades(): Trade[] {
  return trades.map((t) => ({ ...t }));
}

/**
 * Volume-weighted index price across all executed trades.
 * Returns null when no trades have occurred yet.
 */
export function getIndexPrice(): number | null {
  if (trades.length === 0) return null;
  let notional = 0;
  let volume = 0;
  for (const t of trades) {
    notional += t.pricePerCredit * t.quantity;
    volume += t.quantity;
  }
  if (volume === 0) return null;
  return Number((notional / volume).toFixed(6));
}

export function getCreditStats(): {
  totalIssued: number;
  totalRetired: number;
  totalListed: number;
  totalCreditValue: number;
} {
  let totalIssued = 0;
  let totalRetired = 0;
  let totalListed = 0;
  let totalCreditValue = 0;
  for (const c of credits.values()) {
    totalIssued += c.creditsIssued;
    if (c.status === "retired") totalRetired += c.creditsIssued;
    if (c.status === "listed") totalListed += c.creditsIssued;
  }
  for (const l of listings.values()) {
    totalCreditValue += l.pricePerCredit * l.quantity;
  }
  return { totalIssued, totalRetired, totalListed, totalCreditValue };
}

// ── Retirement registry, verification and annual reports (#934) ──────────────

export type RetirementRecord = {
  serial: number;
  creditId: string;
  ownerId: string;
  credits: number;
  co2Tonnes: number;
  vintage: string;
  registryRef: string;
  retiredAt: string;
  beneficiary: string | null;
  verifiedBy: string | null;
  verifiedAt: string | null;
};

// Append-only: records are never edited or removed, only verification fields are set once.
const registry: RetirementRecord[] = [];

/** Tonnes of CO2 offset by a quantity of credits (1 credit = 1 tonne). */
export function carbonImpactTonnes(credits: number): number {
  return Number(((credits * KWH_PER_CREDIT * KG_CO2_PER_KWH) / 1000).toFixed(6));
}

/** Retire a credit and record it permanently in the registry. */
export function retireAndRecord(creditId: string, actor: string, beneficiary?: string): RetirementRecord {
  const credit = retireCredit(creditId, actor);
  const record: RetirementRecord = {
    serial: registry.length + 1,
    creditId,
    ownerId: credit.ownerId,
    credits: credit.creditsIssued,
    co2Tonnes: carbonImpactTonnes(credit.creditsIssued),
    vintage: credit.vintage,
    registryRef: credit.registryRef,
    retiredAt: credit.retiredAt as string,
    beneficiary: beneficiary ?? null,
    verifiedBy: null,
    verifiedAt: null,
  };
  registry.push(record);
  return { ...record };
}

export function getRetirementRegistry(ownerId?: string): RetirementRecord[] {
  return registry.filter((r) => ownerId === undefined || r.ownerId === ownerId).map((r) => ({ ...r }));
}

export function getRetirement(serial: number): RetirementRecord | undefined {
  const r = registry[serial - 1];
  return r ? { ...r } : undefined;
}

/** Third-party verifier attests a retirement; each record can be verified once. */
export function verifyRetirement(serial: number, verifier: string): RetirementRecord {
  const record = registry[serial - 1];
  if (!record) throw Object.assign(new Error("Retirement not found"), { code: "NOT_FOUND" });
  if (record.verifiedBy) throw Object.assign(new Error("Retirement already verified"), { code: "CONFLICT" });
  record.verifiedBy = verifier;
  record.verifiedAt = new Date().toISOString();
  return { ...record };
}

export function annualSustainabilityReport(ownerId: string, year: number) {
  const rows = registry.filter((r) => r.ownerId === ownerId && new Date(r.retiredAt).getUTCFullYear() === year);
  return {
    ownerId,
    year,
    generatedAt: new Date().toISOString(),
    retirements: rows.length,
    verifiedRetirements: rows.filter((r) => r.verifiedBy).length,
    totalCredits: Number(rows.reduce((s, r) => s + r.credits, 0).toFixed(6)),
    totalCo2Tonnes: Number(rows.reduce((s, r) => s + r.co2Tonnes, 0).toFixed(6)),
    records: rows.map((r) => ({ ...r })),
  };
}
