import { fetchMeter, fetchMetersByOwner, checkMeterAccess, fetchAllMeters, fetchMetersPaginated, transferMeterOwnership, fetchDelegates, addMeterDelegate, removeMeterDelegate, makeDelegatedPayment, contractInvoke, type MeterData, type Delegate } from "@/lib/contract";
import * as StellarSdk from "@stellar/stellar-sdk";

export type { MeterData, Delegate };

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

export async function getPowerQuality(
  meterId: string,
  days?: number,
): Promise<PowerQualityResponse> {
  return getMeterPowerQuality(meterId, days);
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

export async function publishAlgorithm(creator: string, name: string, feeXlm: number): Promise<string> {
  return contractInvoke(creator, "publish_algorithm", [
    new StellarSdk.Address(creator).toScVal(),
    StellarSdk.nativeToScVal(name, { type: "string" }),
    StellarSdk.nativeToScVal(BigInt(Math.round(feeXlm * 10_000_000)), { type: "i128" }),
  ]);
}

export async function subscribeAlgorithm(user: string, algoId: number): Promise<string> {
  return contractInvoke(user, "subscribe_algorithm", [
    new StellarSdk.Address(user).toScVal(),
    StellarSdk.nativeToScVal(algoId, { type: "u32" }),
  ]);
// Issue #981: Family/Household Account Sharing — delegation service helpers.

export async function getDelegates(meterId: string): Promise<Delegate[]> {
  return fetchDelegates(meterId);
}

export async function addDelegate(
  sourceAddress: string,
  meterId: string,
  delegate: string,
  permissions: string,
  expiry: number,
): Promise<string> {
  return addMeterDelegate(sourceAddress, meterId, delegate, permissions, expiry);
}

export async function removeDelegate(
  sourceAddress: string,
  meterId: string,
  delegate: string,
): Promise<string> {
  return removeMeterDelegate(sourceAddress, meterId, delegate);
}

export async function makeDelegatedPayment(
  sourceAddress: string,
  meterId: string,
  delegate: string,
  amountXlm: number,
  plan: "Daily" | "Weekly" | "Monthly" | "Usage",
  memo?: string,
): Promise<string> {
  const amountStroops = BigInt(Math.round(amountXlm * 10_000_000));
  const trimmedMemo = memo?.trim();
  const memoScVal =
    trimmedMemo && trimmedMemo.length > 0
      ? StellarSdk.nativeToScVal(trimmedMemo, { type: "string" })
      : StellarSdk.xdr.ScVal.scvVoid();
  return makeDelegatedPayment(
    sourceAddress,
    meterId,
    delegate,
    amountStroops,
    plan,
    memoScVal,
  );
}
