import * as StellarSdk from "@stellar/stellar-sdk";
import { contractInvoke, client } from "@/lib/contract";

export async function enableAutoTopup(sourceAddress: string, meterId: string, thresholdStroops: bigint, amountStroops: bigint): Promise<string> {
  return contractInvoke(sourceAddress, "enable_auto_topup", [StellarSdk.nativeToScVal(meterId, { type: "symbol" }), StellarSdk.nativeToScVal(thresholdStroops, { type: "i128" }), StellarSdk.nativeToScVal(amountStroops, { type: "i128" })]);
}
export async function disableAutoTopup(sourceAddress: string, meterId: string): Promise<string> {
  return contractInvoke(sourceAddress, "disable_auto_topup", [StellarSdk.nativeToScVal(meterId, { type: "symbol" })]);
}
export async function getAutoTopup(meterId: string): Promise<{ owner: string; threshold: bigint; amount: bigint; enabled: boolean } | null> {
  const result = await client.query("get_auto_topup", [StellarSdk.nativeToScVal(meterId, { type: "symbol" })]);
  const value = StellarSdk.scValToNative(result) as { owner: string; threshold: bigint; amount: bigint; enabled: boolean } | null;
  return value ?? null;
}
