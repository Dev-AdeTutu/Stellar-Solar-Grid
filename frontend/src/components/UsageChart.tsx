import { useEffect, useMemo, useState } from "react";
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
import styles from "./UsageChart.module.css";

export interface UsageDataPoint {
  /** An ISO 8601 timestamp or a plain YYYY-MM-DD calendar date. */
  date: string;
  /** Energy consumed in kWh. */
  units: number;
  /** Cost deducted in XLM (optional). */
  cost?: number;
}

export type ComparisonPeriod = "week" | "month" | "custom";

type ComparisonDataPoint = UsageDataPoint & {
  previousUnits: number | null;
  previousCost?: number | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** Matches the "< 768px" mobile viewport described in issue #760. */
export const MOBILE_BREAKPOINT_PX = 768;

/** True when `width` is narrower than the mobile breakpoint. */
export function isMobileWidth(width: number): boolean {
  return width < MOBILE_BREAKPOINT_PX;
}

/**
 * How many x-axis ticks recharts should skip between labels. On mobile this
 * thins a dataset down to ~5 visible labels so rotated text doesn't overlap;
 * on desktop every tick is shown. The underlying data series is unaffected —
 * only which x-axis labels are drawn (closes #760).
 */
export function computeXAxisTickInterval(dataLength: number, isMobile: boolean): number {
  if (!isMobile) return 0;
  return Math.max(0, Math.ceil(dataLength / 5) - 1);
}

/**
 * True when the viewport is narrower than MOBILE_BREAKPOINT_PX. Uses
 * window.innerWidth + a resize listener rather than matchMedia so it works
 * without extra polyfills in the jsdom test environment (closes #760).
 */
function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== "undefined" && isMobileWidth(window.innerWidth),
  );

  useEffect(() => {
    function handleResize() {
      setIsMobile(isMobileWidth(window.innerWidth));
    }
    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  return isMobile;
}

/** True if `value` carries a time-of-day component. */
export function hasTimeComponent(value: string): boolean {
  return /T\d{2}:\d{2}/.test(value);
}

function parseDate(value: string): Date {
  if (hasTimeComponent(value)) return new Date(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match
    ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
    : new Date(value);
}

function dateKey(value: string): string | null {
  const date = parseDate(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

function formatDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Format an x-axis tick in the viewer's local timezone. Falls back to the raw
 * value when it is not a parseable date.
 */
export function formatTickLocal(value: string): string {
  const parsed = parseDate(value);
  if (Number.isNaN(parsed.getTime())) return value;

  return hasTimeComponent(value)
    ? parsed.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : parsed.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Format a tooltip label with an explicit timezone indicator. */
export function formatTooltipLocal(value: string): string {
  const parsed = parseDate(value);
  if (Number.isNaN(parsed.getTime())) return value;

  return parsed.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    ...(hasTimeComponent(value) ? { hour: "numeric", minute: "2-digit" } : {}),
    timeZoneName: "short",
  });
}

interface UsageChartProps {
  /** Usage data points. Null/undefined are treated as empty. */
  data?: UsageDataPoint[] | null;
  /** Pass true while the parent is fetching meter data. */
  loading?: boolean;
  meterId?: string;
}

function ChartSkeleton() {
  return (
    <div className="w-full animate-pulse space-y-2">
      <div className="flex h-48 gap-3">
        <div className="flex flex-col justify-between py-1">
          {[0, 1, 2, 3].map((i) => <div key={i} className="h-2 w-6 rounded bg-white/10" />)}
        </div>
        <div className="flex-1 rounded-lg border border-white/10 bg-white/5" />
      </div>
      <div className="ml-10 flex justify-between">
        {[0, 1, 2, 3, 4, 5, 6].map((i) => <div key={i} className="h-2 w-8 rounded bg-white/10" />)}
      </div>
    </div>
  );
}

interface TooltipPayload {
  name: string;
  value: number | null;
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
      {payload.map((point) => (
        <p key={point.name} style={{ color: point.color }} className="flex gap-2">
          <span className="text-gray-400">{point.name}:</span>
          <span className="font-medium">
            {point.value == null ? "—" : point.value}
            {point.name.toLowerCase().includes("usage") ? " kWh" : " XLM"}
          </span>
        </p>
      ))}
    </div>
  );
}

function periodLength(period: ComparisonPeriod, customStart: string, customEnd: string): number {
  if (period === "week") return 7;
  if (period === "month") return 30;
  const start = parseDate(customStart).getTime();
  const end = parseDate(customEnd).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 7;
  return Math.floor((end - start) / DAY_MS) + 1;
}

function buildComparisonData(
  data: UsageDataPoint[],
  period: ComparisonPeriod,
  customStart: string,
  customEnd: string,
): ComparisonDataPoint[] {
  const valid = data
    .map((point) => ({ point, key: dateKey(point.date), time: parseDate(point.date).getTime() }))
    .filter((item): item is { point: UsageDataPoint; key: string; time: number } =>
      item.key !== null && Number.isFinite(item.time),
    );
  if (valid.length === 0) return [];

  if (period === "custom") {
    const customStartTime = parseDate(customStart).getTime();
    const customEndTime = parseDate(customEnd).getTime();
    if (!Number.isFinite(customStartTime) || !Number.isFinite(customEndTime) || customEndTime < customStartTime) {
      return [];
    }
  }

  const length = periodLength(period, customStart, customEnd);
  const anchor = period === "custom" ? parseDate(customEnd) : new Date(Math.max(...valid.map((item) => item.time)));
  const currentEnd = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate()));
  const currentStart = period === "custom"
    ? parseDate(customStart)
    : addDays(currentEnd, -(length - 1));
  const previousStart = addDays(currentStart, -length);

  const currentByDay = new Map<string, UsageDataPoint>();
  const previousByDay = new Map<string, UsageDataPoint>();
  for (const item of valid) {
    if (item.key >= formatDateKey(currentStart) && item.key <= formatDateKey(currentEnd)) {
      const existing = currentByDay.get(item.key);
      currentByDay.set(item.key, existing
        ? { ...existing, units: existing.units + item.point.units, cost: (existing.cost ?? 0) + (item.point.cost ?? 0) }
        : item.point);
    }
    const previousEnd = addDays(currentStart, -1);
    if (item.key >= formatDateKey(previousStart) && item.key <= formatDateKey(previousEnd)) {
      const existing = previousByDay.get(item.key);
      previousByDay.set(item.key, existing
        ? { ...existing, units: existing.units + item.point.units, cost: (existing.cost ?? 0) + (item.point.cost ?? 0) }
        : item.point);
    }
  }

  return Array.from({ length }, (_, index) => {
    const currentDate = addDays(currentStart, index);
    const currentKey = formatDateKey(currentDate);
    const previousKey = formatDateKey(addDays(previousStart, index));
    const current = currentByDay.get(currentKey);
    const previous = previousByDay.get(previousKey);
    return {
      date: currentKey,
      units: current?.units ?? 0,
      cost: current?.cost,
      previousUnits: previous?.units ?? null,
      previousCost: previous?.cost ?? null,
    };
  });
}

