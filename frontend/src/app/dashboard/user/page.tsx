"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import Navbar from "@/components/Navbar";
import { useWalletStore } from "@/store/walletStore";
import { getMeter, getMetersByOwner, type MeterData } from "@/services/meterService";
import { parseWalletError } from "@/lib/errors";

const STROOPS_PER_XLM = 10_000_000n;

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

function MeterCard({ meterId, meter }: { meterId: string; meter: MeterData }) {
  return (
    <div className="rounded-xl border border-white/10 bg-solar-accent p-5 space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-mono text-sm text-solar-yellow font-semibold">{meterId}</span>
        <div className="flex items-center gap-2">
          <StatusBadge active={meter.active} />
          <PlanBadge plan={meter.plan} />
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: "Balance", value: `${stroopsToXlm(meter.balance)} XLM` },
          { label: "Units Used", value: `${meter.units_used} kWh` },
          { label: "Last Payment", value: meter.last_payment > 0n ? new Date(Number(meter.last_payment) * 1000).toLocaleDateString() : "—" },
          { label: "Owner", value: `${meter.owner.slice(0, 6)}…${meter.owner.slice(-4)}` },
        ].map(({ label, value }) => (
          <div key={label} className="flex flex-col gap-0.5">
            <span className="text-xs uppercase tracking-wider text-gray-500">{label}</span>
            <span className="text-sm font-semibold text-white truncate">{value}</span>
          </div>
        ))}
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
          href="/history"
          className="rounded-lg border border-white/10 px-4 py-2 text-xs text-gray-300 hover:border-solar-yellow hover:text-solar-yellow transition"
        >
          History
        </Link>
      </div>
    </div>
  );
}

export default function UserDashboardPage() {
  const { address, connect } = useWalletStore();

  const [meterIds, setMeterIds] = useState<string[]>([]);
  const [meters, setMeters] = useState<Record<string, MeterData>>({});
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
      const entries = await Promise.all(ids.map((id) => getMeter(id).then((m) => [id, m] as const)));
      setMeters(Object.fromEntries(entries));
      setLastRefresh(new Date());
    } catch (err: unknown) {
      setError(parseWalletError(err));
    } finally {
      setLoading(false);
    }
  }, [address]);

  useEffect(() => {
    if (!address) {
      setMeterIds([]);
      setMeters({});
      setError(null);
      setLastRefresh(null);
      return;
    }
    fetchAll();
  }, [address, fetchAll]);

  return (
    <>
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
          <div className="space-y-4 animate-pulse">
            {[0, 1].map((i) => (
              <div key={i} className="rounded-xl border border-white/10 bg-solar-accent p-5 h-36" />
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
              ) : (
                <div key={id} className="rounded-xl border border-white/10 bg-solar-accent p-5 h-36 animate-pulse" />
              )
            )}
          </div>
        )}
      </main>
    </>
  );
}
