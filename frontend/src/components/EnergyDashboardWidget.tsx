"use client";

import { useEffect, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { env } from "@/lib/env";

export type EnergyRange = "5m" | "hourly" | "daily";
export type EnergyPoint = {
  timestamp: string;
  productionKwh: number;
  consumptionKwh: number;
};
export type EnergySnapshot = {
  meterId: string;
  range: EnergyRange;
  updatedAt: string;
  current: EnergyPoint;
  points: EnergyPoint[];
};

export type VppPortfolio = {
  id: string;
  name: string;
  status: "active" | "standby" | "dispatched" | "paused";
  meterCount: number;
  capacityKw: number;
  availableKw: number;
};

export type VppDispatch = {
  id: string;
  portfolioId: string;
  signal: "charge" | "discharge" | "curtail" | "idle";
  targetKw: number;
  deliveredKw: number;
  startedAt: string;
  endsAt: string;
  status: "pending" | "active" | "completed" | "failed";
};

export type VppPerformance = {
  portfolioId: string;
  period: string;
  energyDeliveredKwh: number;
  revenueUsd: number;
  availabilityPct: number;
  responseAccuracyPct: number;
};

export type VppEarnings = {
  participantId: string;
  participantName: string;
  sharePct: number;
  amountUsd: number;
  paid: boolean;
};

export type VppOverview = {
  portfolios: VppPortfolio[];
  dispatches: VppDispatch[];
  performance: VppPerformance[];
  earnings: VppEarnings[];
  updatedAt: string;
};

const RANGE_LABELS: Record<EnergyRange, string> = {
  "5m": "5 min",
  hourly: "Hourly",
  daily: "Daily",
};

function socketUrl(meterId: string, range: EnergyRange): string {
  const base = env.NEXT_PUBLIC_BACKEND_URL || window.location.origin;
  const url = new URL("/api/widgets/live", base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("meterId", meterId);
  url.searchParams.set("range", range);
  return url.toString();
}

function useVppOverview() {
  const [overview, setOverview] = useState<VppOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const response = await fetch(`${env.NEXT_PUBLIC_BACKEND_URL}/api/vpp/overview`);
      if (!response.ok) throw new Error(`VPP request failed (${response.status})`);
      const next = (await response.json()) as VppOverview;
      setOverview(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load VPP data");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  return { overview, loading, error, refresh };
}

function useEnergySnapshot(meterId: string, range: EnergyRange) {
  const [snapshot, setSnapshot] = useState<EnergySnapshot | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let stopped = false;
    let socket: WebSocket | null = null;
    let retryTimer: number | undefined;
    let pollTimer: number | undefined;
    let attempts = 0;

    const refresh = async () => {
      try {
        const query = new URLSearchParams({ meterId, range });
        const response = await fetch(`${env.NEXT_PUBLIC_BACKEND_URL}/api/widgets/energy?${query}`);
        if (!response.ok) throw new Error(`Energy request failed (${response.status})`);
        const next = (await response.json()) as EnergySnapshot;
        if (!stopped) setSnapshot(next);
      } catch {
        // Keep the last complete snapshot visible through brief network failures.
      }
    };

    const connect = () => {
      if (stopped) return;
      socket = new WebSocket(socketUrl(meterId, range));
      socket.onopen = () => {
        attempts = 0;
        setConnected(true);
      };
      socket.onmessage = (event) => {
        try {
          const next = JSON.parse(event.data) as EnergySnapshot;
          if (next.meterId === meterId && next.range === range && Array.isArray(next.points)) {
            setSnapshot(next);
          }
        } catch {
          // Ignore incomplete frames and wait for the next complete snapshot.
        }
      };
      socket.onerror = () => socket?.close();
      socket.onclose = () => {
        setConnected(false);
        if (!stopped) {
          const delay = Math.min(30_000, 1_000 * 2 ** attempts++);
          retryTimer = window.setTimeout(connect, delay);
        }
      };
    };

    void refresh();
    connect();
    pollTimer = window.setInterval(() => {
      if (socket?.readyState !== WebSocket.OPEN) void refresh();
    }, 15_000);

    return () => {
      stopped = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      if (pollTimer !== undefined) window.clearInterval(pollTimer);
      socket?.close();
    };
  }, [meterId, range]);

  return { snapshot, connected };
}

export function formatEnergyTick(timestamp: string, range: EnergyRange): string {
  const date = new Date(timestamp);
  if (range === "daily") return date.toLocaleDateString(undefined, { weekday: "short" });
  return date.toLocaleTimeString(undefined, { hour: "numeric", ...(range === "5m" ? { minute: "2-digit" } : {}) });
}

const DISPATCH_LABELS: Record<VppDispatch["signal"], string> = {
  charge: "Charge",
  discharge: "Discharge",
  curtail: "Curtail",
  idle: "Idle",
};

const STATUS_STYLES: Record<VppPortfolio["status"], string> = {
  active: "bg-emerald-500/15 text-emerald-300",
  standby: "bg-amber-500/15 text-amber-300",
  dispatched: "bg-cyan-500/15 text-cyan-300",
  paused: "bg-gray-500/15 text-gray-300",
};

export function VppManagementPortal() {
  const { overview, loading, error, refresh } = useVppOverview();
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const dispatch = async (portfolioId: string, signal: VppDispatch["signal"]) => {
    setBusy(`${portfolioId}:${signal}`);
    setActionError(null);
    try {
      const response = await fetch(`${env.NEXT_PUBLIC_BACKEND_URL}/api/vpp/dispatch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ portfolioId, signal }),
      });
      if (!response.ok) throw new Error(`Dispatch failed (${response.status})`);
      await refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Dispatch failed");
    } finally {
      setBusy(null);
    }
  };

  const distribute = async (portfolioId: string) => {
    setBusy(`${portfolioId}:distribute`);
    setActionError(null);
    try {
      const response = await fetch(`${env.NEXT_PUBLIC_BACKEND_URL}/api/vpp/earnings/distribute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ portfolioId }),
      });
      if (!response.ok) throw new Error(`Distribution failed (${response.status})`);
      await refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Distribution failed");
    } finally {
      setBusy(null);
    }
  };

  return (
    <section aria-label="VPP management" className="border-y border-white/10 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">Virtual Power Plant</h2>
        <button
          type="button"
          className="min-h-8 border border-white/15 px-3 text-xs text-gray-300 hover:bg-white/5"
          onClick={() => void refresh()}
        >
          Refresh
        </button>
      </div>

      {error ? <p className="mt-2 text-xs text-red-400" role="alert">{error}</p> : null}
      {actionError ? <p className="mt-2 text-xs text-red-400" role="alert">{actionError}</p> : null}
      {loading && !overview ? <p className="mt-2 text-xs text-gray-500">Loading VPP data</p> : null}

      {overview ? (
        <div className="mt-4 space-y-6">
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400">Portfolios</h3>
            <ul className="mt-2 divide-y divide-white/10">
              {overview.portfolios.map((portfolio) => (
                <li key={portfolio.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
                  <div>
                    <p className="text-sm font-medium">{portfolio.name}</p>
                    <p className="text-xs text-gray-400">
                      {portfolio.meterCount} meters · {portfolio.availableKw.toFixed(1)}/{portfolio.capacityKw.toFixed(1)} kW available
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`px-2 py-0.5 text-[11px] ${STATUS_STYLES[portfolio.status]}`}>{portfolio.status}</span>
                    <button
                      type="button"
                      className="min-h-8 border border-white/15 px-2 text-xs text-gray-300 hover:bg-white/5 disabled:opacity-50"
                      disabled={busy !== null}
                      onClick={() => void dispatch(portfolio.id, "discharge")}
                    >
                      {busy === `${portfolio.id}:discharge` ? "Dispatching…" : "Dispatch"}
                    </button>
                    <button
                      type="button"
                      className="min-h-8 border border-white/15 px-2 text-xs text-gray-300 hover:bg-white/5 disabled:opacity-50"
                      disabled={busy !== null}
                      onClick={() => void distribute(portfolio.id)}
                    >
                      {busy === `${portfolio.id}:distribute` ? "Distributing…" : "Distribute earnings"}
                    </button>
                  </div>
                </li>
              ))}
              {overview.portfolios.length === 0 ? <li className="py-2 text-xs text-gray-500">No portfolios yet</li> : null}
            </ul>
          </div>

          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400">Dispatch status</h3>
            <ul className="mt-2 divide-y divide-white/10">
              {overview.dispatches.map((item) => (
                <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-xs">
                  <span className="font-medium">{DISPATCH_LABELS[item.signal]}</span>
                  <span className="text-gray-400">
                    {item.deliveredKw.toFixed(1)}/{item.targetKw.toFixed(1)} kW
                  </span>
                  <span className="text-gray-400">{item.status}</span>
                  <span className="text-gray-500">{new Date(item.startedAt).toLocaleTimeString()}</span>
                </li>
              ))}
              {overview.dispatches.length === 0 ? <li className="py-2 text-xs text-gray-500">No dispatch signals</li> : null}
            </ul>
          </div>

          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400">Performance</h3>
            <ul className="mt-2 divide-y divide-white/10">
              {overview.performance.map((item) => (
                <li key={`${item.portfolioId}-${item.period}`} className="flex flex-wrap items-center justify-between gap-2 py-2 text-xs">
                  <span className="font-medium">{item.period}</span>
                  <span className="text-gray-400">{item.energyDeliveredKwh.toFixed(1)} kWh</span>
                  <span className="text-emerald-300">${item.revenueUsd.toFixed(2)}</span>
                  <span className="text-gray-400">{item.availabilityPct.toFixed(0)}% avail</span>
                  <span className="text-gray-400">{item.responseAccuracyPct.toFixed(0)}% accuracy</span>
                </li>
              ))}
              {overview.performance.length === 0 ? <li className="py-2 text-xs text-gray-500">No performance data</li> : null}
            </ul>
          </div>

          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400">Earnings distribution</h3>
            <ul className="mt-2 divide-y divide-white/10">
              {overview.earnings.map((item) => (
                <li key={item.participantId} className="flex flex-wrap items-center justify-between gap-2 py-2 text-xs">
                  <span className="font-medium">{item.participantName}</span>
                  <span className="text-gray-400">{item.sharePct.toFixed(1)}%</span>
                  <span className="text-emerald-300">${item.amountUsd.toFixed(2)}</span>
                  <span className={item.paid ? "text-emerald-300" : "text-amber-300"}>{item.paid ? "Paid" : "Pending"}</span>
                </li>
              ))}
              {overview.earnings.length === 0 ? <li className="py-2 text-xs text-gray-500">No earnings to distribute</li> : null}
            </ul>
          </div>

          <p className="text-right text-[11px] text-gray-500">
            Updated {new Date(overview.updatedAt).toLocaleTimeString()}
          </p>
        </div>
      ) : null}
    </section>
  );
}

