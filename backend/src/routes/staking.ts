/**
 * Energy token staking endpoints (#899). Read-only — stake/unstake/claim are
 * signed client-side by the user's wallet against the contract.
 *
 *   GET /api/staking/stats                       — pool totals, APR, reserve runway
 *   GET /api/staking/:address                    — a staker's position
 *   GET /api/staking/:address/voting-power       — governance voting power
 */
import { Router } from "express";
import * as StellarSdk from "@stellar/stellar-sdk";
import { asyncHandler } from "../lib/asyncHandler.js";
import { getStakerInfo, getStakingStats, getVotingPower } from "../lib/staking.js";

export const stakingRouter = Router();

const validAddress = (a: string) =>
  StellarSdk.StrKey.isValidEd25519PublicKey(a) || StellarSdk.StrKey.isValidContract(a);

/**
 * Lock-up period (in seconds) applied to staked tokens, including tokens
 * staked via delegation. Mirrors the on-chain lock-up enforced for directly
 * staked tokens so delegated stakes cannot bypass it.
 */
const LOCKUP_PERIOD_SECONDS = 7 * 24 * 60 * 60;

type DelegationRecord = {
  delegator?: string;
  delegatee?: string;
  stakedAt?: number | string;
  amount?: string | number;
};

/**
 * Resolve delegation records for a staker. Delegations may be recorded either
 * with the staker as the delegator (tokens they delegated) or as the delegatee
 * (tokens delegated to them); both are subject to the same lock-up.
 */
async function getDelegationRecords(address: string): Promise<DelegationRecord[]> {
  const info = (await getStakerInfo(address)) as {
    delegations?: DelegationRecord[];
    delegatedStakes?: DelegationRecord[];
  } | null;
  if (!info) return [];
  const records = [...(info.delegations ?? []), ...(info.delegatedStakes ?? [])];
  return records.filter(
    (r) => r.delegator === address || r.delegatee === address,
  );
}

/** Returns true when the delegation's lock-up period has fully elapsed. */
function isDelegationUnlocked(record: DelegationRecord, now: number): boolean {
  const stakedAt = Number(record.stakedAt);
  if (!Number.isFinite(stakedAt) || stakedAt <= 0) return false;
  // stakedAt may be expressed in seconds or milliseconds; normalise to seconds.
  const stakedAtSeconds = stakedAt > 1e12 ? Math.floor(stakedAt / 1000) : stakedAt;
  return now - stakedAtSeconds >= LOCKUP_PERIOD_SECONDS;
}

stakingRouter.get(
  "/stats",
  asyncHandler(async (_req, res) => {
    res.json(await getStakingStats());
  }),
);

stakingRouter.get(
  "/:address",
  asyncHandler(async (req, res) => {
    if (!validAddress(req.params.address)) {
      return res.status(400).json({ error: "Invalid Stellar address" });
    }
    res.json(await getStakerInfo(req.params.address));
  }),
);

stakingRouter.get(
  "/:address/voting-power",
  asyncHandler(async (req, res) => {
    if (!validAddress(req.params.address)) {
      return res.status(400).json({ error: "Invalid Stellar address" });
    }
    res.json({ address: req.params.address, votingPower: await getVotingPower(req.params.address) });
  }),
);

/**
 * Withdrawal check for delegated stakes. Enforces the same lock-up period as
 * directly staked tokens: any delegated stake still within its lock-up window
 * blocks the withdrawal.
 */
stakingRouter.get(
  "/:address/withdrawal-status",
  asyncHandler(async (req, res) => {
    if (!validAddress(req.params.address)) {
      return res.status(400).json({ error: "Invalid Stellar address" });
    }
    const now = Math.floor(Date.now() / 1000);
    const delegations = await getDelegationRecords(req.params.address);
    const locked = delegations.filter((r) => !isDelegationUnlocked(r, now));
    if (locked.length > 0) {
      const unlockAt = Math.max(
        ...locked.map((r) => {
          const stakedAt = Number(r.stakedAt);
          const stakedAtSeconds = stakedAt > 1e12 ? Math.floor(stakedAt / 1000) : stakedAt;
          return stakedAtSeconds + LOCKUP_PERIOD_SECONDS;
        }),
      );
      return res.status(403).json({
        error: "Delegated stake is still within its lock-up period",
        unlockAt,
      });
    }
    res.json({ address: req.params.address, withdrawable: true });
  }),
);
</｜｜DSML｜｜ parameter>