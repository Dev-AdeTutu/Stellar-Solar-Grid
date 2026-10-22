"use client";

import { useCallback, useEffect, useState } from "react";
import {
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
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { Skeleton } from "@/components/Skeleton";
import { useToast } from "@/components/ToastProvider";
import { env } from "@/lib/env";

const API = env.NEXT_PUBLIC_BACKEND_URL;
const ADMIN_KEY_STORAGE = "provider_analytics_admin_key";

type Granularity = "daily" | "monthly" | "yearly";

interface ChurnResult {
  churnRate: number;
  retentionRate: number;
  previousPeriodCustomers: number;
  currentPeriodCustomers: number;
  retainedCustomers: number;
  churnedCustomers: number;
}

interface TrendPoint {
  bucket: string;
  revenue: number;
  paymentCount: number;
  uniqueCustomers: number;
}

interface AcquisitionPoint {
  bucket: string;
  newCustomers: number;
}

interface GeoPoint {
  region: string;
  revenue: number;
  paymentCount: number;
  customers: number;
  percentageOfTotal: number;
}

interface AnalyticsSummary {
  range: { from: string; to: string; granularity: Granularity };
  totalRevenueXlm: number;
  mrrXlm: number;
  arpuXlm: number;
  totalPayments: number;
  activeCustomers: number;
  churn: ChurnResult;
  trend: TrendPoint[];
  acquisition: AcquisitionPoint[];
  geoBreakdown: GeoPoint[];
}

function StatTile({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-solar-accent px-5 py-4 text-center">
      <p className="text-xs uppercase tracking-wider text-gray-500 mb-1">{label}</p>
      <p className={`text-2xl font-bold ${color ?? "text-white"}`}>{value}</p>
    </div>
  );
}

export default function ProviderAnalyticsPage() {
  const { showToast } = useToast();
  const [adminKey, setAdminKey] = useState("");
  const [granularity, setGranularity] = useState<Granularity>("monthly");
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState<"pdf" | "xlsx" | null>(null);

  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(ADMIN_KEY_STORAGE);
      if (saved) setAdminKey(saved);
    } catch {
      // sessionStorage unavailable (private mode) — key just won't persist.
    }
  }, []);

  const fetchAnalytics = useCallback(async () => {
    if (!adminKey.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API}/api/provider/analytics?granularity=${granularity}`, {
        headers: { "X-Admin-Key": adminKey.trim() },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load analytics");
      setSummary(data);
      try {
        sessionStorage.setItem(ADMIN_KEY_STORAGE, adminKey.trim());
      } catch {
        // ignore
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load analytics");
    } finally {
      setLoading(false);
    }
  }, [adminKey, granularity]);

  useEffect(() => {
    if (adminKey.trim()) fetchAnalytics();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [granularity]);

  async function handleExport(format: "pdf" | "xlsx") {
    if (!adminKey.trim()) return;
    setExporting(format);
    try {
      const res = await fetch(`${API}/api/provider/analytics/export?format=${format}&granularity=${granularity}`, {
        headers: { "X-Admin-Key": adminKey.trim() },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Export failed");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `provider-revenue-analytics.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      showToast({ variant: "success", title: "Export ready", description: `Downloaded ${format.toUpperCase()} report.` });
    } catch (err: unknown) {
      showToast({
        variant: "error",
        title: "Export failed",
        description: err instanceof Error ? err.message : "Export failed",
      });
    } finally {
      setExporting(null);
    }
  }

  return (
    <ErrorBoundary>
      <Navbar />
      <main id="main-content" tabIndex={-1} className="min-h-screen flex flex-col items-center px-4 py-8 sm:py-16 gap-8">
        <div className="w-full max-w-5xl">
          <h1 className="text-2xl sm:text-3xl font-bold text-solar-yellow mb-2">Provider Revenue Analytics</h1>
          <p className="text-gray-400 text-sm mb-6">
            Total revenue, MRR, ARPU, churn, revenue trends, customer acquisition, and geographic
            breakdown.
          </p>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              fetchAnalytics();
            }}
            className="flex flex-wrap items-end gap-3 rounded-xl border border-white/10 bg-solar-accent p-4 mb-8"
          >
            <div className="flex-1 min-w-[220px]">
              <label className="block text-xs font-medium text-gray-300 mb-1.5">Admin key</label>
              <input
                type="password"
                value={adminKey}
                onChange={(e) => setAdminKey(e.target.value)}
                placeholder="X-Admin-Key"
                className="w-full rounded-lg border border-white/10 bg-solar-dark px-3 py-2 text-sm text-white placeholder-gray-600 focus:border-solar-yellow focus:outline-none transition"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-300 mb-1.5">Granularity</label>
              <select
                value={granularity}
                onChange={(e) => setGranularity(e.target.value as Granularity)}
                className="rounded-lg border border-white/10 bg-solar-dark px-3 py-2 text-sm text-white focus:border-solar-yellow focus:outline-none transition"
              >
                <option value="daily">Daily</option>
                <option value="monthly">Monthly</option>
                <option value="yearly">Yearly</option>
              </select>
            </div>
            <button
              type="submit"
              disabled={loading || !adminKey.trim()}
              className="rounded-lg bg-solar-yellow px-4 py-2 text-sm font-semibold text-solar-dark hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition"
            >
              {loading ? "Loading…" : "Load analytics"}
            </button>
            <button
              type="button"
              onClick={() => handleExport("pdf")}
              disabled={!summary || exporting !== null}
              className="rounded-lg border border-white/10 bg-solar-dark px-4 py-2 text-sm font-medium text-gray-200 hover:border-solar-yellow disabled:opacity-40 disabled:cursor-not-allowed transition"
            >
              {exporting === "pdf" ? "Exporting…" : "Export PDF"}
            </button>
            <button
              type="button"
              onClick={() => handleExport("xlsx")}
              disabled={!summary || exporting !== null}
              className="rounded-lg border border-white/10 bg-solar-dark px-4 py-2 text-sm font-medium text-gray-200 hover:border-solar-yellow disabled:opacity-40 disabled:cursor-not-allowed transition"
            >
              {exporting === "xlsx" ? "Exporting…" : "Export Excel"}
            </button>
          </form>

          {error && (
            <div className="mb-6 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
              {error}
            </div>
          )}

          {loading && !summary && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8">
              {[1, 2, 3, 4].map((i) => (
                <Skeleton key={i} height={80} />
              ))}
            </div>
          )}

          {summary && (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8">
                <StatTile label="Total Revenue" value={`${summary.totalRevenueXlm.toFixed(2)} XLM`} />
                <StatTile label="MRR" value={`${summary.mrrXlm.toFixed(2)} XLM`} />
                <StatTile label="ARPU" value={`${summary.arpuXlm.toFixed(4)} XLM`} />
                <StatTile
                  label="Churn Rate"
                  value={`${(summary.churn.churnRate * 100).toFixed(1)}%`}
                  color={summary.churn.churnRate > 0.2 ? "text-red-400" : "text-green-400"}
                />
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-10">
                <StatTile label="Retention Rate" value={`${(summary.churn.retentionRate * 100).toFixed(1)}%`} />
                <StatTile label="Active Customers" value={String(summary.activeCustomers)} />
                <StatTile label="Total Payments" value={String(summary.totalPayments)} />
                <StatTile label="Churned Customers" value={String(summary.churn.churnedCustomers)} />
              </div>

              <div className="rounded-xl border border-white/10 bg-solar-accent p-4 mb-8">
                <h2 className="text-lg font-semibold text-white mb-4">Revenue Trend</h2>
                <ResponsiveContainer width="100%" height={280}>
                  <LineChart data={summary.trend}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#ffffff1a" />
                    <XAxis dataKey="bucket" stroke="#9ca3af" fontSize={12} />
                    <YAxis stroke="#9ca3af" fontSize={12} />
                    <Tooltip contentStyle={{ background: "#0D1B2A", border: "1px solid #ffffff22" }} />
                    <Legend />
                    <Line type="monotone" dataKey="revenue" name="Revenue (stroops)" stroke="#F5A623" strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="uniqueCustomers" name="Unique customers" stroke="#4ADE80" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>

              <div className="grid lg:grid-cols-2 gap-8 mb-8 w-full">
                <div className="rounded-xl border border-white/10 bg-solar-accent p-4">
                  <h2 className="text-lg font-semibold text-white mb-4">Customer Acquisition</h2>
                  <ResponsiveContainer width="100%" height={260}>
                    <BarChart data={summary.acquisition}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#ffffff1a" />
                      <XAxis dataKey="bucket" stroke="#9ca3af" fontSize={12} />
                      <YAxis stroke="#9ca3af" fontSize={12} allowDecimals={false} />
                      <Tooltip contentStyle={{ background: "#0D1B2A", border: "1px solid #ffffff22" }} />
                      <Bar dataKey="newCustomers" name="New customers" fill="#F5A623" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>

                <div className="rounded-xl border border-white/10 bg-solar-accent p-4">
                  <h2 className="text-lg font-semibold text-white mb-4">Revenue by Region</h2>
                  <ResponsiveContainer width="100%" height={260}>
                    <BarChart data={summary.geoBreakdown} layout="vertical">
                      <CartesianGrid strokeDasharray="3 3" stroke="#ffffff1a" />
                      <XAxis type="number" stroke="#9ca3af" fontSize={12} />
                      <YAxis dataKey="region" type="category" stroke="#9ca3af" fontSize={12} width={90} />
                      <Tooltip contentStyle={{ background: "#0D1B2A", border: "1px solid #ffffff22" }} />
                      <Bar dataKey="revenue" name="Revenue (stroops)" fill="#4ADE80" radius={[0, 4, 4, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                  <p className="mt-3 text-xs text-gray-500">
                    Region is the meter&apos;s free-text registered location, not verified geocoding.
                  </p>
                </div>
              </div>
            </>
          )}

          {!loading && !summary && !error && (
            <p className="text-sm text-gray-500">Enter the provider admin key to load analytics.</p>
          )}
        </div>
      </main>
    </ErrorBoundary>
  );
}
