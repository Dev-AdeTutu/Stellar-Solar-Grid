'use client';

import { useCallback, useEffect, useState } from 'react';

/** 7-day energy forecasting dashboard (#1082). See frontend/FORECASTING.md. */

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001';
const REFRESH_MS = 5 * 60 * 1000;

interface Band {
  value: number;
  lower: number;
  upper: number;
}

interface ForecastDay {
  date: string;
  generation: Band;
  consumption: Band;
  netKwh: number;
  weatherAdjusted: boolean;
  weather?: { cloudCoverPct: number; tempMaxC: number; condition: string };
}

interface ComparisonRow {
  date: string;
  forecastGenerationKwh: number;
  actualGenerationKwh: number;
  forecastConsumptionKwh: number;
  actualConsumptionKwh: number;
}

interface ForecastResponse {
  days: ForecastDay[];
  generatedAt: string;
  comparison: {
    rows: ComparisonRow[];
    accuracy: { generationMapePct: number | null; consumptionMapePct: number | null; intervalCoveragePct: number | null };
  };
}

function BandChart({ title, days, pick, color }: { title: string; days: ForecastDay[]; pick: (d: ForecastDay) => Band; color: string }) {
  const W = 560;
  const H = 200;
  const P = 32;
  const max = Math.max(1, ...days.map((d) => pick(d).upper));
  const x = (i: number) => P + (i * (W - 2 * P)) / Math.max(days.length - 1, 1);
  const y = (v: number) => H - P - (v / max) * (H - 2 * P);
  const upper = days.map((d, i) => `${x(i)},${y(pick(d).upper)}`);
  const lower = days.map((d, i) => `${x(i)},${y(pick(d).lower)}`).reverse();
  const line = days.map((d, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(pick(d).value)}`).join(' ');
  return (
    <figure className="rounded-lg border p-4">
      <figcaption className="mb-2 font-semibold">{title}</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`${title} forecast with 95% confidence interval`}>
        <polygon points={[...upper, ...lower].join(' ')} fill={color} opacity={0.2} />
        <path d={line} fill="none" stroke={color} strokeWidth={2} />
        {days.map((d, i) => (
          <g key={d.date}>
            <circle cx={x(i)} cy={y(pick(d).value)} r={3} fill={color} />
            <text x={x(i)} y={H - 8} fontSize={10} textAnchor="middle">{d.date.slice(5)}</text>
          </g>
        ))}
        <text x={4} y={P} fontSize={10}>{max.toFixed(0)} kWh</text>
      </svg>
    </figure>
  );
}

export default function ForecastingPage() {
  const [meterId, setMeterId] = useState('');
  const [lat, setLat] = useState('');
  const [lon, setLon] = useState('');
  const [data, setData] = useState<ForecastResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!meterId) return;
    setLoading(true);
    setError(null);
    try {
      const qs = lat && lon ? `?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}` : '';
      const res = await fetch(`${API_BASE}/api/forecast-dashboard/${encodeURIComponent(meterId)}${qs}`);
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      setData(await res.json());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [meterId, lat, lon]);

  useEffect(() => {
    if (!data) return;
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, [data, load]);

  const acc = data?.comparison.accuracy;

  return (
    <main className="mx-auto max-w-4xl space-y-6 p-6">
      <h1 className="text-2xl font-bold">Energy Forecast (7 days)</h1>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          load();
        }}
      >
        <input className="rounded border px-2 py-1" placeholder="Meter ID" value={meterId} onChange={(e) => setMeterId(e.target.value)} required />
        <input className="w-28 rounded border px-2 py-1" placeholder="Latitude" value={lat} onChange={(e) => setLat(e.target.value)} />
        <input className="w-28 rounded border px-2 py-1" placeholder="Longitude" value={lon} onChange={(e) => setLon(e.target.value)} />
        <button className="rounded bg-yellow-500 px-4 py-1 font-semibold text-black" disabled={loading}>
          {loading ? 'Loading…' : 'Forecast'}
        </button>
      </form>
      {error && <p role="alert" className="text-red-600">{error}</p>}
      {data && (
        <>
          <p className="text-sm text-gray-500">Updated {new Date(data.generatedAt).toLocaleString()} · shaded area = 95% confidence interval</p>
          <div className="grid gap-4 md:grid-cols-2">
            <BandChart title="Solar generation" days={data.days} pick={(d) => d.generation} color="#eab308" />
            <BandChart title="Consumption" days={data.days} pick={(d) => d.consumption} color="#3b82f6" />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left">
                  <th>Date</th><th>Generation (kWh)</th><th>Consumption (kWh)</th><th>Net</th><th>Weather</th>
                </tr>
              </thead>
              <tbody>
                {data.days.map((d) => (
                  <tr key={d.date} className="border-t">
                    <td>{d.date}</td>
                    <td>{d.generation.value} ({d.generation.lower}–{d.generation.upper})</td>
                    <td>{d.consumption.value} ({d.consumption.lower}–{d.consumption.upper})</td>
                    <td className={d.netKwh >= 0 ? 'text-green-600' : 'text-red-600'}>{d.netKwh}</td>
                    <td>{d.weather ? `${d.weather.condition}, ${d.weather.cloudCoverPct}% cloud` : 'baseline'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <section>
            <h2 className="mb-2 text-lg font-semibold">Forecast vs actual</h2>
            {data.comparison.rows.length === 0 ? (
              <p className="text-sm text-gray-500">No actuals recorded for forecast days yet.</p>
            ) : (
              <>
                <p className="text-sm">
                  Generation MAPE: {acc?.generationMapePct ?? '—'}% · Consumption MAPE: {acc?.consumptionMapePct ?? '—'}% · Within interval: {acc?.intervalCoveragePct ?? '—'}%
                </p>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left"><th>Date</th><th>Gen forecast / actual</th><th>Use forecast / actual</th></tr>
                  </thead>
                  <tbody>
                    {data.comparison.rows.map((r) => (
                      <tr key={r.date} className="border-t">
                        <td>{r.date}</td>
                        <td>{r.forecastGenerationKwh} / {r.actualGenerationKwh}</td>
                        <td>{r.forecastConsumptionKwh} / {r.actualConsumptionKwh}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </section>
        </>
      )}
    </main>
  );
}
