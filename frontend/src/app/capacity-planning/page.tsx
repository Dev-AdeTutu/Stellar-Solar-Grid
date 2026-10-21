'use client';

import { useCallback, useEffect, useState } from 'react';

/** Predictive grid capacity planning dashboard (#1050). See docs/CAPACITY_PLANNING.md. */

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001';
const SCENARIOS = ['conservative', 'baseline', 'aggressive'] as const;

interface Forecast {
  region: string;
  capacityKw: number;
  bottleneckInMonths: number | null;
  projections: { monthOffset: number; peakKw: number; utilization: number }[];
}

interface Recommendation {
  region: string;
  priority: string;
  additionalKw: number;
  estimatedCost: number;
  reason: string;
}

export default function CapacityPlanningPage() {
  const [scenario, setScenario] = useState<(typeof SCENARIOS)[number]>('baseline');
  const [data, setData] = useState<{ forecasts: Forecast[]; recommendations: Recommendation[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/capacity-planning?scenario=${scenario}&horizon=24`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [scenario]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main className="mx-auto max-w-5xl p-6 space-y-6">
      <h1 className="text-2xl font-bold">Grid Capacity Planning</h1>
      <div className="flex gap-2">
        {SCENARIOS.map((s) => (
          <button
            key={s}
            onClick={() => setScenario(s)}
            className={`rounded px-3 py-1 capitalize ${s === scenario ? 'bg-yellow-500 text-black' : 'bg-gray-200'}`}
          >
            {s}
          </button>
        ))}
      </div>
      {error && <p className="text-red-600">{error}</p>}

      <section>
        <h2 className="text-lg font-semibold mb-2">Regions</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left">
              <th>Region</th><th>Capacity (kW)</th><th>Peak in 12 mo (kW)</th><th>Utilization in 12 mo</th><th>Bottleneck</th>
            </tr>
          </thead>
          <tbody>
            {data?.forecasts.map((f) => {
              const p = f.projections[Math.min(11, f.projections.length - 1)];
              return (
                <tr key={f.region} className="border-t">
                  <td>{f.region}</td>
                  <td>{f.capacityKw}</td>
                  <td>{p?.peakKw ?? '—'}</td>
                  <td>{p ? `${Math.round(p.utilization * 100)}%` : '—'}</td>
                  <td>{f.bottleneckInMonths === null ? 'None' : `${f.bottleneckInMonths} mo`}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-2">Investment recommendations</h2>
        {data?.recommendations.length === 0 && <p>No bottlenecks projected.</p>}
        <ul className="space-y-2">
          {data?.recommendations.map((r) => (
            <li key={r.region} className="rounded border p-3">
              <strong className="capitalize">{r.priority}</strong> — {r.region}: add {r.additionalKw} kW (~$
              {r.estimatedCost.toLocaleString()})
              <p className="text-gray-600">{r.reason}</p>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
