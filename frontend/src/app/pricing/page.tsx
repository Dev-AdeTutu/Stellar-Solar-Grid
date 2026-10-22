"use client";

import { useCallback, useEffect, useState } from "react";
import Navbar from "@/components/Navbar";
import { env } from "@/lib/env";

const API = env.NEXT_PUBLIC_BACKEND_URL;

type PriceTier = "off-peak" | "standard" | "peak";

type SeasonalRate = {
  season: string;
  startDate: string;
  endDate: string;
  multiplier: number;
};

type SeasonalHistoryEntry = {
  season: string;
  averagePricePerKwh: number;
};

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
  const [currentSeason, setCurrentSeason] = useState<SeasonalRate | null>(null);
  const [seasonalRates, setSeasonalRates] = useState<SeasonalRate[]>([]);
  const [seasonalHistory, setSeasonalHistory] = useState<SeasonalHistoryEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [cur, hist, pred, season, rates, seasonHist] = await Promise.all([
        fetch(`${API}/api/pricing/current`).then((r) => (r.ok ? r.json() : Promise.reject())),
        fetch(`${API}/api/pricing/history?limit=48`).then((r) => (r.ok ? r.json() : Promise.reject())),
        fetch(`${API}/api/pricing/predict?hours=12`).then((r) => (r.ok ? r.json() : Promise.reject())),
        fetch(`${API}/api/pricing/season/current`).then((r) => (r.ok ? r.json() : Promise.reject())),
        fetch(`${API}/api/pricing/season/rates`).then((r) => (r.ok ? r.json() : Promise.reject())),
        fetch(`${API}/api/pricing/season/history`).then((r) => (r.ok ? r.json() : Promise.reject())),
      ]);
      setCurrent(cur);
      setHistory(hist.history ?? []);
      setPredictions(pred.predictions ?? []);
      setCurrentSeason(season ?? null);
      setSeasonalRates(rates.rates ?? []);
      setSeasonalHistory(seasonHist.history ?? []);
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
  const maxSeasonalPrice = Math.max(
    ...seasonalHistory.map((s) => s.averagePricePerKwh),
    0.01
  );

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

        {currentSeason && (
          <section
            aria-label="Current season"
            className="rounded-xl border border-white/10 bg-white/5 p-6 mb-8"
          >
            <div className="flex items-baseline gap-3 mb-2">
              <span className="text-2xl font-semibold capitalize">{currentSeason.season}</span>
              <span className="text-sm opacity-70">
                {currentSeason.multiplier.toFixed(2)}× multiplier
              </span>
            </div>
            <p className="text-xs opacity-60">
              {new Date(currentSeason.startDate).toLocaleDateString()} –{" "}
              {new Date(currentSeason.endDate).toLocaleDateString()}
            </p>
          </section>
        )}

        {seasonalRates.length > 0 && (
          <section aria-label="Seasonal rates" className="mb-8">
            <h2 className="text-lg font-semibold mb-3">Configured Seasons</h2>
            <div className="rounded-xl border border-white/10 bg-white/5 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide opacity-60">
                    <th className="px-4 py-2">Season</th>
                    <th className="px-4 py-2">Start</th>
                    <th className="px-4 py-2">End</th>
                    <th className="px-4 py-2 text-right">Multiplier</th>
                  </tr>
                </thead>
                <tbody>
                  {seasonalRates.map((r) => (
                    <tr
                      key={`${r.season}-${r.startDate}`}
                      className={`border-t border-white/10 ${
                        currentSeason?.season === r.season ? "bg-white/5" : ""
                      }`}
                    >
                      <td className="px-4 py-2 capitalize">{r.season}</td>
                      <td className="px-4 py-2">{new Date(r.startDate).toLocaleDateString()}</td>
                      <td className="px-4 py-2">{new Date(r.endDate).toLocaleDateString()}</td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {r.multiplier.toFixed(2)}×
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {seasonalHistory.length > 0 && (
          <section aria-label="Historical seasonal comparison" className="mb-8">
            <h2 className="text-lg font-semibold mb-3">Historical Seasonal Comparison</h2>
            <div className="rounded-xl border border-white/10 bg-white/5 p-4">
              <div className="space-y-2">
                {seasonalHistory.map((s) => (
                  <div key={s.season} className="flex items-center gap-3 text-sm">
                    <span className="w-24 capitalize opacity-70">{s.season}</span>
                    <div className="flex-1 h-4 rounded-sm bg-white/5 overflow-hidden">
                      <div
                        className="h-full bg-blue-500"
                        style={{
                          width: `${(s.averagePricePerKwh / maxSeasonalPrice) * 100}%`,
                        }}
                      />
                    </div>
                    <span className="w-24 text-right tabular-nums">
                      {s.averagePricePerKwh.toFixed(4)} XLM
                    </span>
                  </div>
                ))}
              </div>
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
