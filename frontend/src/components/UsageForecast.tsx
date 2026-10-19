"use client";

import React, { useEffect, useMemo, useState } from "react";
import type { UsageDataPoint } from "./UsageChart";

export interface ForecastDay {
  date: string;
  predictedUsage: number;
  lowerBound: number;
  upperBound: number;
  predictedSolar: number;
  temperature: number;
  cloudCover: number;
}

export interface ForecastResponse {
  meterId: string;
  horizonDays: number;
  generatedAt?: string;
  days: ForecastDay[];
  willRunOutOfCredit: boolean;
  depletionDate?: string | null;
  daysUntilDepletion?: number | null;
}

export interface UsageForecastProps {
  meterId: string;
  balance: bigint | number;
  history?: UsageDataPoint[] | null;
  loading?: boolean;
  /** Optional pre-fetched forecast; when omitted the component fetches it. */
  forecast?: ForecastResponse | null;
  /** Optional fetch override (useful for tests). */
  fetchForecast?: (meterId: string) => Promise<ForecastResponse>;
}

const DEFAULT_API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";

async function defaultFetchForecast(meterId: string): Promise<ForecastResponse> {
  const res = await fetch(
    `${DEFAULT_API_BASE}/api/meters/${encodeURIComponent(meterId)}/forecast`,
    { headers: { Accept: "application/json" } },
  );
  if (!res.ok) {
    throw new Error(`Forecast request failed (${res.status})`);
  }
  return (await res.json()) as ForecastResponse;
}

const CHART_WIDTH = 560;
const CHART_HEIGHT = 180;
const PADDING = { top: 12, right: 12, bottom: 28, left: 36 };

function buildPath(points: Array<{ x: number; y: number }>): string {
  return points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ");
}

