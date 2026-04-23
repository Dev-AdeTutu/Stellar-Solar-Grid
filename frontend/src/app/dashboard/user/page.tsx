"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import Navbar from "@/components/Navbar";
import { useWalletStore } from "@/store/walletStore";
import { getMeter, type MeterData } from "@/services/meterService";
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
      <span
        className={`h-1.5 w-1.5 rounded-full ${active ? "bg-green-400" : "bg-red-400"}`}
      />
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

function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: React.ReactNode;
  sub?: string;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-solar-accent p-5 flex flex-col gap-1">
      <span className="text-xs font-semibold uppercase tracking-wider text-gray-500">
        {label}
      </span>
      <span className="text-2xl font-bold text-white">{value}</span>
      {sub && <span className="text-xs text-gray-500">{sub}</span>}
    </div>
  );
}

export default function UserDashboardPage() {
  const { address, connect } = useWalletStore();

  // meterId is the wallet address itself (owner = address on-chain)
  const meterId = address ?? "";

  const [meter, setMeter] = useState<MeterData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const fetchMeterData = useCallback(async () => {
    if (!meterId) return;
    setLoading(true);
    setError(null);
    try {
      const data = await getMeter(meterId);
      setMeter(data);
      setLastRefresh(new Date());
    } catch (err: unknown) {
      setError(parseWalletError(err));
    } finally {
      setLoading(false);
    }
  }, [meterId]);

  // Clear stale data immediately when wallet disconnects, fetch when connected
  useEffect(() => {
    if (!address) {
      setMeter(null);
      setError(null);
      setLastRefresh(null);
      return;
    }
    fetchMeterData();
  }, [address, fetchMeterData]);

  return (
    <>
      <Navbar />
      <main className="min-h-screen px-4 py-8 max-w-3xl mx-auto">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-6">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-solar-yellow">My Meter</h1>
            {lastRefresh && (
              <p className="text-xs text-gray-500 mt-0.5">
                Last updated {lastRefresh.toLocaleTimeString()}
              </p>
            )}
          </div>
          {address && (
            <button
              onClick={fetchMeterData}
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
            <p className="text-gray-400 mb-5">Connect your wallet to view your meter.</p>
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
              <p className="font-semibold mb-1">Failed to load meter data</p>
              <p>{error}</p>
              <button
                onClick={fetchMeterData}
                className="mt-3 text-xs underline underline-offset-2 hover:text-red-300 transition"
              >
                Try again
              </button>
            </div>
          </div>
        )}

        {/* Loading skeleton */}
        {address && loading && !meter && (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 animate-pulse">
            {Array.from({ length: 4 }).map((_, i) => (
              <div
                key={i}
                className="rounded-xl border border-white/10 bg-solar-accent p-5 h-24"
              />
            ))}
          </div>
        )}

        {/* Meter data */}
        {address && meter && (
          <div className="space-y-6">
            {/* Status row */}
            <div className="flex flex-wrap items-center gap-3">
              <StatusBadge active={meter.active} />
              <PlanBadge plan={meter.plan} />
              <span className="text-xs text-gray-500 font-mono truncate max-w-xs">
                {meter.owner}
              </span>
            </div>

            {/* Stat cards */}
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <StatCard
                label="Balance"
                value={`${stroopsToXlm(meter.balance)} XLM`}
                sub="on-chain balance"
              />
              <StatCard
                label="Units Used"
                value={meter.units_used.toString()}
                sub="kWh consumed"
              />
              <StatCard
                label="Plan"
                value={<PlanBadge plan={meter.plan} />}
                sub="billing cycle"
              />
              <StatCard
                label="Status"
                value={<StatusBadge active={meter.active} />}
                sub="meter state"
              />
            </div>

            {/* Last payment */}
            {meter.last_payment > 0n && (
              <div className="rounded-xl border border-white/10 bg-solar-accent px-5 py-4 text-sm text-gray-400">
                Last payment:{" "}
                <span className="text-white font-medium">
                  {new Date(Number(meter.last_payment) * 1000).toLocaleString()}
                </span>
              </div>
            )}

            {/* Actions */}
            <div className="flex flex-col sm:flex-row gap-3">
              <Link
                href={`/pay`}
                className="rounded-lg bg-solar-yellow px-6 py-3 text-center font-semibold text-solar-dark hover:opacity-90 transition"
              >
                Top Up Balance
              </Link>
              <Link
                href="/history"
                className="rounded-lg border border-white/10 px-6 py-3 text-center text-sm text-gray-300 hover:border-solar-yellow hover:text-solar-yellow transition"
              >
                View Payment History
              </Link>
            </div>
          </div>
        )}
      </main>
    </>
  );
}
