"use client";

/**
 * Energy token staking dashboard (#899): pool stats, the connected wallet's
 * position, and stake / unstake / withdraw / claim actions signed by the wallet.
 */
import { useCallback, useEffect, useState } from "react";
import Navbar from "@/components/Navbar";
import { useWalletStore } from "@/store/walletStore";
import { useToast } from "@/components/ToastProvider";
import { parseWalletError } from "@/lib/errors";
import { env } from "@/lib/env";
import { formatXLM } from "@/lib/format";
import {
  cancelUnstake,
  claimStakingRewards,
  requestUnstake,
  stakeTokens,
  withdrawUnstaked,
} from "@/lib/contract";

const API = env.NEXT_PUBLIC_BACKEND_URL;
const BTN =
  "rounded-lg border border-white/20 px-4 py-2 text-sm hover:bg-white/5 disabled:opacity-40 disabled:cursor-not-allowed";
const BTN_PRIMARY =
  "rounded-lg bg-yellow-500 text-black font-medium px-4 py-2 text-sm hover:bg-yellow-400 disabled:opacity-40 disabled:cursor-not-allowed";

type StakingStats = {
  configured: boolean;
  rewardRatePerSecond: string;
  cooldownSecs: number;
  totalStaked: string;
  stakerCount: number;
  rewardReserve: string;
  totalDistributed: string;
  aprPercent: number | null;
  reserveRunwayDays: number | null;
};

type StakerInfo = {
  staked: string;
  pendingRewards: string;
  unstaking: string;
  unlockAt: string | null;
  canWithdraw: boolean;
  votingPower: string;
  votingSharePercent: number | null;
};

/** Parse a decimal token amount (7 decimals) into base units. */
function toBaseUnits(input: string): bigint | null {
  const m = input.trim().match(/^(\d+)(?:\.(\d{0,7}))?$/);
  if (!m) return null;
  const value = BigInt(m[1]) * 10_000_000n + BigInt((m[2] ?? "").padEnd(7, "0") || "0");
  return value > 0n ? value : null;
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-white/10 p-4">
      <div className="text-xs uppercase tracking-wide opacity-70">{label}</div>
      <div className="text-2xl font-semibold mt-1 tabular-nums">{value}</div>
      {hint && <div className="text-xs opacity-60 mt-1">{hint}</div>}
    </div>
  );
}

export default function StakingPage() {
  const { address } = useWalletStore();
  const { showToast } = useToast();
  const [stats, setStats] = useState<StakingStats | null>(null);
  const [me, setMe] = useState<StakerInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const s = await fetch(`${API}/api/staking/stats`).then((r) =>
        r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)),
      );
      setStats(s);
      if (address && s.configured) {
        const info = await fetch(`${API}/api/staking/${address}`).then((r) =>
          r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)),
        );
        setMe(info);
      } else {
        setMe(null);
      }
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [address]);

  useEffect(() => {
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, [load]);

  const run = async (label: string, action: () => Promise<string>) => {
    setBusy(label);
    try {
      const hash = await action();
      showToast({ title: `${label} submitted`, description: `Tx ${hash.slice(0, 10)}…` });
      setAmount("");
      await load();
    } catch (e) {
      showToast({ title: `${label} failed`, description: parseWalletError(e), variant: "error" });
    } finally {
      setBusy(null);
    }
  };

  const parsed = toBaseUnits(amount);
  const staked = BigInt(me?.staked ?? "0");

  return (
    <>
      <Navbar />
      <main className="p-6 max-w-5xl mx-auto">
        <h1 className="text-2xl font-bold mb-1">Energy Token Staking</h1>
        <p className="opacity-70 mb-6">
          Stake tokens to earn rewards and governance voting power. Unstaked tokens are released after a cooldown.
        </p>

        {error && <p className="text-red-500 mb-4">Failed to load staking data: {error}</p>}
        {stats && !stats.configured && <p className="opacity-80">Staking has not been enabled yet.</p>}

        {stats?.configured && (
          <section aria-label="Pool statistics" className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
            <Stat label="Total staked" value={formatXLM(stats.totalStaked)} hint={`${stats.stakerCount} stakers`} />
            <Stat
              label="APR"
              value={stats.aprPercent === null ? "—" : `${stats.aprPercent.toFixed(2)}%`}
              hint="At current reward rate"
            />
            <Stat
              label="Reward reserve"
              value={formatXLM(stats.rewardReserve)}
              hint={stats.reserveRunwayDays === null ? undefined : `~${Math.floor(stats.reserveRunwayDays)} days left`}
            />
            <Stat
              label="Rewards distributed"
              value={formatXLM(stats.totalDistributed)}
              hint={`Cooldown ${Math.round(stats.cooldownSecs / 3600)}h`}
            />
          </section>
        )}

        {stats?.configured && !address && <p className="opacity-80">Connect your wallet to stake.</p>}

        {stats?.configured && address && me && (
          <>
            <section aria-label="Your position" className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
              <Stat label="Your stake" value={formatXLM(me.staked)} />
              <Stat label="Pending rewards" value={formatXLM(me.pendingRewards, true)} />
              <Stat
                label="Voting power"
                value={formatXLM(me.votingPower)}
                hint={me.votingSharePercent === null ? undefined : `${me.votingSharePercent.toFixed(2)}% of total`}
              />
              <Stat
                label="Unstaking"
                value={formatXLM(me.unstaking)}
                hint={
                  me.unlockAt && BigInt(me.unstaking) > 0n
                    ? me.canWithdraw
                      ? "Ready to withdraw"
                      : `Unlocks ${new Date(me.unlockAt).toLocaleString()}`
                    : undefined
                }
              />
            </section>

            <section aria-label="Actions" className="rounded-lg border border-white/10 p-4 flex flex-col gap-4">
              <label className="flex flex-col gap-1 max-w-sm">
                <span className="text-sm">Amount</span>
                <input
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="0.0"
                  className="rounded border border-white/20 bg-transparent px-3 py-2"
                />
              </label>
              <div className="flex flex-wrap gap-2">
                <button
                  className={BTN_PRIMARY}
                  disabled={!parsed || !!busy}
                  onClick={() => parsed && run("Stake", () => stakeTokens(address, parsed))}
                >
                  {busy === "Stake" ? "Staking…" : "Stake"}
                </button>
                <button
                  className={BTN}
                  disabled={!parsed || parsed > staked || !!busy}
                  onClick={() => parsed && run("Unstake request", () => requestUnstake(address, parsed))}
                >
                  {busy === "Unstake request" ? "Requesting…" : "Request unstake"}
                </button>
                <button
                  className={BTN}
                  disabled={BigInt(me.pendingRewards) <= 0n || !!busy}
                  onClick={() => run("Claim", () => claimStakingRewards(address))}
                >
                  {busy === "Claim" ? "Claiming…" : "Claim rewards"}
                </button>
                <button
                  className={BTN}
                  disabled={!me.canWithdraw || !!busy}
                  onClick={() => run("Withdraw", () => withdrawUnstaked(address))}
                >
                  {busy === "Withdraw" ? "Withdrawing…" : "Withdraw unstaked"}
                </button>
                <button
                  className={BTN}
                  disabled={BigInt(me.unstaking) <= 0n || !!busy}
                  onClick={() => run("Cancel unstake", () => cancelUnstake(address))}
                >
                  Cancel unstake
                </button>
              </div>
              <p className="text-xs opacity-60">
                Tokens stop earning rewards and voting power as soon as you request an unstake.
              </p>
            </section>
          </>
        )}
      </main>
    </>
  );
}
