'use client';

import { useState } from 'react';

/** Energy storage optimization dashboard (#1053). See backend/AI_OPTIMIZATION.md. */

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001';

interface StepResult {
  hour: number;
  action: 'charge' | 'discharge' | 'idle';
  socKwh: number;
  gridImportKwh: number;
  cost: number;
}

interface Plan {
  schedule: StepResult[];
  totalCost: number;
  baselineCost: number;
  savings: number;
  gridIndependence: number;
}

const sampleDay = Array.from({ length: 24 }, (_, hour) => ({
  hour,
  pricePerKwh: hour >= 17 && hour <= 21 ? 0.4 : hour < 6 ? 0.08 : 0.15,
  solarKwh: hour >= 9 && hour <= 15 ? 2 : 0,
  loadKwh: hour >= 17 && hour <= 21 ? 3 : 1,
}));

export default function StorageOptimizationPage() {
  const [capacityKwh, setCapacityKwh] = useState(10);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const run = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/storage-optimization/plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          battery: { capacityKwh, maxRateKw: capacityKwh / 2, efficiency: 0.95, socKwh: 0 },
          day: sampleDay,
          episodes: 2000,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setPlan(body);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="mx-auto max-w-4xl p-6 space-y-6">
      <h1 className="text-2xl font-bold">Battery Optimization</h1>
      <div className="flex items-end gap-3">
        <label className="flex flex-col text-sm">
          Battery capacity (kWh)
          <input type="number" min={1} value={capacityKwh} onChange={(e) => setCapacityKwh(Number(e.target.value))} className="rounded border px-2 py-1" />
        </label>
        <button onClick={run} disabled={loading} className="rounded bg-yellow-500 px-4 py-2 text-black disabled:opacity-50">
          {loading ? 'Training…' : 'Optimize'}
        </button>
      </div>
      {error && <p className="text-red-600">{error}</p>}
      {plan && (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label="Savings" value={`$${plan.savings.toFixed(2)}`} />
            <Stat label="Optimized cost" value={`$${plan.totalCost.toFixed(2)}`} />
            <Stat label="Baseline cost" value={`$${plan.baselineCost.toFixed(2)}`} />
            <Stat label="Grid independence" value={`${Math.round(plan.gridIndependence * 100)}%`} />
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left"><th>Hour</th><th>Action</th><th>SoC (kWh)</th><th>Grid import (kWh)</th><th>Cost</th></tr>
            </thead>
            <tbody>
              {plan.schedule.map((s) => (
                <tr key={s.hour} className="border-t">
                  <td>{s.hour}:00</td><td className="capitalize">{s.action}</td><td>{s.socKwh}</td><td>{s.gridImportKwh}</td><td>${s.cost.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border p-3">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-xl font-semibold">{value}</div>
    </div>
  );
}