export default function EnergyDashboardWidget({ meterId }: { meterId: string }) {
  const [range, setRange] = useState<EnergyRange>("5m");
  const { snapshot, connected } = useEnergySnapshot(meterId, range);
  const current = snapshot?.current;

  return (
    <section aria-label="Real-time energy" className="border-y border-white/10 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">Energy flow</h2>
          <span className={`h-2 w-2 rounded-full ${connected ? "bg-emerald-400" : "bg-amber-400"}`} aria-hidden="true" />
          <span className="text-xs text-gray-400" role="status">{connected ? "Live" : "Reconnecting"}</span>
        </div>
        <div role="tablist" aria-label="Energy chart range" className="flex border border-white/15">
          {(["5m", "hourly", "daily"] as const).map((item) => (
            <button
              key={item}
              type="button"
              role="tab"
              aria-selected={range === item}
              className={`min-h-8 px-3 text-xs ${range === item ? "bg-solar-yellow text-solar-dark" : "text-gray-300 hover:bg-white/5"}`}
              onClick={() => setRange(item)}
            >
              {RANGE_LABELS[item]}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3">
        <div>
          <p className="text-xs text-gray-400">Production</p>
          <p className="text-lg font-semibold text-amber-300">{current ? current.productionKwh.toFixed(2) : "--"} <span className="text-xs font-normal">kWh</span></p>
        </div>
        <div>
          <p className="text-xs text-gray-400">Consumption</p>
          <p className="text-lg font-semibold text-cyan-300">{current ? current.consumptionKwh.toFixed(2) : "--"} <span className="text-xs font-normal">kWh</span></p>
        </div>
        <div className="col-span-2 sm:col-span-1">
          <p className="text-xs text-gray-400">Net energy</p>
          <p className="text-lg font-semibold">{current ? (current.productionKwh - current.consumptionKwh).toFixed(2) : "--"} <span className="text-xs font-normal">kWh</span></p>
        </div>
      </div>

      <div className="mt-3 h-52 w-full" aria-label={`${RANGE_LABELS[range]} energy chart`}>
        {snapshot?.points.length ? (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={snapshot.points} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
              <defs>
                <linearGradient id="energyProductionFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#fbbf24" stopOpacity={0.28} />
                  <stop offset="95%" stopColor="#fbbf24" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="energyConsumptionFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#22d3ee" stopOpacity={0.22} />
                  <stop offset="95%" stopColor="#22d3ee" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="#ffffff12" vertical={false} />
              <XAxis dataKey="timestamp" tickFormatter={(value: string) => formatEnergyTick(value, range)} tick={{ fill: "#9ca3af", fontSize: 10 }} minTickGap={24} />
              <YAxis tick={{ fill: "#9ca3af", fontSize: 10 }} width={42} />
              <Tooltip labelFormatter={(value: string) => new Date(value).toLocaleString()} formatter={(value: number) => [`${Number(value).toFixed(2)} kWh`]} />
              <Area type="monotone" dataKey="productionKwh" name="Production" stroke="#fbbf24" strokeWidth={2} fill="url(#energyProductionFill)" isAnimationActive={false} />
              <Area type="monotone" dataKey="consumptionKwh" name="Consumption" stroke="#22d3ee" strokeWidth={2} fill="url(#energyConsumptionFill)" isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-gray-500">Waiting for energy readings</div>
        )}
      </div>
      <p className="mt-1 text-right text-[11px] text-gray-500">
        {snapshot ? `Updated ${new Date(snapshot.updatedAt).toLocaleTimeString()}` : "Loading energy data"}
      </p>
    </section>
  );
}

export function EnergyDashboardWithVpp({ meterId }: { meterId: string }) {
  return (
    <div className="space-y-4">
      <EnergyDashboardWidget meterId={meterId} />
      <VppManagementPortal />
    </div>
  );
}