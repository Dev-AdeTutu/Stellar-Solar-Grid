"use client";

/**
 * Energy trading analytics dashboard (#873): price trend with forecast,
 * traded volume, intraday pattern, top meters and market insights for the
 * last 7, 30 or 90 days, with CSV/PDF export.
 */
import { useEffect, useState } from "react";
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import Navbar from "@/components/Navbar";
import {
  RANGES,
  exportUrl,
  fetchMarketAnalytics,
  formatChange,
  formatKwh,
  formatPrice,
  formatXlm,
  priceSeries,
  type MarketAnalytics,
  type Range,
} from "@/lib/marketAnalytics";

// Chart tokens: validated categorical slots 1-2 with their own dark steps.
const TOKENS = `
.viz-root {
  --series-1: #2a78d6; --series-2: #eb6834; --band: rgba(42,120,214,0.15);
  --grid: #e1e0d9; --axis: #898781; --tooltip-bg: #fcfcfb; --tooltip-ink: #0b0b0b;
}
:root[data-theme="dark"] .viz-root, :root:not([data-theme]) .viz-root {
  --series-1: #3987e5; --series-2: #d95926; --band: rgba(57,135,229,0.18);
  --grid: #2c2c2a; --axis: #898781; --tooltip-bg: #1a1a19; --tooltip-ink: #ffffff;
}`;

const TOOLTIP_STYLE = {
  background: "var(--tooltip-bg)",
  color: "var(--tooltip-ink)",
  border: "1px solid var(--grid)",
  borderRadius: 6,
  fontSize: 12,
};
const AXIS = { stroke: "var(--axis)", fontSize: 11, tickLine: false } as const;
const shortDate = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
const xlmTick = (v: number) => (v / 10_000_000).toLocaleString(undefined, { maximumSignificantDigits: 3 });

function StatTile({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="rounded-lg border border-white/10 p-4">
      <p className="text-xs opacity-60">{label}</p>
      <p className="mt-1 text-2xl font-bold">{value}</p>
      {detail && <p className="mt-1 text-xs opacity-70">{detail}</p>}
    </div>
  );
}

function ChartCard({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-white/10 p-4" aria-label={title}>
      <h2 className="font-semibold">{title}</h2>
      {subtitle && <p className="mb-2 text-xs opacity-60">{subtitle}</p>}
      <div className="h-64">{children}</div>
    </section>
  );
}

