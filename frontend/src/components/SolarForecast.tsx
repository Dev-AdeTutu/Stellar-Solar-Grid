"use client";

import { useState } from "react";
import { env } from "@/lib/env";

// ── Types ──────────────────────────────────────────────────────────────────

interface ForecastPeriod {
  period: string;
  days: number;
  estimatedKwh: number;
  estimatedRevenue: number;
}

interface ForecastResult {
  panelCapacityKw: number;
  peakSunHours: number;
  efficiency: number;
  panelAgeYears: number;
  effectiveDegradation: number;
  dailyKwh: number;
  forecast: ForecastPeriod[];
  assumptions: {
    systemLoss: number;
    degradationRatePerYear: number;
    ratePerKwh: number;
  };
}

interface IrradianceZone {
  name: string;
  peakSunHours: number;
}

// ── Constants ──────────────────────────────────────────────────────────────

const API_BASE = env.NEXT_PUBLIC_API_URL;

const PERIOD_ICONS: Record<string, string> = {
  daily: "☀️",
  weekly: "📅",
  monthly: "🗓️",
  yearly: "📊",
};

// ── Sub-components ─────────────────────────────────────────────────────────

function ForecastCard({ period }: { period: ForecastPeriod }) {
  return (
    <div className="rounded-xl border border-white/10 bg-solar-dark p-4 flex flex-col gap-1">
      <div className="flex items-center gap-1.5 text-xs text-gray-400 uppercase tracking-wide font-medium">
        <span aria-hidden="true">{PERIOD_ICONS[period.period] ?? "⚡"}</span>
        {period.period}
      </div>
      <p className="text-xl font-bold text-solar-yellow">
        {period.estimatedKwh.toLocaleString()} <span className="text-sm font-normal text-gray-400">kWh</span>
      </p>
      <p className="text-sm text-gray-400">
        ≈ <span className="text-white font-semibold">{period.estimatedRevenue.toFixed(2)}</span> XLM
      </p>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────

export default function SolarForecast() {
  // Form state
  const [capacityKw, setCapacityKw] = useState("5");
  const [peakSunHours, setPeakSunHours] = useState("5.5");
  const [efficiency, setEfficiency] = useState("0.20");
  const [panelAgeYears, setPanelAgeYears] = useState("0");
  const [ratePerKwh, setRatePerKwh] = useState("0.12");

  // Async state
  const [result, setResult] = useState<ForecastResult | null>(null);
  const [zones, setZones] = useState<IrradianceZone[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [zonesLoaded, setZonesLoaded] = useState(false);

  // Load irradiance zones lazily on first focus of peakSunHours field
  async function loadZones() {
    if (zonesLoaded) return;
    try {
      const res = await fetch(`${API_BASE}/api/solar/irradiance-zones`);
      if (res.ok) {
        const data = await res.json();
        setZones(data.zones ?? []);
      }
    } catch {
      // non-critical, silently ignore
    } finally {
      setZonesLoaded(true);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const params = new URLSearchParams({
        capacityKw,
        peakSunHours,
        efficiency,
        panelAgeYears,
        ratePerKwh,
      });

      const res = await fetch(`${API_BASE}/api/solar/forecast?${params}`);
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error ?? `Request failed (${res.status})`);
      }

      setResult(data as ForecastResult);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section aria-labelledby="solar-forecast-title" className="w-full max-w-2xl mx-auto space-y-6">

      {/* Header */}
      <div>
        <h2 id="solar-forecast-title" className="text-xl font-bold text-white flex items-center gap-2">
          <span aria-hidden="true">🌞</span> Solar Production Forecast
        </h2>
        <p className="mt-1 text-sm text-gray-400">
          Estimate daily, weekly, monthly and yearly kWh output and XLM revenue for your solar installation.
        </p>
      </div>

      {/* Form */}
      <form
        onSubmit={handleSubmit}
        className="rounded-2xl border border-white/10 bg-solar-accent p-5 space-y-4"
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">

          {/* Panel capacity */}
          <div className="flex flex-col gap-1.5">
            <label htmlFor="capacityKw" className="text-xs font-medium text-gray-300">
              Panel capacity (kW) <span className="text-red-400" aria-hidden="true">*</span>
            </label>
            <input
              id="capacityKw"
              type="number"
              min="0.1"
              step="0.1"
              required
              value={capacityKw}
              onChange={(e) => setCapacityKw(e.target.value)}
              className="rounded-lg border border-white/10 bg-solar-dark px-3 py-2 text-sm text-white placeholder-gray-600 focus:border-solar-yellow focus:outline-none transition"
              placeholder="e.g. 5"
            />
          </div>

          {/* Peak sun hours with zone picker */}
          <div className="flex flex-col gap-1.5">
            <label htmlFor="peakSunHours" className="text-xs font-medium text-gray-300">
              Peak sun hours / day <span className="text-red-400" aria-hidden="true">*</span>
            </label>
            <div className="flex gap-2">
              <input
                id="peakSunHours"
                type="number"
                min="0.1"
                max="24"
                step="0.1"
                required
                value={peakSunHours}
                onChange={(e) => setPeakSunHours(e.target.value)}
                onFocus={loadZones}
                className="flex-1 rounded-lg border border-white/10 bg-solar-dark px-3 py-2 text-sm text-white placeholder-gray-600 focus:border-solar-yellow focus:outline-none transition"
                placeholder="e.g. 5.5"
              />
              {zones.length > 0 && (
                <select
                  aria-label="Pick from climate zone"
                  onChange={(e) => e.target.value && setPeakSunHours(e.target.value)}
                  defaultValue=""
                  className="rounded-lg border border-white/10 bg-solar-dark px-2 py-2 text-xs text-gray-400 focus:border-solar-yellow focus:outline-none transition"
                >
                  <option value="" disabled>Zone</option>
                  {zones.map((z) => (
                    <option key={z.name} value={String(z.peakSunHours)}>
                      {z.peakSunHours}h — {z.name.split("(")[0].trim()}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </div>

          {/* Efficiency */}
          <div className="flex flex-col gap-1.5">
            <label htmlFor="efficiency" className="text-xs font-medium text-gray-300">
              Panel efficiency (0–1)
            </label>
            <input
              id="efficiency"
              type="number"
              min="0.01"
              max="1"
              step="0.01"
              value={efficiency}
              onChange={(e) => setEfficiency(e.target.value)}
              className="rounded-lg border border-white/10 bg-solar-dark px-3 py-2 text-sm text-white placeholder-gray-600 focus:border-solar-yellow focus:outline-none transition"
              placeholder="0.20"
            />
            <p className="text-xs text-gray-600">Typical mono-PERC panels: 0.20–0.23</p>
          </div>

          {/* Panel age */}
          <div className="flex flex-col gap-1.5">
            <label htmlFor="panelAgeYears" className="text-xs font-medium text-gray-300">
              Panel age (years)
            </label>
            <input
              id="panelAgeYears"
              type="number"
              min="0"
              max="40"
              step="1"
              value={panelAgeYears}
              onChange={(e) => setPanelAgeYears(e.target.value)}
              className="rounded-lg border border-white/10 bg-solar-dark px-3 py-2 text-sm text-white placeholder-gray-600 focus:border-solar-yellow focus:outline-none transition"
              placeholder="0"
            />
          </div>

          {/* Rate per kWh */}
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <label htmlFor="ratePerKwh" className="text-xs font-medium text-gray-300">
              Revenue rate (XLM / kWh)
            </label>
            <input
              id="ratePerKwh"
              type="number"
              min="0"
              step="0.001"
              value={ratePerKwh}
              onChange={(e) => setRatePerKwh(e.target.value)}
              className="w-full sm:w-1/2 rounded-lg border border-white/10 bg-solar-dark px-3 py-2 text-sm text-white placeholder-gray-600 focus:border-solar-yellow focus:outline-none transition"
              placeholder="0.12"
            />
          </div>
        </div>

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-lg bg-solar-yellow py-3 text-sm font-semibold text-solar-dark transition hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
        >
          {loading ? (
            <>
              <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
              </svg>
              Calculating…
            </>
          ) : (
            "Calculate forecast"
          )}
        </button>
      </form>

      {/* Error */}
      {error && (
        <div
          role="alert"
          className="rounded-lg border border-red-500/30 bg-red-900/20 px-4 py-3 text-sm text-red-300"
        >
          ✕ {error}
        </div>
      )}

      {/* Results */}
      {result && (
        <div className="space-y-4" aria-live="polite">

          {/* Summary bar */}
          <div className="rounded-xl border border-solar-yellow/30 bg-solar-yellow/5 px-5 py-4 flex flex-wrap gap-6">
            <div>
              <p className="text-xs text-gray-400">Daily output</p>
              <p className="text-2xl font-bold text-solar-yellow">
                {result.dailyKwh} <span className="text-sm font-normal text-gray-400">kWh</span>
              </p>
            </div>
            {result.effectiveDegradation > 0 && (
              <div>
                <p className="text-xs text-gray-400">Panel degradation</p>
                <p className="text-lg font-semibold text-orange-400">
                  −{result.effectiveDegradation}%
                </p>
              </div>
            )}
            <div>
              <p className="text-xs text-gray-400">System loss applied</p>
              <p className="text-lg font-semibold text-white">
                {((1 - result.assumptions.systemLoss) * 100).toFixed(0)}%
              </p>
            </div>
          </div>

          {/* Period cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {result.forecast.map((p) => (
              <ForecastCard key={p.period} period={p} />
            ))}
          </div>

          {/* Assumptions */}
          <details className="rounded-xl border border-white/10 bg-solar-dark text-xs text-gray-500">
            <summary className="cursor-pointer px-4 py-3 text-gray-400 hover:text-white transition select-none">
              View assumptions
            </summary>
            <ul className="px-4 pb-4 pt-1 space-y-1">
              <li>Capacity: <span className="text-gray-300">{result.panelCapacityKw} kW</span></li>
              <li>Peak sun hours: <span className="text-gray-300">{result.peakSunHours} h/day</span></li>
              <li>Panel efficiency: <span className="text-gray-300">{(result.efficiency * 100).toFixed(0)}%</span></li>
              <li>System losses (inverter, wiring, soiling): <span className="text-gray-300">{((1 - result.assumptions.systemLoss) * 100).toFixed(0)}%</span></li>
              <li>Annual degradation rate: <span className="text-gray-300">{(result.assumptions.degradationRatePerYear * 100).toFixed(1)}%/yr</span></li>
              <li>Revenue rate: <span className="text-gray-300">{result.assumptions.ratePerKwh} XLM/kWh</span></li>
            </ul>
          </details>
        </div>
      )}
    </section>
  );
}
