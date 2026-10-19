/**
 * Carbon credit tracking (#878).
 *
 * 1 carbon credit = offsetting 1 tonne of CO2.
 * Renewable solar generation offsets ~0.5 kg CO2/kWh (grid average).
 * So 1 credit is issued per 2000 kWh generated.
 */

export type CreditStatus = "issued" | "retired" | "listed" | "sold";

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
  };
  credits.set(id, credit);
  return credit;
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
