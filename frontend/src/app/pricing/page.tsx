"use client";

import { useCallback, useEffect, useState } from "react";
import Navbar from "@/components/Navbar";
import { env } from "@/lib/env";

const API = env.NEXT_PUBLIC_BACKEND_URL;

type PriceTier = "off-peak" | "standard" | "peak";

type PricePoint = {
  timestamp: string;
  pricePerKwh: number;
  tier: PriceTier;
  supplyKwh: number;
  demandKwh: number;
  supplyDemandRatio: number;
};

const TIER_COLORS: Record<PriceTier, string> = {
  "off-peak": "text-green-400",
  standard: "text-yellow-300",
  peak: "text-red-400",
};

const TIER_BG: Record<PriceTier, string> = {
  "off-peak": "bg-green-900/30 border-green-700/40",
  standard: "bg-yellow-900/30 border-yellow-700/40",
  peak: "bg-red-900/30 border-red-700/40",
};

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/5 p-4">
      <div className="text-xs uppercase tracking-wide opacity-60">{label}</div>
      <div className="text-2xl font-semibold mt-1 tabular-nums">{value}</div>
      {sub && <div className="text-xs opacity-50 mt-1">{sub}</div>}
    </div>
  );
}

export default function PricingPage() {
  const [current, setCurrent] = useState<PricePoint | null>(null);
  const [history, setHistory] = useState<PricePoint[]>([]);
  const [predictions, setPredictions] = useState<PricePoint[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [cur, hist, pred] = await Promise.all([
        fetch(`${API}/api/pricing/current`).then((r) => (r.ok ? r.json() : Promise.reject())),
        fetch(`${API}/api/pricing/history?limit=48`).then((r) => (r.ok ? r.json() : Promise.reject())),
        fetch(`${API}/api/pricing/predict?hours=12`).then((r) => (r.ok ? r.json() : Promise.reject())),
      ]);
      setCurrent(cur);
      setHistory(hist.history ?? []);
      setPredictions(pred.predictions ?? []);
      setError(null);
    } catch {
      setError("Failed to load pricing data");
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 15 * 60 * 1000);
    return () => clearInterval(id);
  }, [load]);

  const maxPrice = Math.max(...history.map((p) => p.pricePerKwh), 0.01);

  return (
    <>
      <Navbar />
      <main className="p-6 max-w-5xl mx-auto">
        <h1 className="text-2xl font-bold mb-1">Dynamic Energy Pricing</h1>
        <p className="opacity-60 text-sm mb-6">
          Prices adjust every 15 minutes based on supply, demand, and time of day.
        </p>

        {error && <p className="text-red-400 mb-4">{error}</p>}

        {current && (
          <section aria-label="Current price" className={`rounded-xl border p-6 mb-8 ${TIER_BG[current.tier]}`}>
            <div className="flex items-baseline gap-3 mb-2">
              <span className={`text-4xl font-bold tabular-nums ${TIER_COLORS[current.tier]}`}>
                {current.pricePerKwh.toFixed(4)} XLM
              </span>
              <span className="text-lg opacity-70">/ kWh</span>
              <span className={`ml-2 text-sm font-medium capitalize ${TIER_COLORS[current.tier]}`}>
                {current.tier}
              </span>
            </div>
            <p className="text-xs opacity-60">
              Updated {new Date(current.timestamp).toLocaleTimeString()}
            </p>
            <div className="grid grid-cols-3 gap-4 mt-4">
              <StatCard label="Supply" value={`${current.supplyKwh} kWh`} />
              <StatCard label="Demand" value={`${current.demandKwh} kWh`} />
              <StatCard
                label="Supply/Demand"
                value={current.supplyDemandRatio.toFixed(2)}
                sub={current.supplyDemandRatio >= 1 ? "Supply surplus" : "Demand pressure"}
              />
            </div>
          </section>
        )}

        {history.length > 0 && (
          <section aria-label="Price history" className="mb-8">
            <h2 className="text-lg font-semibold mb-3">Recent Price History</h2>
            <div className="rounded-xl border border-white/10 bg-white/5 p-4 overflow-x-auto">
              <div className="flex items-end gap-1 h-24 min-w-[480px]">
                {history.map((p) => (
                  <div
                    key={p.timestamp}
                    title={`${p.pricePerKwh.toFixed(4)} XLM @ ${new Date(p.timestamp).toLocaleTimeString()} (${p.tier})`}
                    style={{ height: `${(p.pricePerKwh / maxPrice) * 100}%` }}
                    className={`flex-1 rounded-sm min-h-[2px] ${
                      p.tier === "peak"
                        ? "bg-red-500"
                        : p.tier === "off-peak"
                          ? "bg-green-500"
                          : "bg-yellow-400"
                    }`}
                  />
                ))}
              </div>
              <div className="flex justify-between text-xs opacity-50 mt-1">
                <span>{history[0] ? new Date(history[0].timestamp).toLocaleDateString() : ""}</span>
                <span>Now</span>
              </div>
            </div>
          </section>
        )}

        {predictions.length > 0 && (
          <section aria-label="Price predictions">
            <h2 className="text-lg font-semibold mb-3">12-Hour Price Forecast</h2>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {predictions.slice(0, 12).map((p) => (
                <div
                  key={p.timestamp}
                  className={`rounded-lg border p-3 text-sm ${TIER_BG[p.tier]}`}
                >
                  <div className="opacity-60 text-xs">
                    {new Date(p.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </div>
                  <div className={`font-semibold tabular-nums ${TIER_COLORS[p.tier]}`}>
                    {p.pricePerKwh.toFixed(4)}
                  </div>
                  <div className={`text-xs capitalize ${TIER_COLORS[p.tier]}`}>{p.tier}</div>
                </div>
              ))}
            </div>
          </section>
        )}
      </main>
    </>
  );
}
