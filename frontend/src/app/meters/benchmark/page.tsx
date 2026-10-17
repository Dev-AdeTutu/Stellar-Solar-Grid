"use client";

import { useState } from "react";
import Navbar from "@/components/Navbar";
import { useToast } from "@/components/ToastProvider";
import { env } from "@/lib/env";

const API = env.NEXT_PUBLIC_BACKEND_URL;

type BenchmarkData = {
  meterId: string;
  meter: {
    meterId: string;
    capacityWatts: number;
    capacityTier: string;
    locationType: string;
    avgDailyUsageKwh: number;
    efficiencyRatio: number;
    uptimePercent: number;
    performanceScore: number;
  };
  peerGroup: {
    capacityTier: string;
    locationType: string;
    meterCount: number;
    avgDailyUsageKwh: number;
    avgEfficiencyRatio: number;
    avgUptimePercent: number;
    avgScore: number;
  };
  percentileRank: number;
  insights: string[];
};

export default function MeterBenchmarkPage() {
  const { showToast } = useToast();
  const [meterId, setMeterId] = useState("");
  const [data, setData] = useState<BenchmarkData | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSearch() {
    if (!meterId.trim()) {
      return showToast({ title: "Enter a meter ID", variant: "error" });
    }
    setLoading(true);
    try {
      const res = await fetch(`${API}/api/meters/${encodeURIComponent(meterId.trim())}/benchmark`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to fetch benchmark comparison");
      setData(json);
    } catch (err: any) {
      showToast({ title: "Benchmark lookup failed", description: err.message, variant: "error" });
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <Navbar />
      <main className="p-6 max-w-5xl mx-auto">
        <h1 className="text-2xl font-bold mb-1">Meter Performance Benchmarking</h1>
        <p className="opacity-60 text-sm mb-6">
          Compare solar meter generation efficiency, uptime, and usage metrics against installations in the same capacity and location tier.
        </p>

        <div className="flex gap-3 mb-8">
          <input
            type="text"
            value={meterId}
            onChange={(e) => setMeterId(e.target.value)}
            placeholder="Enter Meter ID (e.g. MTR_001)"
            className="flex-1 max-w-md rounded-lg border border-white/20 bg-transparent px-3 py-2 text-sm"
          />
          <button
            onClick={handleSearch}
            disabled={loading}
            className="rounded-lg bg-yellow-500 hover:bg-yellow-400 text-black font-medium px-5 py-2 text-sm disabled:opacity-50"
          >
            {loading ? "Benchmarking..." : "Compare Performance"}
          </button>
        </div>

        {data && (
          <div className="space-y-6">
            {/* Top Score Banner */}
            <div className="rounded-xl border border-white/10 bg-white/5 p-6 flex flex-col md:flex-row items-center justify-between gap-6">
              <div className="flex items-center gap-6">
                <div className="relative w-28 h-28 rounded-full border-4 border-yellow-500/80 flex flex-col items-center justify-center bg-black/30">
                  <span className="text-3xl font-bold">{data.meter.performanceScore}</span>
                  <span className="text-[10px] uppercase opacity-70">Score / 100</span>
                </div>
                <div>
                  <h2 className="text-xl font-bold">Meter {data.meterId}</h2>
                  <p className="text-sm opacity-70 mt-1">
                    Peer Group: <span className="font-semibold capitalize">{data.meter.capacityTier.replace("_", " ")}</span> • <span className="capitalize">{data.meter.locationType}</span> ({data.peerGroup.meterCount} meters)
                  </p>
                  <p className="text-xs text-yellow-400 mt-2 font-medium">
                    🏆 Ranked in top {100 - data.percentileRank}% (Percentile Rank: {data.percentileRank}th)
                  </p>
                </div>
              </div>

              <div className="text-right">
                <div className="text-xs uppercase opacity-60">Peer Group Average</div>
                <div className="text-2xl font-bold tabular-nums text-white/80">{data.peerGroup.avgScore} / 100</div>
              </div>
            </div>

            {/* Metrics Comparison Grid */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="rounded-xl border border-white/10 bg-white/5 p-5">
                <div className="text-xs uppercase tracking-wide opacity-60 mb-2">Efficiency Ratio</div>
                <div className="text-2xl font-bold mb-1">{(data.meter.efficiencyRatio * 100).toFixed(0)}%</div>
                <div className="text-xs opacity-70">
                  Peer Avg: {(data.peerGroup.avgEfficiencyRatio * 100).toFixed(0)}%
                </div>
                <div className="mt-3 text-xs text-emerald-400 font-medium">
                  {data.meter.efficiencyRatio >= data.peerGroup.avgEfficiencyRatio ? "Above average efficiency" : "Potential room for improvement"}
                </div>
              </div>

              <div className="rounded-xl border border-white/10 bg-white/5 p-5">
                <div className="text-xs uppercase tracking-wide opacity-60 mb-2">Uptime Reliability</div>
                <div className="text-2xl font-bold mb-1">{data.meter.uptimePercent.toFixed(1)}%</div>
                <div className="text-xs opacity-70">
                  Peer Avg: {data.peerGroup.avgUptimePercent.toFixed(1)}%
                </div>
                <div className="mt-3 text-xs text-emerald-400 font-medium">
                  {data.meter.uptimePercent >= data.peerGroup.avgUptimePercent ? "High connection reliability" : "Intermittent connectivity detected"}
                </div>
              </div>

              <div className="rounded-xl border border-white/10 bg-white/5 p-5">
                <div className="text-xs uppercase tracking-wide opacity-60 mb-2">Avg Daily Generation</div>
                <div className="text-2xl font-bold mb-1">{data.meter.avgDailyUsageKwh.toFixed(1)} kWh</div>
                <div className="text-xs opacity-70">
                  Peer Avg: {data.peerGroup.avgDailyUsageKwh.toFixed(1)} kWh
                </div>
                <div className="mt-3 text-xs text-emerald-400 font-medium">
                  Rated Capacity: {data.meter.capacityWatts} W
                </div>
              </div>
            </div>

            {/* Insights Section */}
            {data.insights.length > 0 && (
              <div className="rounded-xl border border-white/10 bg-white/5 p-6">
                <h3 className="text-lg font-semibold mb-3">Performance Insights</h3>
                <ul className="space-y-2 text-sm opacity-80 list-disc pl-5">
                  {data.insights.map((insight, idx) => (
                    <li key={idx}>{insight}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </main>
    </>
  );
}
