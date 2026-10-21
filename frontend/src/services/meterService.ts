import { fetchMeter, fetchMetersByOwner, checkMeterAccess, fetchAllMeters, fetchMetersPaginated, transferMeterOwnership, fetchDelegates, addDelegate as contractAddDelegate, removeDelegate as contractRemoveDelegate, makeDelegatedPayment as contractMakeDelegatedPayment, contractInvoke, contractQuery, type MeterData, type Delegate } from "@/lib/contract";
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

export type DelegatePermission = "view" | "pay" | "admin";

export async function getDelegates(meterId: string): Promise<Delegate[]> {
  return fetchDelegates(meterId);
}

export async function addDelegate(
  arg1: string,
  arg2: string,
  arg3: any,
  arg4?: any,
  arg5?: any,
): Promise<string> {
  if (arg5 !== undefined) {
    return contractAddDelegate(arg1, arg2, arg3, Array.isArray(arg4) ? arg4.join(",") : arg4, arg5);
  }
  return contractAddDelegate("", arg1, arg2, Array.isArray(arg3) ? arg3.join(",") : arg3, arg4 ?? 0);
}

export async function removeDelegate(
  arg1: string,
  arg2: string,
  arg3?: string,
): Promise<string> {
  if (arg3 !== undefined) {
    return contractRemoveDelegate(arg1, arg2, arg3);
  }
  return contractRemoveDelegate("", arg1, arg2);
}

export async function makeDelegatedPayment(
  sourceAddress: string,
  meterId: string,
  arg3: string | number,
  arg4: any,
  arg5?: any,
  arg6?: string,
): Promise<string> {
  let delegate: string;
  let amountXlm: number;
  let plan: "Daily" | "Weekly" | "Monthly" | "Usage";
  let memo: string | undefined;

  if (typeof arg3 === "number") {
    delegate = sourceAddress;
    amountXlm = arg3;
    plan = arg4 ?? "Daily";
    memo = arg5;
  } else {
    delegate = arg3;
    amountXlm = Number(arg4);
    plan = arg5 ?? "Daily";
    memo = arg6;
  }

  const amountStroops = BigInt(Math.round(amountXlm * 10_000_000));
  const trimmedMemo = memo?.trim();
  const memoScVal =
    trimmedMemo && trimmedMemo.length > 0
      ? StellarSdk.nativeToScVal(trimmedMemo, { type: "string" })
      : StellarSdk.xdr.ScVal.scvVoid();
  return contractMakeDelegatedPayment(
    sourceAddress,
    meterId,
    delegate,
    amountStroops,
    plan,
    memoScVal as any,
  );
}

// Issue #1048: Meter Circular Economy Tracking — lifecycle service helpers.

export type LifecycleEventType =
  | "Installation"
  | "Repair"
  | "Upgrade"
  | "Inspection"
  | "Transfer"
  | "Decommission";

export interface ManufacturingRecord {
  meterId: string;
  manufacturer: string;
  manufacturedAt: number;
  materials: string[];
  origin: string;
  metadata?: string;
}

export interface LifecycleEvent {
  meterId: string;
  eventType: LifecycleEventType;
  actor: string;
  timestamp: number;
  description: string;
  metadata?: string;
}

export interface RecyclingCertification {
  meterId: string;
  certifier: string;
  certifiedAt: number;
  recycledWeightGrams: number;
  certificateHash: string;
}

export interface MaterialRecovery {
  meterId: string;
  material: string;
  recoveredGrams: number;
  recoveryMethod: string;
  recordedAt: number;
}

export interface MeterLifecycle {
  meterId: string;
  manufacturing?: ManufacturingRecord;
  events: LifecycleEvent[];
  recycling?: RecyclingCertification;
  materialRecovery: MaterialRecovery[];
}

export interface CircularEconomyCompliance {
  meterId: string;
  compliant: boolean;
  manufacturingTracked: boolean;
  recyclingCertified: boolean;
  recoveryRecorded: boolean;
  issues: string[];
}

