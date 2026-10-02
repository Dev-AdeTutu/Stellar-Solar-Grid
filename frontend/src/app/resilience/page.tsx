"use client";

import { useCallback, useEffect, useState } from "react";
import Navbar from "@/components/Navbar";
import { env } from "@/lib/env";

const API = env.NEXT_PUBLIC_BACKEND_URL;

type Severity = "low" | "medium" | "high" | "critical";
type Metrics = Record<"availability" | "uptime" | "reliability" | "latency" | "redundancy", number>;
type Resilience = {
  score: number;
  grade: string;
  metrics: Metrics;
  meterCount: number;
  vulnerabilities: { id: string; severity: Severity; metric: string; message: string }[];
  recommendations: { vulnerabilityId: string; priority: Severity; action: string }[];
  computedAt: string;
};
type History = { points: { at: string; score: number }[]; trend: string; change: number };

const SEVERITY: Record<Severity, string> = {
  critical: "bg-red-900/40 border-red-600/50 text-red-300",
  high: "bg-orange-900/30 border-orange-600/40 text-orange-300",
  medium: "bg-yellow-900/30 border-yellow-700/40 text-yellow-300",
  low: "bg-blue-900/30 border-blue-700/40 text-blue-300",
};

const scoreColor = (s: number) => (s >= 75 ? "text-green-400" : s >= 50 ? "text-yellow-300" : "text-red-400");

export default function ResiliencePage() {
  const [data, setData] = useState<Resilience | null>(null);
  const [history, setHistory] = useState<History | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [cur, hist] = await Promise.all([
        fetch(`${API}/api/grid/resilience`).then((r) => (r.ok ? r.json() : Promise.reject())),
        fetch(`${API}/api/grid/resilience/history?limit=96`).then((r) => (r.ok ? r.json() : Promise.reject())),
      ]);
      setData(cur);
      setHistory(hist);
      setError(null);
    } catch {
      setError("Failed to load resilience data");
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, [load]);

  return (
    <>
      <Navbar />
      <main className="p-6 max-w-5xl mx-auto">
        <h1 className="text-2xl font-bold mb-1">Grid Resilience</h1>
        <p className="opacity-60 text-sm mb-6">Live resilience score from meter availability, uptime, reliability, latency and redundancy.</p>
        {error && <p className="text-red-400 mb-4">{error}</p>}

        {data && (
          <>
            <section className="grid grid-cols-2 md:grid-cols-6 gap-3 mb-8">
              <div className="col-span-2 rounded-xl border border-white/10 bg-white/5 p-4">
                <div className="text-xs uppercase tracking-wide opacity-60">Resilience score</div>
                <div className={`text-4xl font-bold mt-1 tabular-nums ${scoreColor(data.score)}`}>
                  {data.score}<span className="text-lg opacity-60">/100 · {data.grade}</span>
                </div>
                <div className="text-xs opacity-50 mt-1">{data.meterCount} meters · {new Date(data.computedAt).toLocaleTimeString()}</div>
              </div>
              {Object.entries(data.metrics).map(([k, v]) => (
                <div key={k} className="rounded-xl border border-white/10 bg-white/5 p-4">
                  <div className="text-xs uppercase tracking-wide opacity-60">{k}</div>
                  <div className={`text-2xl font-semibold mt-1 tabular-nums ${scoreColor(v)}`}>{v}</div>
                </div>
              ))}
            </section>

            {history && history.points.length > 0 && (
              <section className="mb-8">
                <h2 className="text-lg font-semibold mb-2">
                  Historical trend <span className="text-sm opacity-60">({history.trend}, {history.change >= 0 ? "+" : ""}{history.change})</span>
                </h2>
                <div className="flex items-end gap-px h-32 rounded-xl border border-white/10 bg-white/5 p-2" role="img" aria-label="Resilience score history">
                  {history.points.map((p) => (
                    <div
                      key={p.at}
                      title={`${new Date(p.at).toLocaleString()}: ${p.score}`}
                      className={`flex-1 rounded-t ${p.score >= 75 ? "bg-green-500/70" : p.score >= 50 ? "bg-yellow-500/70" : "bg-red-500/70"}`}
                      style={{ height: `${Math.max(2, p.score)}%` }}
                    />
                  ))}
                </div>
              </section>
            )}

            <section className="grid md:grid-cols-2 gap-6">
              <div>
                <h2 className="text-lg font-semibold mb-2">Vulnerabilities</h2>
                {data.vulnerabilities.length === 0 && <p className="opacity-60 text-sm">No vulnerabilities detected.</p>}
                <ul className="space-y-2">
                  {data.vulnerabilities.map((v) => (
                    <li key={v.id} className={`rounded-lg border p-3 text-sm ${SEVERITY[v.severity]}`}>
                      <span className="uppercase text-xs font-semibold mr-2">{v.severity}</span>
                      {v.message}
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <h2 className="text-lg font-semibold mb-2">Recommendations</h2>
                {data.recommendations.length === 0 && <p className="opacity-60 text-sm">Grid is operating resiliently.</p>}
                <ol className="space-y-2 list-decimal list-inside text-sm">
                  {data.recommendations.map((r) => (
                    <li key={r.vulnerabilityId} className="rounded-lg border border-white/10 bg-white/5 p-3">{r.action}</li>
                  ))}
                </ol>
              </div>
            </section>
          </>
        )}
      </main>
    </>
  );
}
