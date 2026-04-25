import { fetchMeter, fetchMetersByOwner, contractInvoke, type MeterData } from "@/lib/contract";
import * as StellarSdk from "@stellar/stellar-sdk";

export type { MeterData };

export async function getMeter(meterId: string): Promise<MeterData> {
  return fetchMeter(meterId);
}

export async function getMetersByOwner(ownerAddress: string): Promise<string[]> {
  return fetchMetersByOwner(ownerAddress);
}

export async function makePayment(
  sourceAddress: string,
  meterId: string,
  amountXlm: number,
  plan: "Daily" | "Weekly" | "Usage",
): Promise<string> {
  const amountStroops = BigInt(Math.round(amountXlm * 10_000_000));
  return contractInvoke(sourceAddress, "make_payment", [
    StellarSdk.nativeToScVal(meterId, { type: "symbol" }),
    StellarSdk.nativeToScVal(amountStroops, { type: "i128" }),
    StellarSdk.nativeToScVal({ [plan]: null }, { type: "map" }),
  ]);
}
