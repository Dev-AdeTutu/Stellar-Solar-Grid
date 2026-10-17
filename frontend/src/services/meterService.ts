import { fetchMeter, fetchMetersByOwner, checkMeterAccess, fetchAllMeters, fetchMetersPaginated, transferMeterOwnership, fetchDelegates, addMeterDelegate, removeMeterDelegate, makeDelegatedPayment as contractMakeDelegatedPayment, contractInvoke, type MeterData, type Delegate } from "@/lib/contract";
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

import { env } from "@/lib/env";

export interface PowerQualityReading {
  voltage: number;
  frequency: number;
  thd: number;
  timestamp: string;
}

export interface PowerQualityResponse {
  meterId: string;
  current: PowerQualityReading | null;
  issues: any[];
  history: PowerQualityReading[];
  pagination?: any;
  thresholds?: any;
}

export async function getPowerQuality(
  meterId: string,
  days?: number,
): Promise<PowerQualityResponse> {
  const backendUrl = env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:3001";
  const url = `${backendUrl}/api/meters/${meterId}/power-quality${days ? `?days=${days}` : ""}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch power quality: ${res.statusText}`);
  }
  return res.json();
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

// Issue #981: Family/Household Account Sharing — delegation service helpers.

export async function getDelegates(meterId: string): Promise<Delegate[]> {
  return fetchDelegates(meterId);
}

export async function addDelegate(
  sourceAddress: string,
  meterId: string,
  delegate: string,
  permissions: "view" | "pay" | "admin",
  expiry: bigint,
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
): Promise<string>;
export async function makeDelegatedPayment(
  sourceAddress: string,
  meterId: string,
  amountXlm: number,
  plan: "Daily" | "Weekly" | "Monthly" | "Usage",
  memo?: string,
): Promise<string>;
export async function makeDelegatedPayment(
  sourceAddress: string,
  meterId: string,
  delegateOrAmount: string | number,
  amountOrPlan: number | ("Daily" | "Weekly" | "Monthly" | "Usage"),
  planOrMemo?: ("Daily" | "Weekly" | "Monthly" | "Usage") | string,
  memo?: string,
): Promise<string> {
  let delegate: string;
  let amountXlm: number;
  let plan: "Daily" | "Weekly" | "Monthly" | "Usage";
  let memoStr: string | undefined;

  if (typeof delegateOrAmount === "string") {
    delegate = delegateOrAmount;
    amountXlm = amountOrPlan as number;
    plan = planOrMemo as ("Daily" | "Weekly" | "Monthly" | "Usage");
    memoStr = memo;
  } else {
    delegate = sourceAddress;
    amountXlm = delegateOrAmount;
    plan = amountOrPlan as ("Daily" | "Weekly" | "Monthly" | "Usage");
    memoStr = planOrMemo as string | undefined;
  }
  const amountStroops = BigInt(Math.round(amountXlm * 10_000_000));
  return contractMakeDelegatedPayment(
    sourceAddress,
    meterId,
    delegate,
    amountStroops,
    plan,
    memoStr ?? "",
  );
}
