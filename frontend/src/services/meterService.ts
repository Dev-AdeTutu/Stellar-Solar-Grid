import { fetchMeter, fetchMetersByOwner, checkMeterAccess, fetchAllMeters, fetchMetersPaginated, transferMeterOwnership, contractInvoke, type MeterData } from "@/lib/contract";
import * as StellarSdk from "@stellar/stellar-sdk";

export type { MeterData };

export async function getMeter(meterId: string): Promise<MeterData> {
  return fetchMeter(meterId);
}

export async function getMetersByOwner(ownerAddress: string): Promise<string[]> {
  return fetchMetersByOwner(ownerAddress);
}

export async function checkAccess(meterId: string): Promise<boolean> {
  return checkMeterAccess(meterId);
}

export async function getAllMeters(): Promise<MeterData[]> {
  return fetchAllMeters();
}

export async function getMetersPaginated(offset: number, limit: number): Promise<string[]> {
  return fetchMetersPaginated(offset, limit);
}

export async function transferOwnership(
  sourceAddress: string,
  meterId: string,
  newOwnerAddress: string,
): Promise<string> {
  return transferMeterOwnership(sourceAddress, meterId, newOwnerAddress);
}

export async function makePayment(
  sourceAddress: string,
  meterId: string,
  amountXlm: number,
  plan: "Daily" | "Weekly" | "Monthly" | "Usage",
  memo?: string,
): Promise<string> {
  const amountStroops = BigInt(Math.round(amountXlm * 10_000_000));
  // Issue #766: memo is an Option<String> on the contract side — omit
  // (scvVoid) rather than passing an empty string when the user left it blank.
  const trimmedMemo = memo?.trim();
  const memoScVal =
    trimmedMemo && trimmedMemo.length > 0
      ? StellarSdk.nativeToScVal(trimmedMemo, { type: "string" })
      : StellarSdk.xdr.ScVal.scvVoid();
  return contractInvoke(sourceAddress, "make_payment", [
    StellarSdk.nativeToScVal(meterId, { type: "symbol" }),
    StellarSdk.nativeToScVal(sourceAddress, { type: "address" }),
    StellarSdk.nativeToScVal(amountStroops, { type: "i128" }),
    StellarSdk.nativeToScVal(plan, { type: "symbol" }),
    memoScVal,
  ]);
}
