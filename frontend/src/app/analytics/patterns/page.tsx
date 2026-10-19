"use client";

/**
 * Energy consumption pattern analysis (#928).
 *
 * Shows what the model found for a meter: the recognised daily patterns, the
 * actual-vs-forecast trend with its confidence band, flagged anomalies the
 * owner can acknowledge, personalised savings insights and the weekly report.
 * Times are UTC throughout.
 */
import { useCallback, useEffect, useState } from "react";
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import Navbar from "@/components/Navbar";
import {
  SEVERITY_BADGE,
  acknowledgeAnomaly,
  averageCentroid,
  fetchAnalysis,
  fetchAnomalies,
  fetchTrends,
  fetchWeeklyReports,
  formatAccuracy,
  formatHour,
  formatKwh,
  generateWeeklyReport,
  type ConsumptionAnalysis,
  type ConsumptionAnomaly,
  type TrendSeries,
  type WeeklyInsightsReport,
} from "@/lib/consumptionAnalytics";

// Chart tokens: validated categorical slots 1-2 with their own dark steps.
const TOKENS = `
.viz-root {
  --series-1: #2a78d6; --series-2: #eb6834; --band: rgba(42,120,214,0.18);
  --series-3: #3f9f6d; --grid: #e1e0d9; --axis: #898781;
  --tooltip-bg: #fcfcfb; --tooltip-ink: #0b0b0b;
}
:root[data-theme="dark"] .viz-root, :root:not([data-theme]) .viz-root {
  --series-1: #3987e5; --series-2: #d95926; --band: rgba(57,135,229,0.2);
  --series-3: #46b37f; --grid: #2c2c2a; --axis: #898781;
  --tooltip-bg: #1a1a19; --tooltip-ink: #ffffff;
}`;

const TOOLTIP_STYLE = {
  background: "var(--tooltip-bg)",
  color: "var(--tooltip-ink)",
  border: "1px solid var(--grid)",
  borderRadius: 6,
  fontSize: 12,
};
const AXIS = { stroke: "var(--axis)", fontSize: 11, tickLine: false } as const;

const stamp = (value: string | number) => new Date(value).toISOString().slice(5, 16).replace("T", " ");

function StatTile({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="rounded-lg border border-white/10 p-4">
      <p className="text-xs opacity-60">{label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums">{value}</p>
      {detail && <p className="mt-1 text-xs opacity-70">{detail}</p>}
    </div>
  );
}

function ChartCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-white/10 p-4" aria-label={title}>
      <h2 className="font-semibold">{title}</h2>
      {subtitle && <p className="mb-2 text-xs opacity-60">{subtitle}</p>}
      <div className="h-64">{children}</div>
    </section>
  );
}

