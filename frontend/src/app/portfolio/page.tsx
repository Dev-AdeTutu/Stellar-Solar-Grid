"use client";

/**
 * Energy portfolio management (#926): composition, AI-driven allocation advice,
 * performance metrics, one-click rebalancing and a risk score.
 */
import { useCallback, useEffect, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import Navbar from "@/components/Navbar";
import {
  RISK_BADGE,
  addAsset,
  applyRebalance,
  compositionData,
  fetchDashboard,
  formatKw,
  formatPercent,
  type AssetType,
  type PortfolioDashboard,
} from "@/lib/portfolio";

// Chart tokens: validated categorical slots 1-3 with their own dark steps.
const TOKENS = `
.viz-root {
  --series-1: #2a78d6; --series-2: #eb6834; --series-3: #3f9f6d;
  --grid: #e1e0d9; --axis: #898781;
  --tooltip-bg: #fcfcfb; --tooltip-ink: #0b0b0b;
}
:root[data-theme="dark"] .viz-root, :root:not([data-theme]) .viz-root {
  --series-1: #3987e5; --series-2: #d95926; --series-3: #46b37f;
  --grid: #2c2c2a; --axis: #898781;
  --tooltip-bg: #1a1a19; --tooltip-ink: #ffffff;
}
`;

const TOOLTIP_STYLE = {
  background: "var(--tooltip-bg)",
  color: "var(--tooltip-ink)",
  border: "1px solid var(--grid)",
  borderRadius: 6,
  fontSize: 12,
};
const AXIS = { stroke: "var(--axis)", fontSize: 11, tickLine: false } as const;
const SLICE_COLORS = ["var(--series-1)", "var(--series-2)", "var(--series-3)"];

const ASSET_TYPES: AssetType[] = ["solar", "wind", "storage", "hydro", "grid"];

export default function PortfolioPage() {
  const [ownerInput, setOwnerInput] = useState("");
  const [ownerId, setOwnerId] = useState("");
  const [dashboard, setDashboard] = useState<PortfolioDashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [assetType, setAssetType] = useState<AssetType>("solar");
  const [assetName, setAssetName] = useState("Rooftop array");
  const [assetCapacity, setAssetCapacity] = useState("50");

  const load = useCallback(async () => {
    if (!ownerId) return;
    setError(null);
    try {
      setDashboard(await fetchDashboard(ownerId));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [ownerId]);

  useEffect(() => {
    load();
  }, [load]);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const performance = dashboard?.performance;
  const composition = performance ? compositionData(performance) : [];

  return (
    <>
      <Navbar />
      <style>{TOKENS}</style>
      <main className="viz-root mx-auto max-w-6xl p-6">
        <h1 className="mb-1 text-2xl font-bold">Energy portfolio</h1>
        <p className="mb-4 text-sm opacity-70">
          Diversify across solar, wind and storage, with allocation advice weighted by measured
          return per unit of technology risk.
        </p>

        <form
          className="mb-6 flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setOwnerId(ownerInput.trim());
          }}
        >
          <label htmlFor="portfolio-owner" className="sr-only">
            Account ID
          </label>
          <input
            id="portfolio-owner"
            className="rounded border bg-transparent px-3 py-1.5 text-sm"
            placeholder="Account ID"
            value={ownerInput}
            onChange={(e) => setOwnerInput(e.target.value)}
          />
          <button type="submit" className="rounded border border-white/20 px-3 py-1.5 text-sm">
            Load portfolio
          </button>
        </form>

        {!ownerId && <p className="text-sm opacity-60">Enter an account to load its portfolio.</p>}
        {error && <p className="mb-4 rounded border border-red-500/40 bg-red-900/20 p-3 text-sm text-red-300">{error}</p>}

        {dashboard && (
          <div className="space-y-6">
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Tile label="Capacity" value={`${performance?.totalCapacityKw ?? 0} kW`} detail={`${dashboard.assetCount} assets`} />
              <Tile label="Energy delivered" value={`${performance?.totalEnergyKwh ?? 0} kWh`} detail={`${performance?.revenueXlm ?? 0} XLM earned`} />
              <Tile label="ROI" value={formatPercent(performance?.roiPct ?? null)} detail={`cost basis ${performance?.totalCostBasisXlm ?? 0} XLM`} />
              <Tile label="Efficiency" value={formatPercent(performance?.efficiencyPct ?? null)} detail={`uptime ${formatPercent(performance?.uptimePct ?? null)}`} />
            </div>

            <div className="grid gap-6 lg:grid-cols-2">
              <section className="rounded-lg border border-white/10 p-4">
                <h2 className="text-sm font-semibold">Composition by capacity</h2>
                {composition.length === 0 ? (
                  <p className="mt-2 text-sm opacity-60">No assets yet.</p>
                ) : (
                  <div className="mt-2 h-56">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={composition} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                        <CartesianGrid stroke="var(--grid)" vertical={false} />
                        <XAxis dataKey="type" {...AXIS} />
                        <YAxis {...AXIS} width={48} />
                        <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: "var(--grid)" }} formatter={(v: number) => [`${v} kW`, "Capacity"]} />
                        <Bar dataKey="capacityKw" name="Capacity" radius={[4, 4, 0, 0]} isAnimationActive={false}>
                          {composition.map((row, i) => (
                            <Cell key={row.type} fill={SLICE_COLORS[i % SLICE_COLORS.length]} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </section>

              <section className="rounded-lg border border-white/10 p-4">
                <h2 className="text-sm font-semibold">Risk</h2>
                <p className="mt-2 text-3xl font-bold tabular-nums">
                  {dashboard.risk.score}
                  <span className="text-base font-normal opacity-60"> / 100</span>
                </p>
                <span className={`mt-1 inline-block rounded-full px-2 py-0.5 text-xs ${RISK_BADGE[dashboard.risk.band]}`}>
                  {dashboard.risk.band.replace("_", " ")}
                </span>
                <ul className="mt-3 list-disc space-y-1 pl-5 text-xs opacity-80">
                  {dashboard.risk.factors.map((factor) => (
                    <li key={factor}>{factor}</li>
                  ))}
                </ul>
              </section>
            </div>

            <section className="rounded-lg border border-white/10 p-4">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold">Allocation recommendation</h2>
                <button
                  type="button"
                  disabled={busy}
                  className="rounded border border-white/20 px-3 py-1 text-sm disabled:opacity-50"
                  onClick={() => run(() => applyRebalance(ownerId))}
                >
                  Rebalance now
                </button>
              </div>
              <p className="mt-1 text-xs opacity-70">{dashboard.recommendation.rationale}</p>
              {dashboard.recommendation.allocations.length === 0 ? (
                <p className="mt-2 text-sm opacity-60">Add an asset to get a target allocation.</p>
              ) : (
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="text-left text-xs opacity-60">
                      <tr>
                        <th className="py-1">Asset</th>
                        <th className="py-1 text-right">Now</th>
                        <th className="py-1 text-right">Target</th>
                        <th className="py-1 text-right">Move</th>
                        <th className="py-1 text-right">Expected return</th>
                      </tr>
                    </thead>
                    <tbody className="tabular-nums">
                      {dashboard.recommendation.allocations.map((slice) => (
                        <tr key={slice.assetId} className="border-t border-white/5">
                          <td className="py-1">{slice.name}</td>
                          <td className="py-1 text-right">{slice.currentWeightPct.toFixed(1)}%</td>
                          <td className="py-1 text-right">{slice.weightPct.toFixed(1)}%</td>
                          <td className="py-1 text-right">
                            <span className={slice.deltaKw > 0 ? "text-green-400" : slice.deltaKw < 0 ? "text-red-400" : "opacity-60"}>
                              {formatKw(slice.deltaKw)}
                            </span>
                          </td>
                          <td className="py-1 text-right">{formatPercent(slice.expectedReturnPct)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section className="rounded-lg border border-white/10 p-4">
              <h2 className="text-sm font-semibold">Rebalancing plan</h2>
              <p className="mt-1 text-xs opacity-70 tabular-nums">
                Risk {dashboard.rebalance.riskBefore} → {dashboard.rebalance.riskAfter} · net{" "}
                {formatKw(dashboard.rebalance.netDeltaKw)} · cost {dashboard.rebalance.estimatedCostXlm} XLM
              </p>
              {dashboard.rebalance.actions.length === 0 ? (
                <p className="mt-2 text-sm opacity-60">Nothing to do.</p>
              ) : (
                <ul className="mt-2 space-y-2 text-sm">
                  {dashboard.rebalance.actions.map((action) => (
                    <li key={action.assetId} className="rounded border border-white/10 p-3">
                      <div className="flex items-baseline justify-between">
                        <span className="font-medium capitalize">{action.action} {action.type}</span>
                        <span className="tabular-nums opacity-70">{formatKw(action.deltaKw)}</span>
                      </div>
                      <p className="mt-1 text-xs opacity-70">{action.reason}</p>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="rounded-lg border border-white/10 p-4">
              <h2 className="text-sm font-semibold">Add an asset</h2>
              <div className="mt-2 flex flex-wrap items-end gap-2 text-sm">
                <label className="flex flex-col gap-1">
                  <span className="text-xs opacity-60">Type</span>
                  <select
                    className="rounded border bg-transparent px-2 py-1"
                    value={assetType}
                    onChange={(e) => setAssetType(e.target.value as AssetType)}
                    aria-label="Asset type"
                  >
                    {ASSET_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {type}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs opacity-60">Name</span>
                  <input className="rounded border bg-transparent px-2 py-1" value={assetName} onChange={(e) => setAssetName(e.target.value)} aria-label="Asset name" />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs opacity-60">Capacity (kW)</span>
                  <input className="rounded border bg-transparent px-2 py-1" type="number" min={1} value={assetCapacity} onChange={(e) => setAssetCapacity(e.target.value)} aria-label="Capacity in kW" />
                </label>
                <button
                  type="button"
                  disabled={busy}
                  className="rounded border border-white/20 px-3 py-1 disabled:opacity-50"
                  onClick={() =>
                    run(() =>
                      addAsset(ownerId, {
                        type: assetType,
                        name: assetName,
                        capacityKw: Number(assetCapacity),
                      }),
                    )
                  }
                >
                  Add
                </button>
              </div>
            </section>
          </div>
        )}
      </main>
    </>
  );
}

function Tile({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-lg border border-white/10 p-4">
      <p className="text-xs opacity-60">{label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums">{value}</p>
      <p className="mt-1 text-xs opacity-70">{detail}</p>
    </div>
  );
}