export default function UsageForecast({
  meterId,
  balance,
  history,
  loading = false,
  forecast: forecastProp,
  fetchForecast,
}: UsageForecastProps) {
  const balanceXlm = typeof balance === "bigint" ? Number(balance) / 1e7 : balance;

  const [fetched, setFetched] = useState<ForecastResponse | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [isFetching, setIsFetching] = useState(false);

  useEffect(() => {
    if (forecastProp !== undefined && forecastProp !== null) return;
    let cancelled = false;
    const loader = fetchForecast ?? defaultFetchForecast;

    setIsFetching(true);
    setFetchError(null);
    loader(meterId)
      .then((data) => {
        if (!cancelled) setFetched(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setFetchError(err instanceof Error ? err.message : "Failed to load forecast");
        }
      })
      .finally(() => {
        if (!cancelled) setIsFetching(false);
      });

    return () => {
      cancelled = true;
    };
  }, [meterId, forecastProp, fetchForecast]);

  const forecast = forecastProp ?? fetched;

  // Local fallback estimate derived from history when no API forecast is available.
  const fallback = useMemo(() => {
    const data = history ?? [];
    if (data.length < 7) {
      return {
        status: "insufficient_data" as const,
        message: "Not enough data yet",
        detail: "Requires at least 7 days of usage data to forecast.",
      };
    }

    // Extract daily consumption (cost in XLM if available, otherwise units in kWh)
    const dailyValues = data.slice(-7).map((d) => d.cost ?? d.units);
    const totalUsage = dailyValues.reduce((sum, v) => sum + v, 0);
    const avgDailyUsage = totalUsage / dailyValues.length;

    if (avgDailyUsage <= 0) {
      return {
        status: "zero_usage" as const,
        message: "Unlimited at current usage",
        detail: "Zero energy consumption recorded over the past 7 days.",
        avgDailyUsage: 0,
      };
    }

    const daysRemaining = balanceXlm / avgDailyUsage;
    const roundedDays = Math.round(daysRemaining);

    // Calculate variance / standard deviation
    const variance =
      dailyValues.reduce((acc, val) => acc + Math.pow(val - avgDailyUsage, 2), 0) /
      dailyValues.length;
    const stdDev = Math.sqrt(variance);
    const cv = avgDailyUsage > 0 ? stdDev / avgDailyUsage : 0; // Coefficient of variation

    const isVariable = cv > 0.25;
    const minDaily = Math.min(...dailyValues.filter((v) => v > 0));
    const maxDaily = Math.max(...dailyValues);

    const minDays = maxDaily > 0 ? Math.floor(balanceXlm / maxDaily) : roundedDays;
    const maxDays = minDaily > 0 ? Math.ceil(balanceXlm / minDaily) : roundedDays;

    const confidenceDays = Math.max(1, Math.round((stdDev / avgDailyUsage) * daysRemaining));

    return {
      status: "ready" as const,
      avgDailyUsage,
      daysRemaining,
      roundedDays,
      isVariable,
      minDays,
      maxDays,
      confidenceDays,
      isLow: daysRemaining < 2,
    };
  }, [balanceXlm, history]);

  const chart = useMemo(() => {
    if (!forecast || !forecast.days || forecast.days.length === 0) return null;

    const days = forecast.days;
    const innerWidth = CHART_WIDTH - PADDING.left - PADDING.right;
    const innerHeight = CHART_HEIGHT - PADDING.top - PADDING.bottom;

    const maxY = Math.max(
      ...days.map((d) => Math.max(d.upperBound, d.predictedUsage, d.predictedSolar)),
      0.0001,
    );
    const minY = 0;

    const xFor = (i: number) =>
      PADDING.left + (days.length === 1 ? innerWidth / 2 : (i / (days.length - 1)) * innerWidth);
    const yFor = (v: number) =>
      PADDING.top + innerHeight - ((v - minY) / (maxY - minY)) * innerHeight;

    const usagePoints = days.map((d, i) => ({ x: xFor(i), y: yFor(d.predictedUsage) }));
    const solarPoints = days.map((d, i) => ({ x: xFor(i), y: yFor(d.predictedSolar) }));

    const bandTop = days.map((d, i) => ({ x: xFor(i), y: yFor(d.upperBound) }));
    const bandBottom = days.map((d, i) => ({ x: xFor(i), y: yFor(d.lowerBound) }));
    const bandPath = `${buildPath(bandTop)} L${bandBottom[bandBottom.length - 1].x.toFixed(2)},${bandBottom[
      bandBottom.length - 1
    ].y.toFixed(2)} ${bandBottom
      .slice()
      .reverse()
      .map((p) => `L${p.x.toFixed(2)},${p.y.toFixed(2)}`)
      .join(" ")} Z`;

    return {
      days,
      xFor,
      yFor,
      maxY,
      usagePath: buildPath(usagePoints),
      solarPath: buildPath(solarPoints),
      bandPath,
      usagePoints,
      solarPoints,
    };
  }, [forecast]);

  if (loading || isFetching) {
    return (
      <div className="rounded-xl border border-white/10 bg-solar-dark/60 p-4 animate-pulse space-y-2">
        <div className="h-3 w-28 bg-white/10 rounded" />
        <div className="h-5 w-48 bg-white/10 rounded" />
      </div>
    );
  }

  const willRunOut = Boolean(forecast?.willRunOutOfCredit);

  return (
    <div
      className={`rounded-xl border p-4 space-y-3 transition ${
        willRunOut || (fallback.status === "ready" && fallback.isLow)
          ? "border-red-500/40 bg-red-950/20"
          : "border-white/10 bg-solar-dark/50"
      }`}
      aria-label={`Usage forecast for meter ${meterId}`}
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-gray-400 font-semibold">
          <span aria-hidden="true">🔮</span>
          <span>7-Day Weather Forecast</span>
        </div>
        {willRunOut && (
          <span className="inline-flex items-center gap-1 rounded-full border border-red-500/40 bg-red-900/40 px-2 py-0.5 text-[11px] font-semibold text-red-300">
            <span aria-hidden="true">⚠️</span> Credit Depletion
          </span>
        )}
      </div>

      {/* Credit depletion alert */}
      {willRunOut && (
        <div
          role="alert"
          className="rounded-lg border border-red-500/50 bg-red-900/30 px-3 py-2 text-sm text-red-200 flex items-start gap-2"
        >
          <span aria-hidden="true" className="text-base leading-none">⚠️</span>
          <div>
            <p className="font-semibold">Predicted to run out of credit</p>
            <p className="text-xs text-red-300 mt-0.5">
              {forecast?.daysUntilDepletion != null
                ? `Estimated depletion in ~${forecast.daysUntilDepletion} day${
                    forecast.daysUntilDepletion === 1 ? "" : "s"
                  }`
                : "Depletion expected within the forecast horizon"}
              {forecast?.depletionDate ? ` (${forecast.depletionDate})` : ""}. Top up soon to avoid
              service interruption.
            </p>
          </div>
        </div>
      )}

      {/* Fetch error */}
      {fetchError && !forecast && (
        <p className="text-xs text-amber-400">
          Could not load weather forecast ({fetchError}). Showing local estimate.
        </p>
      )}

      {/* Weather-based chart */}
      {chart && (
        <div className="space-y-2">
          <svg
            role="img"
            aria-label="Predicted daily usage with confidence bands and solar generation"
            viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
            className="w-full h-auto"
          >
            {/* Confidence band */}
            <path d={chart.bandPath} fill="rgba(250, 204, 21, 0.15)" stroke="none" />

            {/* Usage prediction line */}
            <path
              d={chart.usagePath}
              fill="none"
              stroke="#facc15"
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />

            {/* Solar generation line */}
            <path
              d={chart.solarPath}
              fill="none"
              stroke="#38bdf8"
              strokeWidth={1.5}
              strokeDasharray="4 3"
              strokeLinejoin="round"
              strokeLinecap="round"
            />

            {/* Data points */}
            {chart.usagePoints.map((p, i) => (
              <circle key={`u-${i}`} cx={p.x} cy={p.y} r={2.5} fill="#facc15" />
            ))}
            {chart.solarPoints.map((p, i) => (
              <circle key={`s-${i}`} cx={p.x} cy={p.y} r={2} fill="#38bdf8" />
            ))}

            {/* X-axis day labels */}
            {chart.days.map((d, i) => (
              <text
                key={`label-${i}`}
                x={chart.xFor(i)}
                y={CHART_HEIGHT - 8}
                textAnchor="middle"
                className="fill-gray-500"
                fontSize={9}
              >
                {d.date.slice(5)}
              </text>
            ))}
          </svg>

          <div className="flex flex-wrap items-center gap-3 text-[11px] text-gray-400">
            <span className="inline-flex items-center gap-1">
              <span className="inline-block w-3 h-0.5 bg-solar-yellow" aria-hidden="true" />
              Predicted usage
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="inline-block w-3 h-2 bg-solar-yellow/20 border border-solar-yellow/30" aria-hidden="true" />
              Confidence band
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="inline-block w-3 h-0.5 bg-sky-400" aria-hidden="true" />
              Solar generation
            </span>
          </div>

          {/* Per-day weather inputs */}
          <div className="overflow-x-auto">
            <table className="w-full text-[11px] text-gray-400">
              <thead>
                <tr className="text-gray-500">
                  <th className="text-left font-medium py-1 pr-2">Day</th>
                  <th className="text-right font-medium py-1 px-2">Temp</th>
                  <th className="text-right font-medium py-1 px-2">Cloud</th>
                  <th className="text-right font-medium py-1 pl-2">Usage</th>
                </tr>
              </thead>
              <tbody>
                {chart.days.map((d, i) => (
                  <tr key={`row-${i}`} className="border-t border-white/5">
                    <td className="py-1 pr-2">{d.date.slice(5)}</td>
                    <td className="py-1 px-2 text-right">{Math.round(d.temperature)}°C</td>
                    <td className="py-1 px-2 text-right">{Math.round(d.cloudCover)}%</td>
                    <td className="py-1 pl-2 text-right text-solar-yellow">
                      {d.predictedUsage.toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Fallback estimate when no API forecast is available */}
      {!chart && (
        <>
          {fallback.status === "insufficient_data" && (
            <div>
              <p className="text-sm font-semibold text-gray-300">{fallback.message}</p>
              <p className="text-xs text-gray-500 mt-0.5">{fallback.detail}</p>
            </div>
          )}

          {fallback.status === "zero_usage" && (
            <div>
              <p className="text-base font-bold text-green-400">{fallback.message}</p>
              <p className="text-xs text-gray-400 mt-0.5">{fallback.detail}</p>
            </div>
          )}

          {fallback.status === "ready" && (
            <div className="space-y-1.5">
              {fallback.isVariable && fallback.minDays !== fallback.maxDays ? (
                <div>
                  <p
                    className={`text-base font-bold ${
                      fallback.isLow ? "text-red-400" : "text-solar-yellow"
                    }`}
                  >
                    {fallback.minDays}–{fallback.maxDays} days remaining
                  </p>
                  <p className="text-xs text-gray-400">
                    Based on fluctuating 7-day usage (avg ~{fallback.roundedDays} days, ±
                    {fallback.confidenceDays}d)
                  </p>
                </div>
              ) : (
                <div>
                  <p
                    className={`text-base font-bold ${
                      fallback.isLow ? "text-red-400" : "text-solar-yellow"
                    }`}
                  >
                    ~{fallback.roundedDays} {fallback.roundedDays === 1 ? "day" : "days"} remaining at
                    current usage
                  </p>
                  <p className="text-xs text-gray-400">
                    Confidence: ±1 day based on 7-day average daily burn
                  </p>
                </div>
              )}

              {fallback.isLow && (
                <div className="rounded-lg border border-red-500/30 bg-red-900/20 px-2.5 py-1.5 text-xs text-red-300 flex items-center gap-1.5 mt-2">
                  <span aria-hidden="true">⚠️</span>
                  <span>Less than 2 days remaining. Top up soon to prevent service interruption.</span>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