export default function ConsumptionPatternsPage() {
  const [meterInput, setMeterInput] = useState("");
  const [meterId, setMeterId] = useState("");
  const [analysis, setAnalysis] = useState<ConsumptionAnalysis | null>(null);
  const [trends, setTrends] = useState<TrendSeries | null>(null);
  const [anomalies, setAnomalies] = useState<ConsumptionAnomaly[]>([]);
  const [reports, setReports] = useState<WeeklyInsightsReport[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!meterId) return;
    setLoading(true);
    setError(null);
    try {
      const [a, t, an, w] = await Promise.all([
        fetchAnalysis(meterId),
        fetchTrends(meterId),
        fetchAnomalies(meterId),
        fetchWeeklyReports(meterId),
      ]);
      setAnalysis(a);
      setTrends(t);
      setAnomalies(an);
      setReports(w);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [meterId]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleAck(id: string) {
    try {
      await acknowledgeAnomaly(id);
      setAnomalies(await fetchAnomalies(meterId));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function handleGenerateReport() {
    try {
      await generateWeeklyReport(meterId);
      setReports(await fetchWeeklyReports(meterId));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const trendData =
    trends === null
      ? []
      : [
          ...trends.actual.slice(-336).map((point) => ({
            label: stamp(point.timestamp),
            actual: point.energyKwh,
          })),
          ...trends.forecast.map((point) => ({
            label: stamp(point.timestamp),
            forecast: point.predictedKwh,
            lower: point.lowerKwh,
            upper: point.upperKwh,
          })),
        ];

  const profileData = averageCentroid(analysis?.patterns ?? []).map((kwh, hour) => ({
    hour: formatHour(hour),
    average: kwh,
  }));

  return (
    <>
      <Navbar />
      <style>{TOKENS}</style>
      <main className="viz-root mx-auto max-w-6xl p-6">
        <h1 className="mb-1 text-2xl font-bold">Consumption patterns</h1>
        <p className="mb-4 text-sm opacity-70">
          What your energy use looks like, where it deviates from that pattern, and what to change.
          Times are UTC.
        </p>

        <form
          className="mb-6 flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setMeterId(meterInput.trim());
          }}
        >
          <label htmlFor="pattern-meter" className="sr-only">
            Meter ID
          </label>
          <input
            id="pattern-meter"
            className="rounded border bg-transparent px-3 py-1.5 text-sm"
            placeholder="Meter ID"
            value={meterInput}
            onChange={(e) => setMeterInput(e.target.value)}
          />
          <button type="submit" className="rounded border border-white/20 px-3 py-1.5 text-sm">
            Analyse
          </button>
        </form>

        {!meterId && <p className="text-sm opacity-60">Enter a meter ID to run the analysis.</p>}
        {loading && !analysis && <p>Loading…</p>}
        {error && <p className="text-red-400">Failed to load analysis: {error}</p>}

        {analysis && (
          <div className={`space-y-6 ${loading ? "opacity-60" : ""}`}>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <StatTile label="Consumption" value={formatKwh(analysis.totalKwh)} detail={`last ${analysis.windowDays} days`} />
              <StatTile
                label="Forecast accuracy"
                value={formatAccuracy(analysis.accuracyPct)}
                detail={analysis.accuracyPct == null ? "needs more history" : "held-out hours"}
              />
              <StatTile
                label="Peak hour"
                value={analysis.peakHour == null ? "–" : formatHour(analysis.peakHour)}
                detail={formatKwh(analysis.peakHourlyKwh)}
              />
              <StatTile
                label="Anomalies"
                value={analysis.anomalySummary.total.toLocaleString()}
                detail={`${analysis.anomalySummary.critical} critical`}
              />
            </div>

            {!analysis.sufficientData && (
              <p className="rounded-lg border border-yellow-500/40 bg-yellow-900/20 p-3 text-sm">
                Not enough history yet to judge this meter. Patterns and anomaly scores stay hidden
                until there are 48 recorded hours.
              </p>
            )}

            <ChartCard
              title="Actual vs forecast"
              subtitle={`Hourly kWh · last 14 days of metered use and the ${Math.round(analysis.forecast.length / 24)}-day forecast with its 95% band`}
            >
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={trendData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid stroke="var(--grid)" vertical={false} />
                  <XAxis dataKey="label" {...AXIS} minTickGap={48} />
                  <YAxis {...AXIS} width={52} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} labelFormatter={(l) => String(l)} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Area dataKey="upper" name="Upper bound" stroke="none" fill="var(--band)" isAnimationActive={false} />
                  <Line dataKey="actual" name="Metered" stroke="var(--series-1)" strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false} />
                  <Line dataKey="forecast" name="Forecast" stroke="var(--series-2)" strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </ChartCard>

            <div className="grid gap-6 lg:grid-cols-2">
              <ChartCard title="Average daily profile" subtitle="kWh by hour of day (UTC)">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={profileData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap={2}>
                    <CartesianGrid stroke="var(--grid)" vertical={false} />
                    <XAxis dataKey="hour" {...AXIS} interval={2} />
                    <YAxis {...AXIS} width={48} />
                    <Tooltip
                      contentStyle={TOOLTIP_STYLE}
                      cursor={{ fill: "var(--grid)" }}
                      formatter={(v: number) => [formatKwh(v), "Average"]}
                    />
                    <Bar dataKey="average" name="Average" fill="var(--series-1)" radius={[4, 4, 0, 0]} isAnimationActive={false} />
                  </BarChart>
                </ResponsiveContainer>
              </ChartCard>

              <section aria-label="Recognised patterns" className="rounded-lg border border-white/10 p-4">
                <h2 className="font-semibold">Recognised patterns</h2>
                {analysis.patterns.length === 0 ? (
                  <p className="mt-2 text-sm opacity-60">
                    No recurring pattern yet — more recorded days are needed.
                  </p>
                ) : (
                  <ul className="mt-2 space-y-3 text-sm">
                    {analysis.patterns.map((pattern) => (
                      <li key={pattern.id} className="rounded border border-white/10 p-3">
                        <div className="flex items-baseline justify-between">
                          <span className="font-medium">{pattern.label}</span>
                          <span className="tabular-nums opacity-70">{pattern.sharePct}%</span>
                        </div>
                        <p className="mt-1 text-xs opacity-70">
                          Peaks {formatHour(pattern.peakHour)} · troughs {formatHour(pattern.troughHour)} ·{" "}
                          {pattern.days} {pattern.days === 1 ? "day" : "days"} · load factor{" "}
                          {pattern.loadFactor}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>

            <section aria-labelledby="anomalies" className="rounded-lg border border-white/10 p-4">
              <h2 id="anomalies" className="font-semibold">
                Flagged anomalies
              </h2>
              {anomalies.length === 0 ? (
                <p className="mt-2 text-sm opacity-60">Nothing unusual in recent history.</p>
              ) : (
                <div className="mt-2 overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="text-left text-xs opacity-60">
                      <tr>
                        <th className="py-1">When</th>
                        <th className="py-1 text-right">Metered</th>
                        <th className="py-1 text-right">Expected</th>
                        <th className="py-1 text-right">Deviation</th>
                        <th className="py-1">Severity</th>
                        <th className="py-1" />
                      </tr>
                    </thead>
                    <tbody className="tabular-nums">
                      {anomalies.map((anomaly) => (
                        <tr key={anomaly.id} className="border-t border-white/5">
                          <td className="py-1">{stamp(anomaly.timestamp)}</td>
                          <td className="py-1 text-right">{formatKwh(anomaly.energyKwh)}</td>
                          <td className="py-1 text-right">{formatKwh(anomaly.expectedKwh)}</td>
                          <td className="py-1 text-right">{anomaly.deviationPct}%</td>
                          <td className="py-1">
                            <span className={`rounded-full px-2 py-0.5 text-xs ${SEVERITY_BADGE[anomaly.severity]}`}>
                              {anomaly.severity}
                            </span>
                          </td>
                          <td className="py-1 text-right">
                            <button
                              type="button"
                              className="text-xs underline opacity-70 hover:opacity-100"
                              onClick={() => handleAck(anomaly.id)}
                            >
                              Acknowledge
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section aria-labelledby="insights" className="rounded-lg border border-white/10 p-4">
              <h2 id="insights" className="font-semibold">
                Insights for this meter
              </h2>
              {analysis.insights.length === 0 ? (
                <p className="mt-2 text-sm opacity-60">No suggestions yet.</p>
              ) : (
                <ul className="mt-2 space-y-3 text-sm">
                  {analysis.insights.map((insight) => (
                    <li key={insight.id} className="rounded border border-white/10 p-3">
                      <p className="font-medium">{insight.title}</p>
                      <p className="mt-1 text-xs opacity-70">{insight.detail}</p>
                      {insight.estimatedAnnualKwh > 0 && (
                        <p className="mt-1 text-xs text-green-400 tabular-nums">
                          ≈ {formatKwh(insight.estimatedAnnualKwh)}/yr · {insight.estimatedAnnualXlm} XLM/yr
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section aria-labelledby="weekly" className="rounded-lg border border-white/10 p-4">
              <div className="flex items-center justify-between">
                <h2 id="weekly" className="font-semibold">
                  Weekly insights report
                </h2>
                <button
                  type="button"
                  className="rounded border border-white/20 px-3 py-1.5 text-sm"
                  onClick={handleGenerateReport}
                >
                  Generate now
                </button>
              </div>
              {reports.length === 0 ? (
                <p className="mt-2 text-sm opacity-60">No report generated yet.</p>
              ) : (
                <ul className="mt-2 space-y-3 text-sm">
                  {reports.map((report) => (
                    <li key={report.id} className="rounded border border-white/10 p-3">
                      <p className="tabular-nums">
                        {report.weekStart.slice(0, 10)} → {report.weekEnd.slice(0, 10)}
                      </p>
                      <p className="mt-1 text-xs opacity-70 tabular-nums">
                        {formatKwh(report.totalKwh)} used · {report.anomalyCount} anomalies ·{" "}
                        {report.topPattern ?? "no dominant pattern"}
                      </p>
                      <ul className="mt-2 list-disc space-y-1 pl-5 text-xs opacity-80">
                        {report.insights.map((insight) => (
                          <li key={insight.id}>{insight.title}</li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
      </main>
    </>
  );
}
