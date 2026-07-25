"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import Navbar from "@/components/Navbar";
import { SkeletonCard } from "@/components/SkeletonCard";
import { Skeleton } from "@/components/Skeleton";
import UsageChart, { type UsageDataPoint } from "@/components/UsageChart";
import { useWalletStore } from "@/store/walletStore";
import { getMeter, getMetersByOwner, type MeterData } from "@/services/meterService";
import { parseWalletError } from "@/lib/errors";
import { useToast } from "@/components/ToastProvider";
import { useInterval } from "@/hooks/useInterval";

const STROOPS_PER_XLM = 10_000_000n;

const API = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:3001";

// Honour NEXT_PUBLIC_POLL_INTERVAL_MS env override, fall back to 30 s
const BALANCE_POLL_INTERVAL_MS: number = (() => {
  const env = process.env.NEXT_PUBLIC_POLL_INTERVAL_MS;
  const parsed = env ? parseInt(env, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30_000;
})();

function stroopsToXlm(stroops: bigint): string {
  const whole = stroops / STROOPS_PER_XLM;
  const frac = stroops % STROOPS_PER_XLM;
  return `${whole}.${frac.toString().padStart(7, "0").replace(/0+$/, "") || "0"}`;
}

function StatusBadge({ active }: { active: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold ${
        active
          ? "border-green-600/40 bg-green-900/30 text-green-400"
          : "border-red-600/40 bg-red-900/30 text-red-400"
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${active ? "bg-green-400" : "bg-red-400"}`} />
      {active ? "Active" : "Inactive"}
    </span>
  );
}

function PlanBadge({ plan }: { plan: string }) {
  const styles: Record<string, string> = {
    Daily: "bg-blue-900/40 text-blue-300 border-blue-700/40",
    Weekly: "bg-purple-900/40 text-purple-300 border-purple-700/40",
    UsageBased: "bg-green-900/40 text-green-300 border-green-700/40",
    Usage: "bg-green-900/40 text-green-300 border-green-700/40",
  };
  const cls = styles[plan] ?? "bg-gray-800 text-gray-400 border-gray-700/40";
  return (
    <span className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${cls}`}>
      {plan}
    </span>
  );
}

function ErrorCard({ meterId, error }: { meterId: string; error: string }) {
  return (
    <div className="rounded-xl border border-red-500/40 bg-red-900/20 p-4 sm:p-5 space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-mono text-sm text-red-400 font-semibold">{meterId}</span>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-red-600/40 bg-red-900/30 px-3 py-1 text-xs font-semibold text-red-400">
          <span className="h-1.5 w-1.5 rounded-full bg-red-400" />
          Error
        </span>
      </div>

      {/* Error message */}
      <div className="rounded-lg border border-red-600/40 bg-red-900/20 p-3 text-red-300 text-sm">
        <p>Failed to load meter data: {error}</p>
      </div>

      {/* Actions */}
      <div className="flex gap-2 pt-1">
        <button
          onClick={() => window.location.reload()} // Simple retry, or could call fetchAll for specific meter
          className="rounded-lg bg-red-600 px-4 py-2 text-xs font-semibold text-white hover:bg-red-700 transition"
        >
          Retry
        </button>
      </div>
    </div>
  );
}

function CountdownTimer({ expiresAt, plan }: { expiresAt: bigint; plan: string }) {
  const isTimedPlan = plan === "Daily" || plan === "Weekly";
  const expSec = Number(expiresAt);
  const hasExpiry = expSec > 0 && expSec !== Number.MAX_SAFE_INTEGER;

  const [remaining, setRemaining] = useState(() =>
    isTimedPlan && hasExpiry ? Math.max(0, expSec - Math.floor(Date.now() / 1000)) : -1
  );

  useEffect(() => {
    if (!isTimedPlan || !hasExpiry) return;
    const tick = () => setRemaining(Math.max(0, expSec - Math.floor(Date.now() / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [isTimedPlan, hasExpiry, expSec]);

  if (!isTimedPlan || !hasExpiry || remaining < 0) return null;

  if (remaining === 0) {
    return <span className="text-xs font-semibold text-red-400">Expired</span>;
  }

  const h = Math.floor(remaining / 3600).toString().padStart(2, "0");
  const m = Math.floor((remaining % 3600) / 60).toString().padStart(2, "0");
  const s = (remaining % 60).toString().padStart(2, "0");

  return <span className="text-xs font-mono text-solar-yellow">{h}:{m}:{s}</span>;
}

function MeterCard({ meterId, meter }: { meterId: string; meter: MeterData }) {
  const now = Date.now() / 1000; // Current time in seconds
  const expiresAt = Number(meter.expires_at);
  const isExpired = expiresAt !== Number.MAX_SAFE_INTEGER && expiresAt > 0 && now >= expiresAt;
  const hasAccess = meter.active && meter.balance > 0n && !isExpired;

  const [history, setHistory] = useState<UsageDataPoint[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);

  useEffect(() => {
    setLoadingHistory(true);
    fetch('/api/meters/' + meterId + '/history?limit=7')
      .then(r => r.json())
      .then(d => {
        const events: UsageDataPoint[] = (d.events || []).map((e: { recorded_at: string; units: number; cost?: number }) => ({
          date: new Date(e.recorded_at).toLocaleDateString(),
          units: e.units,
          cost: e.cost,
        }));
        setHistory(events);
        setLoadingHistory(false);
      })
      .catch(() => {
        setHistory([]);
        setLoadingHistory(false);
      });
  }, [meterId]);

  // Format expiry date
  const formatExpiry = () => {
    if (meter.plan === "UsageBased" || expiresAt === Number.MAX_SAFE_INTEGER) {
      return "Never (Usage-based)";
    }
    if (expiresAt === 0) return "—";
    const date = new Date(expiresAt * 1000);
    if (isExpired) return `Expired ${date.toLocaleDateString()}`;
    return date.toLocaleDateString();
  };

  return (
    <div className="rounded-xl border border-white/10 bg-solar-accent p-4 sm:p-5 space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-mono text-sm text-solar-yellow font-semibold">{meterId}</span>
        <div className="flex items-center gap-2">
          <StatusBadge active={hasAccess} />
          <PlanBadge plan={meter.plan} />
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 min-[480px]:grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: "Balance", value: `${stroopsToXlm(meter.balance)} XLM` },
          { label: "Units Used", value: `${Number(meter.units_used) / 1000} kWh` },
          { label: "Last Payment", value: meter.last_payment > 0n ? new Date(Number(meter.last_payment) * 1000).toLocaleDateString() : "—" },
          { label: "Expires", value: formatExpiry() },
        ].map(({ label, value }) => (
          <div key={label} className="flex flex-col gap-0.5">
            <span className="text-xs uppercase tracking-wider text-gray-500">{label}</span>
            <span className={`text-sm font-semibold truncate ${label === "Expires" && isExpired ? "text-red-400" : "text-white"}`}>
              {value}
            </span>
          </div>
        ))}
      </div>

      {/* Countdown timer for time-based plans */}
      {(meter.plan === "Daily" || meter.plan === "Weekly") && (
        <div className="flex items-center gap-2">
          <span className="text-xs uppercase tracking-wider text-gray-500">Time Remaining</span>
          <CountdownTimer expiresAt={meter.expires_at} plan={meter.plan} />
        </div>
      )}

      {/* Warning for expired or low balance */}
      {(isExpired || meter.balance === 0n) && (
        <div className="rounded-lg border border-yellow-600/40 bg-yellow-900/20 p-3 text-yellow-300 text-xs flex items-start gap-2">
          <span className="mt-0.5">⚠</span>
          <p>
            {isExpired && "Your plan has expired. "}
            {meter.balance === 0n && "Your balance is zero. "}
            Top up to restore access.
          </p>
        </div>
      )}

      {/* Usage History Chart */}
      <div className="pt-4 border-t border-white/10">
        <UsageChart data={history} loading={loadingHistory} meterId={meterId} />
      </div>

      {/* Actions */}
      <div className="flex gap-2 pt-1">
        <Link
          href={`/pay?meter=${meterId}`}
          className="rounded-lg bg-solar-yellow px-4 py-2 text-xs font-semibold text-solar-dark hover:opacity-90 transition"
        >
          Top Up
        </Link>
        <Link
          href={`/history?meterId=${meterId}`}
          className="rounded-lg border border-white/10 px-4 py-2 text-xs text-gray-300 hover:border-solar-yellow hover:text-solar-yellow transition"
        >
          View history
        </Link>
      </div>
    </div>
  );
}

export default function UserDashboardPage() {
  const { address, connect } = useWalletStore();
  const { showToast } = useToast();

  const [meterIds, setMeterIds] = useState<string[]>([]);
  const [meters, setMeters] = useState<Record<string, MeterData>>({});
  const [failedMeters, setFailedMeters] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const fetchAll = useCallback(async () => {
    if (!address) return;
    setLoading(true);
    setError(null);
    try {
      const ids = await getMetersByOwner(address);
      setMeterIds(ids);
      const metersMap: Record<string, MeterData> = {};
      const failedMap: Record<string, string> = {};
      for (const id of ids) {
        try {
          const meter = await getMeter(id);
          metersMap[id] = meter;
        } catch (err: unknown) {
          const friendly = parseWalletError(err);
          failedMap[id] = friendly;
          showToast({
            variant: "error",
            title: `Failed to load meter ${id}`,
            description: friendly,
          });
        }
      }
      setMeters(metersMap);
      setFailedMeters(failedMap);
      if (Object.keys(failedMap).length > 0) {
        setError(`Some meters failed to load. Check individual meter cards for details.`);
      }
      setLastRefresh(new Date());
    } catch (err: unknown) {
      const friendly = parseWalletError(err);
      setError(friendly);
      showToast({
        variant: "error",
        title: "Failed to load meters",
        description: friendly,
      });
    } finally {
      setLoading(false);
    }
  }, [address, showToast]);

  // Initial fetch when wallet connects / address changes
  useEffect(() => {
    if (!address) {
      setMeterIds([]);
      setMeters({});
      setFailedMeters({});
      setError(null);
      setLastRefresh(null);
      return;
    }
    fetchAll();
  }, [address, fetchAll]);

  // Poll individual meter balances for live updates.
  // useInterval does NOT fire on mount, so fetchAll() above handles the
  // first load — no double-fetch on first render.
  const pollBalances = useCallback(async () => {
    if (!address || meterIds.length === 0) return;
    for (const id of meterIds) {
      try {
        const res = await fetch(`${API}/api/meters/${id}/balance`);
        if (!res.ok) continue;
        const data = await res.json();
        setMeters((prev) => {
          const existing = prev[id];
          if (!existing) return prev;
          return {
            ...prev,
            [id]: {
              ...existing,
              balance: BigInt(data.balance ?? existing.balance),
              units_used: data.units_used ?? existing.units_used,
              active: data.active ?? existing.active,
            },
          };
        });
      } catch {
        // Silently skip — full refresh will recover on next interval
      }
    }
    setLastRefresh(new Date());
  }, [address, meterIds]);

  // Pause polling when address is gone or no meters loaded yet
  useInterval(pollBalances, address && meterIds.length > 0 ? BALANCE_POLL_INTERVAL_MS : null);

  return (
    <ErrorBoundary>
      <Navbar />
      <main className="min-h-screen px-4 py-8 max-w-3xl mx-auto">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-6">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-solar-yellow">My Meters</h1>
            {lastRefresh && (
              <p className="text-xs text-gray-500 mt-0.5">
                Last updated {lastRefresh.toLocaleTimeString()}
              </p>
            )}
          </div>
          {address && (
            <button
              onClick={fetchAll}
              disabled={loading}
              className="self-start sm:self-auto rounded-lg border border-white/10 px-4 py-2 text-sm text-gray-300 hover:border-solar-yellow hover:text-solar-yellow disabled:opacity-40 disabled:cursor-not-allowed transition"
            >
              {loading ? "Refreshing…" : "↻ Refresh"}
            </button>
          )}
        </div>

        {/* Not connected */}
        {!address && (
          <div className="rounded-xl border border-white/10 bg-solar-accent p-10 text-center">
            <p className="text-gray-400 mb-5">Connect your wallet to view your meters.</p>
            <button
              onClick={connect}
              className="rounded-lg bg-solar-yellow px-6 py-2.5 font-semibold text-solar-dark hover:opacity-90 transition"
            >
              Connect Wallet
            </button>
          </div>
        )}

        {/* Error */}
        {address && error && (
          <div className="rounded-lg border border-red-500/40 bg-red-900/20 p-4 text-red-400 text-sm mb-6 flex items-start gap-3">
            <span className="mt-0.5">✕</span>
            <div>
              <p className="font-semibold mb-1">Failed to load meters</p>
              <p>{error}</p>
              <button onClick={fetchAll} className="mt-3 text-xs underline underline-offset-2 hover:text-red-300 transition">
                Try again
              </button>
            </div>
          </div>
        )}

        {/* Loading skeleton */}
        {address && loading && meterIds.length === 0 && (
          <div className="space-y-4">
            {[0, 1].map((i) => (
              <div key={i} className="rounded-xl border border-white/10 bg-solar-accent p-4 sm:p-5 space-y-4">
                <div className="flex items-center justify-between gap-2">
                  <Skeleton width="30%" height={16} />
                  <Skeleton width="20%" height={24} />
                </div>
                <div className="grid grid-cols-1 min-[480px]:grid-cols-2 sm:grid-cols-4 gap-3">
                  {[1, 2, 3, 4].map((j) => (
                    <div key={j} className="flex flex-col gap-1">
                      <Skeleton width="60%" height={10} />
                      <Skeleton height={16} />
                    </div>
                  ))}
                </div>
                <Skeleton height={40} />
              </div>
            ))}
          </div>
        )}

        {/* No meters */}
        {address && !loading && !error && meterIds.length === 0 && (
          <div className="rounded-xl border border-white/10 bg-solar-accent p-10 text-center text-gray-400 text-sm">
            No meters registered to this address.
          </div>
        )}

        {/* Meter list */}
        {address && meterIds.length > 0 && (
          <div className="space-y-4">
            {meterIds.map((id) =>
              meters[id] ? (
                <MeterCard key={id} meterId={id} meter={meters[id]} />
              ) : failedMeters[id] ? (
                <ErrorCard key={id} meterId={id} error={failedMeters[id]} />
              ) : (
                <SkeletonCard key={id} height={160} />
              )
            )}
          </div>
        )}


      </main>
    </ErrorBoundary>
  );
}
