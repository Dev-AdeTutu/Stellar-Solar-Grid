/**
 * Read-side helpers for on-chain energy token staking (#899).
 *
 * Wraps the contract's staking views (`get_staking_config`, `get_staking_pool`,
 * `get_stake_info`, `get_voting_power`) and derives dashboard stats such as
 * APR and the number of days of rewards left in the reserve. Staking writes
 * (stake / unstake / claim) are signed by the user's wallet in the frontend.
 */
import * as StellarSdk from "@stellar/stellar-sdk";
import { stellarService } from "./stellar.js";

const SECONDS_PER_YEAR = 365 * 86_400;

export type StakingStats = {
  configured: boolean;
  stakeToken: string | null;
  rewardToken: string | null;
  rewardRatePerSecond: string;
  cooldownSecs: number;
  totalStaked: string;
  stakerCount: number;
  rewardReserve: string;
  totalDistributed: string;
  /** Annualised reward / stake, assuming stake and reward token are valued 1:1. */
  aprPercent: number | null;
  /** How long the current reserve lasts at the current rate. */
  reserveRunwayDays: number | null;
};

export type StakerInfo = {
  address: string;
  staked: string;
  pendingRewards: string;
  unstaking: string;
  unlockAt: string | null;
  canWithdraw: boolean;
  votingPower: string;
  votingSharePercent: number | null;
  stakedAt: string | null;
};

const addr = (a: string) => StellarSdk.nativeToScVal(a, { type: "address" });
const big = (v: unknown) => BigInt((v as bigint | number | undefined) ?? 0);

async function view(method: string, args: StellarSdk.xdr.ScVal[] = []): Promise<any> {
  return StellarSdk.scValToNative(await stellarService.query(method, args));
}

export async function getStakingStats(): Promise<StakingStats> {
  let cfg: any;
  try {
    cfg = await view("get_staking_config");
  } catch (err) {
    // StakingNotConfigured surfaces as a contract error from simulation.
    if (String((err as Error)?.message).includes("Error(Contract, #38)")) {
      return {
        configured: false,
        stakeToken: null,
        rewardToken: null,
        rewardRatePerSecond: "0",
        cooldownSecs: 0,
        totalStaked: "0",
        stakerCount: 0,
        rewardReserve: "0",
        totalDistributed: "0",
        aprPercent: null,
        reserveRunwayDays: null,
      };
    }
    throw err;
  }
  const pool = await view("get_staking_pool");
  const rate = big(cfg.reward_rate);
  const total = big(pool.total_staked);
  const reserve = big(pool.reward_reserve);
  return {
    configured: true,
    stakeToken: String(cfg.stake_token),
    rewardToken: String(cfg.reward_token),
    rewardRatePerSecond: rate.toString(),
    cooldownSecs: Number(cfg.cooldown_secs),
    totalStaked: total.toString(),
    stakerCount: Number(pool.staker_count ?? 0),
    rewardReserve: reserve.toString(),
    totalDistributed: big(pool.total_distributed).toString(),
    aprPercent:
      total > 0n && reserve > 0n ? (Number(rate) * SECONDS_PER_YEAR * 100) / Number(total) : null,
    reserveRunwayDays: rate > 0n ? Number(reserve / rate) / 86_400 : null,
  };
}

export async function getStakerInfo(address: string, now = Date.now()): Promise<StakerInfo> {
  const [info, totalPower] = await Promise.all([
    view("get_stake_info", [addr(address)]),
    view("get_total_voting_power"),
  ]);
  const unlockAt = Number(info.unlock_at ?? 0);
  const unstaking = big(info.unstaking);
  const power = big(info.voting_power);
  const total = big(totalPower);
  return {
    address,
    staked: big(info.staked).toString(),
    pendingRewards: big(info.pending_rewards).toString(),
    unstaking: unstaking.toString(),
    unlockAt: unlockAt ? new Date(unlockAt * 1000).toISOString() : null,
    canWithdraw: unstaking > 0n && unlockAt * 1000 <= now,
    votingPower: power.toString(),
    votingSharePercent: total > 0n ? (Number(power) * 100) / Number(total) : null,
    stakedAt: Number(info.staked_at) ? new Date(Number(info.staked_at) * 1000).toISOString() : null,
  };
}

export async function getVotingPower(address: string): Promise<string> {
  return big(await view("get_voting_power", [addr(address)])).toString();
}
