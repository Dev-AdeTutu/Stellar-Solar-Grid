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