export default function AnalyticsPage() {
  const [range, setRange] = useState<Range>("30d");
  const [meterInput, setMeterInput] = useState("");
  const [meterId, setMeterId] = useState("");
  const [data, setData] = useState<MarketAnalytics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showTable, setShowTable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchMarketAnalytics(range, meterId)
      .then((d) => !cancelled && setData(d))
      .catch((e: Error) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [range, meterId]);

  const s = data?.summary;

  return (
    <>
      <Navbar />
      <style>{TOKENS}</style>
      <main className="viz-root mx-auto max-w-6xl p-6">
        <h1 className="mb-1 text-2xl font-bold">Energy trading analytics</h1>
        <p className="mb-4 text-sm opacity-70">
          Traded volume, volume-weighted prices and market trends across the grid. Times are UTC.
        </p>

        {/* Filters: one row above the charts */}
        <div className="mb-6 flex flex-wrap items-end gap-3">
          <div role="group" aria-label="Time range" className="flex overflow-hidden rounded border border-white/20">
            {RANGES.map((r) => (
              <button
                key={r}
                type="button"
                aria-pressed={range === r}
                onClick={() => setRange(r)}
                className={`px-3 py-1.5 text-sm ${range === r ? "bg-sky-600 text-white" : "hover:bg-white/5"}`}
              >
                {r.replace("d", " days")}
              </button>
            ))}
          </div>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              setMeterId(meterInput.trim());
            }}
          >
            <label htmlFor="analytics-meter" className="sr-only">Meter filter</label>
            <input
              id="analytics-meter"
              className="rounded border bg-transparent px-3 py-1.5 text-sm"
              placeholder="All meters"
              value={meterInput}
              onChange={(e) => setMeterInput(e.target.value)}
            />
            <button type="submit" className="rounded border border-white/20 px-3 py-1.5 text-sm">Apply</button>
          </form>
          <div className="ml-auto flex gap-2">
            <a href={exportUrl(range, "csv", meterId)} className="rounded border border-white/20 px-3 py-1.5 text-sm">
              Export CSV
            </a>
            <a href={exportUrl(range, "pdf", meterId)} className="rounded border border-white/20 px-3 py-1.5 text-sm">
              Export PDF
            </a>
          </div>
        </div>

        {loading && !data && <p>Loading…</p>}
        {error && <p className="text-red-500">Failed to load analytics: {error}</p>}

        {data && s && (
          <div className={`space-y-6 ${loading ? "opacity-60" : ""}`}>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <StatTile label="Traded volume" value={formatKwh(s.totalEnergyKwh)} detail={formatChange(s.volumeChangePct)} />
              <StatTile label="Average price" value={formatPrice(s.avgPrice)} detail={formatChange(s.priceChangePct)} />
              <StatTile label="Traded value" value={formatXlm(s.totalValueStroops)} detail={`${s.trades.toLocaleString()} trades`} />
              <StatTile
                label="Active meters"
                value={s.activeMeters.toLocaleString()}
                detail={s.priceVolatilityPct == null ? undefined : `Price volatility ±${s.priceVolatilityPct}%`}
              />
            </div>

            {data.insights.length > 0 && (
              <section aria-labelledby="insights" className="rounded-lg border border-white/10 p-4">
                <h2 id="insights" className="mb-2 font-semibold">Market insights</h2>
                <ul className="list-disc space-y-1 pl-5 text-sm">
                  {data.insights.map((i) => (
                    <li key={i}>{i}</li>
                  ))}
                </ul>
              </section>
            )}

            <ChartCard
              title="Price trend"
              subtitle={
                data.forecast.points.length
                  ? `XLM per kWh · ${data.forecast.horizonDays}-day linear forecast with 95% band (R² ${data.forecast.r2})`
                  : `XLM per kWh · ${data.forecast.reason ?? "no forecast"}`
              }
            >
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={priceSeries(data)} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid stroke="var(--grid)" vertical={false} />
                  <XAxis dataKey="date" tickFormatter={shortDate} {...AXIS} minTickGap={24} />
                  <YAxis tickFormatter={xlmTick} {...AXIS} width={56} />
                  <Tooltip
                    contentStyle={TOOLTIP_STYLE}
                    labelFormatter={(d) => shortDate(String(d))}
                    formatter={(v: number | [number, number], name: string) =>
                      Array.isArray(v) ? [`${formatPrice(v[0])} – ${formatPrice(v[1])}`, name] : [formatPrice(v), name]
                    }
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Area dataKey="band" name="Forecast range" stroke="none" fill="var(--band)" isAnimationActive={false} connectNulls={false} />
                  <Line dataKey="price" name="Daily price" stroke="var(--series-1)" strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false} />
                  <Line dataKey="movingAvg" name="7-day average" stroke="var(--series-2)" strokeWidth={2} dot={false} isAnimationActive={false} />
                  <Line dataKey="forecast" name="Forecast" stroke="var(--series-1)" strokeWidth={2} strokeDasharray="4 4" dot={false} isAnimationActive={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </ChartCard>

            <div className="grid gap-6 lg:grid-cols-2">
              <ChartCard title="Traded volume" subtitle="kWh per day">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={data.daily} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap={2}>
                    <CartesianGrid stroke="var(--grid)" vertical={false} />
                    <XAxis dataKey="date" tickFormatter={shortDate} {...AXIS} minTickGap={24} />
                    <YAxis {...AXIS} width={48} />
                    <Tooltip
                      contentStyle={TOOLTIP_STYLE}
                      cursor={{ fill: "var(--grid)" }}
                      labelFormatter={(d) => shortDate(String(d))}
                      formatter={(v: number) => [formatKwh(v), "Volume"]}
                    />
                    <Bar dataKey="energyKwh" name="Volume" fill="var(--series-1)" radius={[4, 4, 0, 0]} isAnimationActive={false} />
                  </BarChart>
                </ResponsiveContainer>
              </ChartCard>

              <ChartCard title="Intraday trading pattern" subtitle="kWh traded by hour of day (UTC)">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={data.hourly} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap={2}>
                    <CartesianGrid stroke="var(--grid)" vertical={false} />
                    <XAxis dataKey="hour" tickFormatter={(h: number) => `${String(h).padStart(2, "0")}h`} {...AXIS} interval={2} />
                    <YAxis {...AXIS} width={48} />
                    <Tooltip
                      contentStyle={TOOLTIP_STYLE}
                      cursor={{ fill: "var(--grid)" }}
                      labelFormatter={(h) => `${String(h).padStart(2, "0")}:00–${String(h).padStart(2, "0")}:59 UTC`}
                      formatter={(v: number) => [formatKwh(v), "Volume"]}
                    />
                    <Bar dataKey="energyKwh" name="Volume" fill="var(--series-1)" radius={[4, 4, 0, 0]} isAnimationActive={false} />
                  </BarChart>
                </ResponsiveContainer>
              </ChartCard>
            </div>

            {data.topMeters.length > 0 && (
              <section aria-labelledby="top-meters" className="rounded-lg border border-white/10 p-4">
                <h2 id="top-meters" className="mb-2 font-semibold">Top meters by volume</h2>
                <table className="w-full text-sm">
                  <thead className="text-left text-xs opacity-60">
                    <tr>
                      <th className="py-1">Meter</th>
                      <th className="py-1 text-right">Volume</th>
                      <th className="py-1 text-right">Value</th>
                      <th className="py-1 text-right">Share</th>
                    </tr>
                  </thead>
                  <tbody className="tabular-nums">
                    {data.topMeters.map((m) => (
                      <tr key={m.meterId} className="border-t border-white/5">
                        <td className="py-1">{m.meterId}</td>
                        <td className="py-1 text-right">{formatKwh(m.energyKwh)}</td>
                        <td className="py-1 text-right">{formatXlm(m.valueStroops)}</td>
                        <td className="py-1 text-right">{m.sharePct}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            )}

            <section aria-labelledby="daily-data" className="rounded-lg border border-white/10 p-4">
              <div className="flex items-center justify-between">
                <h2 id="daily-data" className="font-semibold">Daily data</h2>
                <button type="button" className="text-sm underline" aria-expanded={showTable} onClick={() => setShowTable((v) => !v)}>
                  {showTable ? "Hide table" : "Show table"}
                </button>
              </div>
              {showTable && (
                <div className="mt-2 max-h-96 overflow-auto">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-solar-accent text-left text-xs opacity-80">
                      <tr>
                        <th className="py-1">Date</th>
                        <th className="py-1 text-right">Volume</th>
                        <th className="py-1 text-right">Trades</th>
                        <th className="py-1 text-right">Avg price</th>
                        <th className="py-1 text-right">7-day avg</th>
                      </tr>
                    </thead>
                    <tbody className="tabular-nums">
                      {data.daily.map((d) => (
                        <tr key={d.date} className="border-t border-white/5">
                          <td className="py-1">{d.date}</td>
                          <td className="py-1 text-right">{formatKwh(d.energyKwh)}</td>
                          <td className="py-1 text-right">{d.trades}</td>
                          <td className="py-1 text-right">{formatPrice(d.avgPrice)}</td>
                          <td className="py-1 text-right">{formatPrice(d.movingAvgPrice)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>
        )}
      </main>
    </>
  );
}
