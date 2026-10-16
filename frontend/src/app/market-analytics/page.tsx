"use client";

/**
 * P2P energy trading market analytics (#999): average price, volume,
 * liquidity, supply/demand, and a price history chart.
 */
import { useEffect, useState } from "react";
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import Navbar from "@/components/Navbar";
import { env } from "@/lib/env";

const API = env.NEXT_PUBLIC_BACKEND_URL;

type PricePoint = { bucket: string; avgPrice: number; volumeKwh: number; trades: number };
type Analytics = {
  generatedAt: string;
  avgPrice: number | null;
  totalVolumeKwh: number;
  totalVolumeXlm: number;
  tradeCount: number;
  supplyKwh: number;
  demandKwh: number;
  liquidity: number;
  priceHistory: { hourly: PricePoint[]; daily: PricePoint[]; weekly: PricePoint[] };
};

const GRAIN_LABEL = { hourly: "Hourly", daily: "Daily", weekly: "Weekly" } as const;

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-white/10 p-4">
      <div className="text-xs opacity-70">{label}</div>
      <div className="text-xl font-semibold">{value}</div>
    </div>
  );
}

export default function MarketAnalyticsPage() {
  const [data, setData] = useState<Analytics | null>(null);
  const [grain, setGrain] = useState<keyof Analytics["priceHistory"]>("daily");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetch(`${API}/api/market/analytics`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((d) => !cancelled && setData(d))
        .catch((e: Error) => !cancelled && setError(e.message));
    load();
    const interval = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return (
    <>
      <Navbar />
      <main className="p-6 max-w-5xl mx-auto">
        <h1 className="text-2xl font-bold mb-1">Market Analytics</h1>
        <p className="text-sm opacity-70 mb-4">Supply, demand and price trends for the P2P energy market.</p>
        {error && <p className="text-red-500">{error}</p>}

        {data && (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 mb-6">
              <StatTile label="Avg price" value={data.avgPrice !== null ? `${data.avgPrice.toFixed(4)} XLM/kWh` : "—"} />
              <StatTile label="Volume traded" value={`${data.totalVolumeKwh.toLocaleString()} kWh`} />
              <StatTile label="Liquidity" value={`${Math.round(data.liquidity * 100)}%`} />
              <StatTile label="Trades" value={data.tradeCount.toLocaleString()} />
              <StatTile label="Supply (open sell)" value={`${data.supplyKwh.toLocaleString()} kWh`} />
              <StatTile label="Demand (open buy)" value={`${data.demandKwh.toLocaleString()} kWh`} />
            </div>

            <div role="tablist" className="flex gap-2 mb-3">
              {(Object.keys(GRAIN_LABEL) as (keyof Analytics["priceHistory"])[]).map((g) => (
                <button
                  key={g}
                  role="tab"
                  aria-selected={grain === g}
                  className={`rounded px-3 py-1.5 text-sm ${grain === g ? "bg-sky-600 text-white" : "border"}`}
                  onClick={() => setGrain(g)}
                >
                  {GRAIN_LABEL[g]}
                </button>
              ))}
            </div>

            {data.priceHistory[grain].length === 0 ? (
              <p className="text-sm opacity-70">No trades recorded yet.</p>
            ) : (
              <div style={{ width: "100%", height: 300 }}>
                <ResponsiveContainer>
                  <LineChart data={data.priceHistory[grain]}>
                    <XAxis dataKey="bucket" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} width={60} />
                    <Tooltip
                      formatter={(value: number, name: string) => [name === "avgPrice" ? `${value.toFixed(4)} XLM/kWh` : value, name]}
                    />
                    <Line type="monotone" dataKey="avgPrice" stroke="#2a78d6" strokeWidth={2} dot={false} name="Avg price" />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </>
        )}
      </main>
    </>
  );
}
