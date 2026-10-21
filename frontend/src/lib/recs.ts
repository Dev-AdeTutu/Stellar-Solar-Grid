/**
 * Client for the REC marketplace API (#927).
 */
import { env } from "@/lib/env";

const API = `${env.NEXT_PUBLIC_BACKEND_URL}/api/recs`;

/** Micro-units per settlement-asset unit; one REC is priced per unit. */
export const REC_PRICE_SCALE = 1_000_000;
/** One REC unit represents 1 MWh of verified generation. */
export const KWH_PER_REC_UNIT = 1_000;

export type RecCompliance = "pending" | "verified" | "rejected";
export type RecSide = "sell" | "buy";

export type Rec = {
  id: string;
  producerId: string;
  meterId: string;
  kwhGenerated: number;
  vintage: number;
  registryRef: string;
  totalUnits: number;
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
  priceMicro: number;
  status: "open" | "filled" | "cancelled";
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
  consideration: number;
  fee: number;
  proceeds: number;
  settledAt: string;
};

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

export type RecMarket = {
  recs: RecMarketSummary[];
  totalIssuedUnits: number;
  totalTradedUnits: number;
  totalTradedValue: number;
  verifiedRecs: number;
  pendingRecs: number;
  rejectedRecs: number;
};

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(await errorOf(res));
  return (await res.json()) as T;
}

async function errorOf(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return body.error ?? `Request failed (HTTP ${res.status})`;
}

export function fetchMarket(): Promise<RecMarket> {
  return getJson<RecMarket>(`${API}/market`);
}

export async function fetchRecs(): Promise<Rec[]> {
  return (await getJson<{ recs: Rec[] }>(`${API}/`)).recs;
}

export function fetchOrders(recId: string, side: RecSide): Promise<RecOrder[]> {
  return getJson<{ orders: RecOrder[] }>(`${API}/${encodeURIComponent(recId)}/orders?side=${side}`).then(
    (body) => body.orders,
  );
}

export async function fetchTrades(recId: string): Promise<RecTrade[]> {
  return (await getJson<{ trades: RecTrade[] }>(`${API}/${encodeURIComponent(recId)}/trades`)).trades;
}

export async function listSell(recId: string, body: { ownerId: string; units: number; priceMicro: number }) {
  const res = await fetch(`${API}/${encodeURIComponent(recId)}/list`, json(body));
  if (!res.ok) throw new Error(await errorOf(res));
  return (await res.json()) as RecOrder;
}

export async function submitBid(recId: string, body: { ownerId: string; units: number; priceMicro: number }) {
  const res = await fetch(`${API}/${encodeURIComponent(recId)}/bid`, json(body));
  if (!res.ok) throw new Error(await errorOf(res));
  return (await res.json()) as RecOrder;
}

export async function executeTrade(orderId: string, buyerId: string): Promise<RecTrade[]> {
  const res = await fetch(`${API}/orders/${encodeURIComponent(orderId)}/execute`, json({ buyerId }));
  if (!res.ok) throw new Error(await errorOf(res));
  return (await res.json() as { trades: RecTrade[] }).trades;
}

export async function cancelOrder(orderId: string, requesterId: string) {
  const res = await fetch(`${API}/orders/${encodeURIComponent(orderId)}/cancel`, json({ requesterId }));
  if (!res.ok) throw new Error(await errorOf(res));
  return (await res.json()) as RecOrder;
}

export async function verifyRec(recId: string, complianceRef: string) {
  const res = await fetch(`${API}/${encodeURIComponent(recId)}/verify`, json({ complianceRef }));
  if (!res.ok) throw new Error(await errorOf(res));
  return (await res.json()) as Rec;
}

function json(body: unknown): RequestInit {
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

/** Convert a micro-denominated price to settlement-asset units per REC. */
export function priceToUnits(priceMicro: number | null | undefined): string {
  if (priceMicro == null) return "—";
  return (priceMicro / REC_PRICE_SCALE).toFixed(3);
}

export const COMPLIANCE_BADGE: Record<RecCompliance, string> = {
  pending: "bg-yellow-900/40 text-yellow-300",
  verified: "bg-green-900/40 text-green-300",
  rejected: "bg-red-900/40 text-red-300",
};