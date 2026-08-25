"use client";

import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";

export interface UsageDataPoint {
  /**
   * An ISO 8601 timestamp (e.g. "2026-08-24T06:00:00Z"), or a plain
   * "YYYY-MM-DD" date for day-granularity data. Always rendered in the
   * viewer's local timezone — see `formatTickLocal` / `formatTooltipLocal`.
   */
  date: string;
  /** Energy consumed in kWh */
  units: number;
  /** Cost deducted in XLM (optional) */
  cost?: number;
}

/** True if `value` carries a time-of-day component (not just a calendar date). */
export function hasTimeComponent(value: string): boolean {
  return /T\d{2}:\d{2}/.test(value);
}

/**
 * Format an x-axis tick in the viewer's local timezone.
 * Falls back to the raw value when it isn't a parseable date, so
 * already-formatted or unexpected strings don't crash the chart.
 */
export function formatTickLocal(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return hasTimeComponent(value)
    ? parsed.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : parsed.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * Format a tooltip label with an explicit timezone indicator, so it's clear
 * the time shown is local and not UTC (e.g. "Aug 24, 2:00 PM GMT+3").
 */
export function formatTooltipLocal(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    ...(hasTimeComponent(value) ? { hour: "numeric", minute: "2-digit" } : {}),
    timeZoneName: "short",
  });
}

interface UsageChartProps {
  /** Usage data points. Null/undefined treated as empty — no crash. */
  data?: UsageDataPoint[] | null;
  /** Pass true while the parent is still fetching meter data */
  loading?: boolean;
  meterId?: string;
}

// ── Skeleton ──────────────────────────────────────────────────────────────────
function ChartSkeleton() {
  return (
    <div className="w-full animate-pulse space-y-2">
      {/* Y-axis labels */}
      <div className="flex h-48 gap-3">
        <div className="flex flex-col justify-between py-1">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-2 w-6 rounded bg-white/10" />
          ))}
        </div>
        {/* Chart body */}
        <div className="flex-1 rounded-lg bg-white/5 border border-white/10" />
      </div>
      {/* X-axis labels */}
      <div className="ml-10 flex justify-between">
        {[0, 1, 2, 3, 4, 5, 6].map((i) => (
          <div key={i} className="h-2 w-8 rounded bg-white/10" />
        ))}
      </div>
    </div>
  );
}

// ── Custom tooltip ─────────────────────────────────────────────────────────────
interface TooltipPayload {
  name: string;
  value: number;
  color: string;
}

function CustomTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: TooltipPayload[];
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-xl border border-white/10 bg-[#1a1f2e] px-4 py-3 text-sm shadow-xl">
      <p className="mb-2 font-semibold text-solar-yellow">{label}</p>
      {payload.map((p) => (
        <p key={p.name} style={{ color: p.color }} className="flex gap-2">
          <span className="text-gray-400">{p.name}:</span>
          <span className="font-medium">
            {p.value}
            {p.name === "Usage (kWh)" ? " kWh" : " XLM"}
          </span>
        </p>
      ))}
    </div>
  );
}

// ── Main chart component ───────────────────────────────────────────────────────
import styles from './UsageChart.module.css';

export default function UsageChart({
  data: rawData,
  loading = false,
  meterId,
}: UsageChartProps) {
  // Normalise: null/undefined → empty array so no downstream code can throw
  const data: UsageDataPoint[] = Array.isArray(rawData) ? rawData : [];
  const isEmpty = !loading && data.length === 0;

  return (
    <div className="rounded-xl border border-white/10 bg-solar-accent p-5 space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-white">
          Energy Usage
          {meterId && (
            <span className="ml-2 font-mono text-solar-yellow text-xs">
              {meterId}
            </span>
          )}
        </h2>
        <span className="text-[11px] text-gray-500 uppercase tracking-wider">
          Last 7 days
        </span>
      </div>

      {/* Chart area — minHeight prevents the ResponsiveContainer 0-height flash */}
      <div className={styles.chartContainer}>
        {loading ? (
          <ChartSkeleton />
        ) : isEmpty ? (
          <div
            role="status"
            aria-label="No usage data"
            className="flex h-48 flex-col items-center justify-center gap-2 text-center"
          >
            <span className="text-2xl" aria-hidden="true">📊</span>
            <p className="text-sm text-gray-400 font-medium">No usage data yet</p>
            <p className="text-xs text-gray-600 max-w-xs">
              Data will appear here after your first recorded unit.
            </p>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={192}>
            <LineChart
              data={data}
              margin={{ top: 4, right: 8, left: -20, bottom: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis
                dataKey="date"
                tickFormatter={formatTickLocal}
                tick={{ fill: "#6b7280", fontSize: 11 }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                tick={{ fill: "#6b7280", fontSize: 11 }}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip content={<CustomTooltip />} labelFormatter={formatTooltipLocal} />
              <Legend
                wrapperStyle={{
                  fontSize: "11px",
                  color: "#9ca3af", 
                  paddingTop: "8px"
                }}
              />
              <Line
                type="monotone"
                dataKey="units"
                name="Usage (kWh)"
                stroke="#F5C518"
                strokeWidth={2}
                dot={{ r: 3, fill: "#F5C518", strokeWidth: 0 }}
                activeDot={{ r: 5, fill: "#F5C518" }}
              />
              {data.some((d) => d.cost !== undefined) && (
                <Line
                  type="monotone"
                  dataKey="cost"
                  name="Cost (XLM)"
                  stroke="#818cf8"
                  strokeWidth={2}
                  dot={{ r: 3, fill: "#818cf8", strokeWidth: 0 }}
                  activeDot={{ r: 5, fill: "#818cf8" }}
                />
              )}
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
