"use client";

import React, { useMemo } from "react";
import type { UsageDataPoint } from "./UsageChart";

export interface UsageForecastProps {
  meterId: string;
  balance: bigint | number;
  history?: UsageDataPoint[] | null;
  loading?: boolean;
}

export default function UsageForecast({
  meterId,
  balance,
  history,
  loading = false,
}: UsageForecastProps) {
  const balanceXlm = typeof balance === "bigint" ? Number(balance) / 1e7 : balance;

  const forecast = useMemo(() => {
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

  if (loading) {
    return (
      <div className="rounded-xl border border-white/10 bg-solar-dark/60 p-4 animate-pulse space-y-2">
        <div className="h-3 w-28 bg-white/10 rounded" />
        <div className="h-5 w-48 bg-white/10 rounded" />
      </div>
    );
  }

  return (
    <div
      className={`rounded-xl border p-4 space-y-2 transition ${
        forecast.status === "ready" && forecast.isLow
          ? "border-red-500/40 bg-red-950/20"
          : "border-white/10 bg-solar-dark/50"
      }`}
      aria-label={`Usage forecast for meter ${meterId}`}
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-gray-400 font-semibold">
          <span aria-hidden="true">🔮</span>
          <span>Usage Forecast</span>
        </div>
        {forecast.status === "ready" && forecast.isLow && (
          <span className="inline-flex items-center gap-1 rounded-full border border-red-500/40 bg-red-900/40 px-2 py-0.5 text-[11px] font-semibold text-red-300">
            <span aria-hidden="true">⚠️</span> Low Balance
          </span>
        )}
      </div>

      {/* Main estimate display */}
      {forecast.status === "insufficient_data" && (
        <div>
          <p className="text-sm font-semibold text-gray-300">{forecast.message}</p>
          <p className="text-xs text-gray-500 mt-0.5">{forecast.detail}</p>
        </div>
      )}

      {forecast.status === "zero_usage" && (
        <div>
          <p className="text-base font-bold text-green-400">{forecast.message}</p>
          <p className="text-xs text-gray-400 mt-0.5">{forecast.detail}</p>
        </div>
      )}

      {forecast.status === "ready" && (
        <div className="space-y-1.5">
          {forecast.isVariable && forecast.minDays !== forecast.maxDays ? (
            <div>
              <p
                className={`text-base font-bold ${
                  forecast.isLow ? "text-red-400" : "text-solar-yellow"
                }`}
              >
                {forecast.minDays}–{forecast.maxDays} days remaining
              </p>
              <p className="text-xs text-gray-400">
                Based on fluctuating 7-day usage (avg ~{forecast.roundedDays} days, ±{forecast.confidenceDays}d)
              </p>
            </div>
          ) : (
            <div>
              <p
                className={`text-base font-bold ${
                  forecast.isLow ? "text-red-400" : "text-solar-yellow"
                }`}
              >
                ~{forecast.roundedDays} {forecast.roundedDays === 1 ? "day" : "days"} remaining at current usage
              </p>
              <p className="text-xs text-gray-400">
                Confidence: ±1 day based on 7-day average daily burn
              </p>
            </div>
          )}

          {forecast.isLow && (
            <div className="rounded-lg border border-red-500/30 bg-red-900/20 px-2.5 py-1.5 text-xs text-red-300 flex items-center gap-1.5 mt-2">
              <span aria-hidden="true">⚠️</span>
              <span>Less than 2 days remaining. Top up soon to prevent service interruption.</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
