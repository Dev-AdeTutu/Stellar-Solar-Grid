/**
 * On-chain meter lookups shared by competitions (#903) and smart-home
 * control (#904). The Stellar service is imported lazily so modules that
 * use these helpers can be loaded without contract env vars being set.
 *
 * Co-ownership support (#1061): meters can be owned by multiple addresses
 * with configurable shares. Helpers below fetch shareholders, validate
 * share totals, mutate shares on-chain, and compute proportional
 * cost/revenue splits used by routes.
 */
import * as StellarSdk from "@stellar/stellar-sdk";

export type OnChainMeter = { owner: string; active: boolean; balance: number };

export type Shareholder = { address: string; share: number };

export type CoOwnership = {
  meterId: string;
  shareholders: Shareholder[];
  /** Sum of all shareholder shares (expected to equal 1 for a fully-owned meter). */
  totalShare: number;
};

/** Tolerance used when validating that shares sum to 1 (floating point). */
const SHARE_EPSILON = 1e-9;

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

// ---------------------------------------------------------------------------
// Co-ownership helpers (#1061)
// ---------------------------------------------------------------------------

function meterIdScVal(meterId: string): StellarSdk.xdr.ScVal {
  return StellarSdk.nativeToScVal(meterId, { type: "symbol" });
}

function addressScVal(address: string): StellarSdk.xdr.ScVal {
  return StellarSdk.nativeToScVal(address, { type: "address" });
}

function shareScVal(share: number): StellarSdk.xdr.ScVal {
  // Shares are represented on-chain as i128 basis points (1 share = 10_000 bps).
  return StellarSdk.nativeToScVal(BigInt(Math.round(share * 10_000)), { type: "i128" });
}

function normalizeShareholders(raw: unknown): Shareholder[] {
  if (!raw) return [];
  const entries: Array<[unknown, unknown]> = Array.isArray(raw)
    ? (raw as Array<[unknown, unknown]>)
    : Object.entries(raw as Record<string, unknown>);
  return entries.map(([address, share]) => ({
    address: String(address),
    share: Number(share) / 10_000,
  }));
}

/**
 * Fetch the shareholders of a meter from the contract.
 * Returns an empty list when the meter has no co-ownership record.
 */
export async function getShareholders(meterId: string): Promise<Shareholder[]> {
  const { stellarService } = await import("./stellar.js");
  const result = await stellarService.query("get_shareholders", [meterIdScVal(meterId)]);
  return normalizeShareholders(StellarSdk.scValToNative(result));
}

/** Fetch full co-ownership state for a meter, including the total share. */
export async function getCoOwnership(meterId: string): Promise<CoOwnership> {
  const shareholders = await getShareholders(meterId);
  const totalShare = shareholders.reduce((sum, s) => sum + s.share, 0);
  return { meterId, shareholders, totalShare };
}

/** True when `address` holds any ownership share of `meterId`. */
export async function isShareholder(meterId: string, address: string): Promise<boolean> {
  if (process.env.METER_OWNERSHIP_CHECK === "false") return true;
  const shareholders = await getShareholders(meterId);
  return shareholders.some((s) => s.address === address && s.share > 0);
}

/** Return the ownership share (0..1) held by `address` for `meterId`. */
export async function getOwnershipShare(meterId: string, address: string): Promise<number> {
  const shareholders = await getShareholders(meterId);
  const entry = shareholders.find((s) => s.address === address);
  return entry ? entry.share : 0;
}

/**
 * Validate a proposed set of shareholders.
 * - Each share must be in (0, 1].
 * - No duplicate addresses.
 * - Shares must sum to 1 (within SHARE_EPSILON).
 */
export function validateShares(shareholders: Shareholder[]): { valid: boolean; error?: string } {
  if (!shareholders.length) return { valid: false, error: "no shareholders provided" };
  const seen = new Set<string>();
  let total = 0;
  for (const { address, share } of shareholders) {
    if (!address) return { valid: false, error: "shareholder address is required" };
    if (seen.has(address)) return { valid: false, error: `duplicate shareholder: ${address}` };
    seen.add(address);
    if (!Number.isFinite(share) || share <= 0 || share > 1) {
      return { valid: false, error: `invalid share for ${address}: ${share}` };
    }
    total += share;
  }
  if (Math.abs(total - 1) > SHARE_EPSILON) {
    return { valid: false, error: `shares must sum to 1 (got ${total})` };
  }
  return { valid: true };
}

