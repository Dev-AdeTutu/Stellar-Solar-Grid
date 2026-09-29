/**
 * On-chain meter lookups shared by competitions (#903) and smart-home
 * control (#904). The Stellar service is imported lazily so modules that
 * use these helpers can be loaded without contract env vars being set.
 */
import * as StellarSdk from "@stellar/stellar-sdk";

export type OnChainMeter = { owner: string; active: boolean; balance: number };

export async function getOnChainMeter(meterId: string): Promise<OnChainMeter | null> {
  const { stellarService } = await import("./stellar.js");
  const result = await stellarService.query("get_meter", [StellarSdk.nativeToScVal(meterId, { type: "symbol" })]);
  const meter = StellarSdk.scValToNative(result) as
    | { owner?: unknown; active?: boolean; balance?: bigint | number }
    | null;
  if (!meter) return null;
  return { owner: String(meter.owner), active: Boolean(meter.active), balance: Number(meter.balance ?? 0) };
}

/** True when `address` is the on-chain owner of `meterId` (skippable via METER_OWNERSHIP_CHECK=false). */
export async function ownsMeter(meterId: string, address: string): Promise<boolean> {
  if (process.env.METER_OWNERSHIP_CHECK === "false") return true;
  const meter = await getOnChainMeter(meterId);
  return !!meter && meter.owner === address;
}
