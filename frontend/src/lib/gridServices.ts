import * as StellarSdk from "@stellar/stellar-sdk";
import { env } from "@/lib/env";
import { contractInvoke } from "@/lib/contract";
const API = `${env.NEXT_PUBLIC_BACKEND_URL}/api/grid-services`;
async function request<T>(path: string, init?: RequestInit): Promise<T> { const res = await fetch(`${API}${path}`, { headers: { "Content-Type": "application/json" }, ...init }); if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `Request failed (${res.status})`); return res.json() as Promise<T>; }
export const recordFrequencyReading = (body: { meterId: string; frequencyHz: number; loadKw: number }) => request(`/frequency/readings`, { method: "POST", body: JSON.stringify(body) });
export const verifyMeterLocation = (body: { meterId: string; latitude: number; longitude: number }) => request(`/geofences/verify`, { method: "POST", body: JSON.stringify(body) });
export const fetchGeofences = () => request<{ geofences: Array<{ meterId: string; latitude: number; longitude: number; radiusMeters: number }> }>("/geofences");
const symbol = (value: string) => StellarSdk.nativeToScVal(value, { type: "symbol" });
const address = (value: string) => StellarSdk.nativeToScVal(value, { type: "address" });
const i128 = (value: bigint) => StellarSdk.nativeToScVal(value, { type: "i128" });
export function giftEnergyCredit(owner: string, senderMeterId: string, recipientMeterId: string, amount: bigint, message?: string) { const memo = message?.trim() ? StellarSdk.nativeToScVal(message.trim(), { type: "string" }) : StellarSdk.xdr.ScVal.scvVoid(); return contractInvoke(owner, "gift_energy_credit", [symbol(senderMeterId), symbol(recipientMeterId), i128(amount), memo]); }
export function subscribe(owner: string, tierId: number) { return contractInvoke(owner, "subscribe", [address(owner), StellarSdk.nativeToScVal(tierId, { type: "u32" })]); }
export function renewSubscription(owner: string) { return contractInvoke(owner, "renew_subscription", [address(owner)]); }