/**
 * Add a new shareholder to a meter. The caller is responsible for ensuring
 * the resulting share set still sums to 1 (e.g. by reducing existing shares).
 */
export async function addShareholder(meterId: string, address: string, share: number): Promise<void> {
  if (!Number.isFinite(share) || share <= 0 || share > 1) {
    throw new Error(`invalid share: ${share}`);
  }
  const { stellarService } = await import("./stellar.js");
  await stellarService.invoke("add_shareholder", [meterIdScVal(meterId), addressScVal(address), shareScVal(share)]);
}

/** Update the share held by an existing shareholder. */
export async function updateShare(meterId: string, address: string, share: number): Promise<void> {
  if (!Number.isFinite(share) || share < 0 || share > 1) {
    throw new Error(`invalid share: ${share}`);
  }
  const { stellarService } = await import("./stellar.js");
  await stellarService.invoke("update_share", [meterIdScVal(meterId), addressScVal(address), shareScVal(share)]);
}

/** Transfer `share` of ownership from `from` to `to`. */
export async function transferShare(
  meterId: string,
  from: string,
  to: string,
  share: number,
): Promise<void> {
  if (!from || !to) throw new Error("from and to addresses are required");
  if (from === to) throw new Error("cannot transfer shares to self");
  if (!Number.isFinite(share) || share <= 0 || share > 1) {
    throw new Error(`invalid share: ${share}`);
  }
  const { stellarService } = await import("./stellar.js");
  await stellarService.invoke("transfer_share", [
    meterIdScVal(meterId),
    addressScVal(from),
    addressScVal(to),
    shareScVal(share),
  ]);
}

/** Remove a shareholder entirely (their share must be redistributed first). */
export async function removeShareholder(meterId: string, address: string): Promise<void> {
  const { stellarService } = await import("./stellar.js");
  await stellarService.invoke("remove_shareholder", [meterIdScVal(meterId), addressScVal(address)]);
}

/**
 * Split `amount` proportionally across shareholders.
 * Returns a map of address -> amount. Remainder from rounding is assigned to
 * the largest shareholder so the sum always equals `amount`.
 */
export function splitProportionally(shareholders: Shareholder[], amount: number): Record<string, number> {
  const result: Record<string, number> = {};
  if (!shareholders.length || !Number.isFinite(amount) || amount === 0) return result;

  const total = shareholders.reduce((sum, s) => sum + s.share, 0);
  if (total <= 0) return result;

  let allocated = 0;
  let largest: Shareholder | null = null;
  for (const s of shareholders) {
    const portion = (amount * s.share) / total;
    result[s.address] = portion;
    allocated += portion;
    if (!largest || s.share > largest.share) largest = s;
  }

  // Correct floating point drift on the largest holder.
  if (largest) {
    const drift = amount - allocated;
    if (Math.abs(drift) > 0) result[largest.address] += drift;
  }
  return result;
}

/** Compute proportional cost sharing for `amount` of usage cost. */
export async function calculateCostShares(meterId: string, amount: number): Promise<Record<string, number>> {
  const shareholders = await getShareholders(meterId);
  return splitProportionally(shareholders, amount);
}

/** Compute proportional revenue sharing for `amount` of export revenue. */
export async function calculateRevenueShares(meterId: string, amount: number): Promise<Record<string, number>> {
  const shareholders = await getShareholders(meterId);
  return splitProportionally(shareholders, amount);
}

/**
 * Voting weight for `address` on `meterId`, expressed as their ownership
 * share (0..1). Used by governance routes to weight proposals/votes.
 */
export async function getVotingWeight(meterId: string, address: string): Promise<number> {
  return getOwnershipShare(meterId, address);
}