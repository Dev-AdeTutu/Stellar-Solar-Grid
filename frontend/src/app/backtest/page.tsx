"use client";

/**
 * Energy trading strategy backtesting (#940): build a strategy, run it against
 * historical prices, and share it as a link.
 */
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
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
import { env } from "@/lib/env";

const API = `${env.NEXT_PUBLIC_BACKEND_URL}/api/backtest`;

type Strategy =
  | { type: "threshold"; buyBelow: number; sellAbove: number }
  | { type: "ma_crossover"; shortWindow: number; longWindow: number }
  | { type: "buy_and_hold" };

type Result = {
  from: string;
  to: string;
  days: number;
  finalValue: number;
  metrics: {
    roiPct: number;
    annualizedReturnPct: number;
    sharpeRatio: number;
    maxDrawdownPct: number;
    tradeCount: number;
    winRatePct: number;
    benchmarkRoiPct: number;
  };
  equity: { date: string; value: number; price: number }[];
  trades: { date: string; side: "buy" | "sell"; price: number; units: number; value: number }[];
};

export const dynamic = "force-dynamic";

export default function BacktestPage() {
  return (
    <Suspense fallback={null}>
      <Backtest />
    </Suspense>
  );
}

function Backtest() {
  const params = useSearchParams();
  const [type, setType] = useState<Strategy["type"]>("threshold");
  const [buyBelow, setBuyBelow] = useState("0.47");
  const [sellAbove, setSellAbove] = useState("0.53");
  const [shortWindow, setShortWindow] = useState("7");
  const [longWindow, setLongWindow] = useState("30");
  const [capital, setCapital] = useState("1000");
  const [years, setYears] = useState("1");
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [shareUrl, setShareUrl] = useState<string | null>(null);

  const strategy = (): Strategy =>
    type === "threshold"
      ? { type, buyBelow: Number(buyBelow), sellAbove: Number(sellAbove) }
      : type === "ma_crossover"
        ? { type, shortWindow: Number(shortWindow), longWindow: Number(longWindow) }
        : { type };

  // Load a shared strategy (?s=<token>) into the builder.
  useEffect(() => {
    const token = params.get("s");
    if (!token) return;
    fetch(`${API}/share/${encodeURIComponent(token)}`)
      .then((r) => r.json())
      .then(({ strategy: s }: { strategy?: Strategy }) => {
        if (!s) return;
        setType(s.type);
        if (s.type === "threshold") {
          setBuyBelow(String(s.buyBelow));
          setSellAbove(String(s.sellAbove));
        } else if (s.type === "ma_crossover") {
          setShortWindow(String(s.shortWindow));
          setLongWindow(String(s.longWindow));
        }
      })
      .catch(() => setError("Could not load shared strategy"));
  }, [params]);

  async function post(path: string, body: unknown) {
    const res = await fetch(`${API}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "Request failed");
    return data;
  }

  async function run(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setShareUrl(null);
    try {
      const to = new Date();
      const from = new Date(to.getTime() - Number(years) * 365 * 86_400_000);
      setResult(
        await post("/run", {
          strategy: strategy(),
          from: from.toISOString().slice(0, 10),
          to: to.toISOString().slice(0, 10),
          initialCapital: Number(capital),
          feeRate: 0.001,
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Backtest failed");
    } finally {
      setLoading(false);
    }
  }

  async function share() {
    try {
      const { token } = await post("/share", { strategy: strategy() });
      const url = `${window.location.origin}/backtest?s=${token}`;
      setShareUrl(url);
      await navigator.clipboard?.writeText(url).catch(() => {});
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not share strategy");
    }
  }

  const input = "rounded border border-white/20 bg-transparent px-2 py-1 text-sm w-28";
  const m = result?.metrics;

  return (
    <>
      <Navbar />
      <main className="mx-auto max-w-4xl p-4 space-y-6">
        <h1 className="text-2xl font-bold">Strategy backtesting</h1>
        <form onSubmit={run} className="flex flex-wrap items-end gap-3">
          <label className="text-xs">
            Strategy
            <select
              className={`${input} block`}
              value={type}
              onChange={(e) => setType(e.target.value as Strategy["type"])}
            >
              <option value="threshold">Price threshold</option>
              <option value="ma_crossover">Moving-average crossover</option>
              <option value="buy_and_hold">Buy &amp; hold</option>
            </select>
          </label>
          {type === "threshold" && (
            <>
              <label className="text-xs">
                Buy below (XLM/kWh)
                <input
                  className={`${input} block`}
                  type="number"
                  step="0.01"
                  value={buyBelow}
                  onChange={(e) => setBuyBelow(e.target.value)}
                />
              </label>
              <label className="text-xs">
                Sell above (XLM/kWh)
                <input
                  className={`${input} block`}
                  type="number"
                  step="0.01"
                  value={sellAbove}
                  onChange={(e) => setSellAbove(e.target.value)}
                />
              </label>
            </>
          )}
          {type === "ma_crossover" && (
            <>
              <label className="text-xs">
                Short MA (days)
                <input
                  className={`${input} block`}
                  type="number"
                  min="1"
                  value={shortWindow}
                  onChange={(e) => setShortWindow(e.target.value)}
                />
              </label>
              <label className="text-xs">
                Long MA (days)
                <input
                  className={`${input} block`}
                  type="number"
                  min="2"
                  value={longWindow}
                  onChange={(e) => setLongWindow(e.target.value)}
                />
              </label>
            </>
          )}
          <label className="text-xs">
            Capital (XLM)
            <input
              className={`${input} block`}
              type="number"
              min="1"
              value={capital}
              onChange={(e) => setCapital(e.target.value)}
            />
          </label>
          <label className="text-xs">
            Period
            <select
              className={`${input} block`}
              value={years}
              onChange={(e) => setYears(e.target.value)}
            >
              <option value="1">1 year</option>
              <option value="2">2 years</option>
              <option value="3">3 years</option>
            </select>
          </label>
          <button
            disabled={loading}
            className="rounded bg-sky-600 px-3 py-1.5 text-sm text-white disabled:opacity-50"
          >
            {loading ? "Running…" : "Run backtest"}
          </button>
          <button
            type="button"
            onClick={share}
            className="rounded border border-white/20 px-3 py-1.5 text-sm"
          >
            Share strategy
          </button>
        </form>

        {shareUrl && (
          <p className="text-xs break-all" role="status">
            Link copied: {shareUrl}
          </p>
        )}
        {error && (
          <p className="text-sm text-red-400" role="alert">
            {error}
          </p>
        )}

        {result && m && (
          <section className="space-y-4" aria-label="Backtest results">
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4 text-sm">
              {[
                ["ROI", `${m.roiPct}%`],
                ["Annualized", `${m.annualizedReturnPct}%`],
                ["Sharpe ratio", m.sharpeRatio],
                ["Max drawdown", `${m.maxDrawdownPct}%`],
                ["Trades", m.tradeCount],
                ["Win rate", `${m.winRatePct}%`],
                ["Buy & hold ROI", `${m.benchmarkRoiPct}%`],
                ["Final value", `${result.finalValue} XLM`],
              ].map(([k, v]) => (
                <div key={String(k)} className="rounded border border-white/10 p-3">
                  <dt className="text-xs opacity-70">{k}</dt>
                  <dd className="text-lg font-semibold">{v}</dd>
                </div>
              ))}
            </dl>
            <div className="h-72" role="img" aria-label="Equity curve versus price">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={result.equity}>
                  <CartesianGrid strokeOpacity={0.15} />
                  <XAxis dataKey="date" minTickGap={40} tick={{ fontSize: 11 }} />
                  <YAxis yAxisId="v" tick={{ fontSize: 11 }} domain={["auto", "auto"]} />
                  <YAxis
                    yAxisId="p"
                    orientation="right"
                    tick={{ fontSize: 11 }}
                    domain={["auto", "auto"]}
                  />
                  <Tooltip />
                  <Legend />
                  <Line
                    yAxisId="v"
                    dataKey="value"
                    name="Portfolio (XLM)"
                    stroke="#0ea5e9"
                    dot={false}
                  />
                  <Line
                    yAxisId="p"
                    dataKey="price"
                    name="Price (XLM/kWh)"
                    stroke="#f59e0b"
                    dot={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
            {result.trades.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left opacity-70">
                      <th>Date</th>
                      <th>Side</th>
                      <th>Price</th>
                      <th>Units</th>
                      <th>Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.trades.slice(-20).map((t, i) => (
                      <tr key={i}>
                        <td>{t.date}</td>
                        <td>{t.side}</td>
                        <td>{t.price}</td>
                        <td>{t.units}</td>
                        <td>{t.value}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}
      </main>
    </>
  );
}