function periodLabel(period: ComparisonPeriod): string {
  return period === "week" ? "7-day" : period === "month" ? "30-day" : "custom-range";
}

export function UsageChart({ data: rawData, loading = false, meterId }: UsageChartProps) {
  const data: UsageDataPoint[] = useMemo(
    () => (Array.isArray(rawData) ? rawData : []),
    [rawData],
  );
  const [compareEnabled, setCompareEnabled] = useState(false);
  const [period, setPeriod] = useState<ComparisonPeriod>("week");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const isEmpty = !loading && data.length === 0;
  const isMobile = useIsMobile();

  const comparisonData = useMemo(
    () => buildComparisonData(data, period, customStart, customEnd),
    [data, period, customStart, customEnd],
  );
  const chartData = compareEnabled ? comparisonData : data;
  const xAxisTickInterval = computeXAxisTickInterval(chartData.length, isMobile);
  const currentTotal = compareEnabled ? comparisonData.reduce((sum, point) => sum + point.units, 0) : data.reduce((sum, point) => sum + point.units, 0);
  const previousTotal = compareEnabled ? comparisonData.reduce((sum, point) => sum + (point.previousUnits ?? 0), 0) : 0;
  const differencePercent = previousTotal > 0 ? ((currentTotal - previousTotal) / previousTotal) * 100 : null;

  // Derived flags + a memoized chart subtree (#736).
  //
  // We pass the CustomTooltip *component reference* (not a fresh `<CustomTooltip />`
  // element) and memoize the whole `LineChart` so an unchanged dataset produces a
  // stable element graph. This stops Recharts from tearing down/rebuilding its
  // DOM + ResizeObserver listeners on every parent re-render, keeping old chart
  // instances garbage-collectable instead of accumulating as detached trees.
  const showCost = data.some((point) => point.cost !== undefined);
  const showPrevCost =
    compareEnabled &&
    comparisonData.some((point) => point.cost !== undefined || point.previousCost !== null);

  const chart = useMemo(
    () => (
      <LineChart data={chartData} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
        <XAxis dataKey="date" tickFormatter={formatTickLocal} tick={{ fill: "#6b7280", fontSize: 11 }} axisLine={false} tickLine={false} />
        <YAxis tick={{ fill: "#6b7280", fontSize: 11 }} axisLine={false} tickLine={false} />
        <Tooltip content={<CustomTooltip />} labelFormatter={formatTooltipLocal} />
        <Legend wrapperStyle={{ fontSize: "11px", color: "#9ca3af", paddingTop: "8px" }} />
        <Line type="monotone" dataKey="units" name="Usage (kWh)" stroke="#F5C518" strokeWidth={2} dot={{ r: 3, fill: "#F5C518", strokeWidth: 0 }} activeDot={{ r: 5, fill: "#F5C518" }} connectNulls={false} />
        {compareEnabled && <Line type="monotone" dataKey="previousUnits" name="Previous period (kWh)" stroke="#38bdf8" strokeWidth={2} strokeDasharray="5 5" dot={{ r: 2, fill: "#38bdf8", strokeWidth: 0 }} activeDot={{ r: 4, fill: "#38bdf8" }} connectNulls={false} />}
        {!compareEnabled && showCost && <Line type="monotone" dataKey="cost" name="Cost (XLM)" stroke="#818cf8" strokeWidth={2} dot={{ r: 3, fill: "#818cf8", strokeWidth: 0 }} activeDot={{ r: 5, fill: "#818cf8" }} />}
        {showPrevCost && <Line type="monotone" dataKey="cost" name="Cost (XLM)" stroke="#818cf8" strokeWidth={2} dot={{ r: 2, fill: "#818cf8", strokeWidth: 0 }} />}
      </LineChart>
    ),
    [chartData, compareEnabled, showCost, showPrevCost],
  );

  return (
    <div className="space-y-3 rounded-xl border border-white/10 bg-solar-accent p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-white">
          Energy Usage
          {meterId && <span className="ml-2 font-mono text-xs text-solar-yellow">{meterId}</span>}
        </h2>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-[11px] text-gray-400">
            <input
              type="checkbox"
              checked={compareEnabled}
              onChange={(event) => setCompareEnabled(event.target.checked)}
              aria-label="Compare with previous period"
              className="accent-solar-yellow"
            />
            Compare with previous period
          </label>
          <span className="text-[11px] uppercase tracking-wider text-gray-500">
            {compareEnabled ? periodLabel(period) : "Last 7 days"}
          </span>
        </div>
      </div>

      {compareEnabled && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-gray-400">
          <label htmlFor="usage-comparison-period">Compare by</label>
          <select
            id="usage-comparison-period"
            value={period}
            onChange={(event) => setPeriod(event.target.value as ComparisonPeriod)}
            className="rounded border border-white/10 bg-white/5 px-2 py-1 text-gray-200"
          >
            <option value="week">Week</option>
            <option value="month">Month</option>
            <option value="custom">Custom range</option>
          </select>
          {period === "custom" && (
            <>
              <label htmlFor="usage-comparison-start">From</label>
              <input id="usage-comparison-start" type="date" value={customStart} onChange={(event) => setCustomStart(event.target.value)} className="rounded border border-white/10 bg-white/5 px-2 py-1 text-gray-200" />
              <label htmlFor="usage-comparison-end">To</label>
              <input id="usage-comparison-end" type="date" value={customEnd} onChange={(event) => setCustomEnd(event.target.value)} className="rounded border border-white/10 bg-white/5 px-2 py-1 text-gray-200" />
            </>
          )}
          {differencePercent !== null && (
            <span className={differencePercent >= 0 ? "text-amber-300" : "text-emerald-300"}>
              {differencePercent >= 0 ? "+" : ""}{differencePercent.toFixed(1)}% vs previous
            </span>
          )}
        </div>
      )}

      <div className={styles.chartContainer}>
        {loading ? (
          <ChartSkeleton />
        ) : isEmpty ? (
          <div role="status" aria-label="No usage data" className="flex h-48 flex-col items-center justify-center gap-2 text-center">
            <span className="text-2xl" aria-hidden="true">📊</span>
            <p className="font-medium text-sm text-gray-400">No usage data yet</p>
            <p className="max-w-xs text-xs text-gray-600">Data will appear here after your first recorded unit.</p>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={isMobile ? 220 : 192}>
            <LineChart
              data={chartData}
              margin={{ top: 4, right: 8, left: -20, bottom: isMobile ? 24 : 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis
                dataKey="date"
                tickFormatter={formatTickLocal}
                tick={{ fill: "#6b7280", fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                interval={xAxisTickInterval}
                angle={isMobile ? -45 : 0}
                textAnchor={isMobile ? "end" : "middle"}
                height={isMobile ? 44 : 30}
              />
              <YAxis tick={{ fill: "#6b7280", fontSize: 11 }} axisLine={false} tickLine={false} />
              <Tooltip
                content={<CustomTooltip />}
                labelFormatter={formatTooltipLocal}
                trigger={isMobile ? "click" : "hover"}
              />
              <Legend wrapperStyle={{ fontSize: "11px", color: "#9ca3af", paddingTop: "8px" }} />
              <Line type="monotone" dataKey="units" name="Usage (kWh)" stroke="#F5C518" strokeWidth={2} dot={{ r: 3, fill: "#F5C518", strokeWidth: 0 }} activeDot={{ r: isMobile ? 7 : 5, fill: "#F5C518" }} connectNulls={false} />
              {compareEnabled && <Line type="monotone" dataKey="previousUnits" name="Previous period (kWh)" stroke="#38bdf8" strokeWidth={2} strokeDasharray="5 5" dot={{ r: 2, fill: "#38bdf8", strokeWidth: 0 }} activeDot={{ r: isMobile ? 6 : 4, fill: "#38bdf8" }} connectNulls={false} />}
              {!compareEnabled && data.some((point) => point.cost !== undefined) && <Line type="monotone" dataKey="cost" name="Cost (XLM)" stroke="#818cf8" strokeWidth={2} dot={{ r: 3, fill: "#818cf8", strokeWidth: 0 }} activeDot={{ r: isMobile ? 7 : 5, fill: "#818cf8" }} />}
              {compareEnabled && comparisonData.some((point) => point.cost !== undefined || point.previousCost !== null) && <Line type="monotone" dataKey="cost" name="Cost (XLM)" stroke="#818cf8" strokeWidth={2} dot={{ r: 2, fill: "#818cf8", strokeWidth: 0 }} />}
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

// #736 — memoize the whole chart so it only re-renders when its props (data,
// loading, meterId) actually change. The dashboard re-renders MeterCard on
// every balance poll; without memo this rebuilds the Recharts tree each tick
// and old chart instances are never released, so memory climbs unbounded.
export default memo(UsageChart);
