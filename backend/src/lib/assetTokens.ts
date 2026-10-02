/**
 * Energy asset tokenization (#936).
 *
 * An asset (e.g. a solar array) is tokenized into a fixed supply of fractional
 * tokens. Holders receive revenue pro-rata, can trade tokens on a secondary
 * market (fixed-price listings), and the asset valuation is refreshed quarterly.
 * State is held in memory; on-chain settlement is out of scope for this module.
 */
import crypto from "node:crypto";

export type Asset = {
  id: string;
  name: string;
  totalSupply: number;
  valuation: number;
  valuedAt: string;
  balances: Record<string, number>;
  dividendPerToken: number;
  claimed: Record<string, number>;
  valuations: { value: number; at: string }[];
};
export type Listing = { id: string; assetId: string; seller: string; amount: number; pricePerToken: number };

const QUARTER_MS = 91 * 24 * 3600 * 1000;
const assets = new Map<string, Asset>();
const listings = new Map<string, Listing>();
/** Accrued-but-unclaimed dividends checkpointed at each balance change. */
const accrued = new Map<string, number>();
const key = (assetId: string, holder: string) => `${assetId}:${holder}`;

function must(assetId: string): Asset {
  const a = assets.get(assetId);
  if (!a) throw new Error("Asset not found");
  return a;
}

function checkpoint(a: Asset, holder: string): void {
  const owed = (a.balances[holder] ?? 0) * (a.dividendPerToken - (a.claimed[holder] ?? 0));
  accrued.set(key(a.id, holder), (accrued.get(key(a.id, holder)) ?? 0) + owed);
  a.claimed[holder] = a.dividendPerToken;
}

/** Tokenize an asset; the whole supply is minted to the owner. */
export function tokenizeAsset(name: string, owner: string, totalSupply: number, valuation: number): Asset {
  if (!Number.isInteger(totalSupply) || totalSupply <= 0) throw new Error("totalSupply must be a positive integer");
  if (!(valuation > 0)) throw new Error("valuation must be positive");
  const now = new Date().toISOString();
  const asset: Asset = {
    id: crypto.randomUUID(),
    name,
    totalSupply,
    valuation,
    valuedAt: now,
    balances: { [owner]: totalSupply },
    dividendPerToken: 0,
    claimed: { [owner]: 0 },
    valuations: [{ value: valuation, at: now }],
  };
  assets.set(asset.id, asset);
  return asset;
}

export function getAsset(id: string): Asset | undefined {
  return assets.get(id);
}

export function listAssets(): Asset[] {
  return [...assets.values()];
}

export function transferTokens(assetId: string, from: string, to: string, amount: number): void {
  const a = must(assetId);
  if (!Number.isInteger(amount) || amount <= 0) throw new Error("amount must be a positive integer");
  if ((a.balances[from] ?? 0) < amount) throw new Error("Insufficient token balance");
  checkpoint(a, from);
  checkpoint(a, to);
  a.balances[from] -= amount;
  a.balances[to] = (a.balances[to] ?? 0) + amount;
}

/** Distribute revenue to all current holders pro-rata to their token share. */
export function distributeRevenue(assetId: string, revenue: number): number {
  const a = must(assetId);
  if (!(revenue > 0)) throw new Error("revenue must be positive");
  a.dividendPerToken += revenue / a.totalSupply;
  return a.dividendPerToken;
}

export function pendingDividend(assetId: string, holder: string): number {
  const a = must(assetId);
  const live = (a.balances[holder] ?? 0) * (a.dividendPerToken - (a.claimed[holder] ?? 0));
  return Number(((accrued.get(key(assetId, holder)) ?? 0) + live).toFixed(7));
}

export function claimDividend(assetId: string, holder: string): number {
  const a = must(assetId);
  checkpoint(a, holder);
  const amount = accrued.get(key(assetId, holder)) ?? 0;
  accrued.set(key(assetId, holder), 0);
  return Number(amount.toFixed(7));
}

export function createListing(assetId: string, seller: string, amount: number, pricePerToken: number): Listing {
  const a = must(assetId);
  if (!Number.isInteger(amount) || amount <= 0 || !(pricePerToken > 0)) throw new Error("Invalid listing");
  const alreadyListed = [...listings.values()]
    .filter((l) => l.assetId === assetId && l.seller === seller)
    .reduce((s, l) => s + l.amount, 0);
  if ((a.balances[seller] ?? 0) < alreadyListed + amount) throw new Error("Insufficient token balance");
  const listing = { id: crypto.randomUUID(), assetId, seller, amount, pricePerToken };
  listings.set(listing.id, listing);
  return listing;
}

export function listListings(assetId?: string): Listing[] {
  return [...listings.values()].filter((l) => !assetId || l.assetId === assetId);
}

export function cancelListing(id: string, seller: string): boolean {
  const l = listings.get(id);
  if (!l || l.seller !== seller) return false;
  return listings.delete(id);
}

/** Buy tokens from a listing (partial fills allowed). Returns the total price. */
export function buyListing(id: string, buyer: string, amount: number): number {
  const l = listings.get(id);
  if (!l) throw new Error("Listing not found");
  if (!Number.isInteger(amount) || amount <= 0 || amount > l.amount) throw new Error("Invalid amount");
  transferTokens(l.assetId, l.seller, buyer, amount);
  l.amount -= amount;
  if (l.amount === 0) listings.delete(id);
  return Number((amount * l.pricePerToken).toFixed(7));
}

/** Record a new valuation; enforces the quarterly cadence unless force is set. */
export function updateValuation(assetId: string, value: number, force = false): Asset {
  const a = must(assetId);
  if (!(value > 0)) throw new Error("valuation must be positive");
  if (!force && Date.now() - new Date(a.valuedAt).getTime() < QUARTER_MS) {
    throw new Error("Valuation was updated less than a quarter ago");
  }
  a.valuation = value;
  a.valuedAt = new Date().toISOString();
  a.valuations.push({ value, at: a.valuedAt });
  return a;
}

/** Assets whose valuation is due for the quarterly refresh. */
export function assetsDueForValuation(now = Date.now()): Asset[] {
  return [...assets.values()].filter((a) => now - new Date(a.valuedAt).getTime() >= QUARTER_MS);
}

export function tokenPrice(a: Asset): number {
  return a.valuation / a.totalSupply;
}