export async function recordManufacturing(
  sourceAddress: string,
  meterId: string,
  manufacturer: string,
  materials: string[],
  origin: string,
  metadata?: string,
): Promise<string> {
  const trimmedMetadata = metadata?.trim();
  const metadataScVal =
    trimmedMetadata && trimmedMetadata.length > 0
      ? StellarSdk.nativeToScVal(trimmedMetadata, { type: "string" })
      : StellarSdk.xdr.ScVal.scvVoid();
  return contractInvoke(sourceAddress, "record_manufacturing", [
    StellarSdk.nativeToScVal(meterId, { type: "symbol" }),
    StellarSdk.nativeToScVal(manufacturer, { type: "address" }),
    StellarSdk.nativeToScVal(materials, { type: "string" }),
    StellarSdk.nativeToScVal(origin, { type: "string" }),
    metadataScVal,
  ]);
}

export async function recordLifecycleEvent(
  sourceAddress: string,
  meterId: string,
  eventType: LifecycleEventType,
  description: string,
  metadata?: string,
): Promise<string> {
  const trimmedMetadata = metadata?.trim();
  const metadataScVal =
    trimmedMetadata && trimmedMetadata.length > 0
      ? StellarSdk.nativeToScVal(trimmedMetadata, { type: "string" })
      : StellarSdk.xdr.ScVal.scvVoid();
  return contractInvoke(sourceAddress, "record_lifecycle_event", [
    StellarSdk.nativeToScVal(meterId, { type: "symbol" }),
    StellarSdk.nativeToScVal(sourceAddress, { type: "address" }),
    StellarSdk.nativeToScVal(eventType, { type: "symbol" }),
    StellarSdk.nativeToScVal(description, { type: "string" }),
    metadataScVal,
  ]);
}

export async function certifyRecycling(
  sourceAddress: string,
  meterId: string,
  certifier: string,
  recycledWeightGrams: number,
  certificateHash: string,
): Promise<string> {
  return contractInvoke(sourceAddress, "certify_recycling", [
    StellarSdk.nativeToScVal(meterId, { type: "symbol" }),
    StellarSdk.nativeToScVal(certifier, { type: "address" }),
    StellarSdk.nativeToScVal(BigInt(Math.round(recycledWeightGrams)), { type: "i128" }),
    StellarSdk.nativeToScVal(certificateHash, { type: "string" }),
  ]);
}

export async function recordMaterialRecovery(
  sourceAddress: string,
  meterId: string,
  material: string,
  recoveredGrams: number,
  recoveryMethod: string,
): Promise<string> {
  return contractInvoke(sourceAddress, "record_material_recovery", [
    StellarSdk.nativeToScVal(meterId, { type: "symbol" }),
    StellarSdk.nativeToScVal(material, { type: "string" }),
    StellarSdk.nativeToScVal(BigInt(Math.round(recoveredGrams)), { type: "i128" }),
    StellarSdk.nativeToScVal(recoveryMethod, { type: "string" }),
  ]);
}

export async function getMeterLifecycle(meterId: string): Promise<MeterLifecycle> {
  return contractQuery<MeterLifecycle>("get_meter_lifecycle", [
    StellarSdk.nativeToScVal(meterId, { type: "symbol" }),
  ]);
}

export async function getLifecycleEvents(meterId: string): Promise<LifecycleEvent[]> {
  return contractQuery<LifecycleEvent[]>("get_lifecycle_events", [
    StellarSdk.nativeToScVal(meterId, { type: "symbol" }),
  ]);
}

export async function checkCircularEconomyCompliance(
  meterId: string,
): Promise<CircularEconomyCompliance> {
  return contractQuery<CircularEconomyCompliance>("check_circular_economy_compliance", [
    StellarSdk.nativeToScVal(meterId, { type: "symbol" }),
  ]);
}
