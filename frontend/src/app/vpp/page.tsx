"use client";

/**
 * Virtual power plant aggregation (#925): create or join a VPP, aggregate
 * distributed resources, bid into grid services, and track delivered energy,
 * utilisation and distributed revenue.
 */
import { useCallback, useEffect, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import Navbar from "@/components/Navbar";
import {
  BID_STATUS_BADGE,
  SERVICE_LABEL,
  createVpp,
  fetchBids,
  fetchPerformance,
  fetchSettlements,
  fetchVpp,
  formatXlm,
  joinVpp,
  settleBid,
  submitBid,
  type GridServiceBid,
  type ResourceType,
  type Vpp,
  type VppPerformance,
  type VppSettlement,
} from "@/lib/vpp";

// Chart tokens: validated categorical slots 1-2 with their own dark steps.
const TOKENS = `
.viz-root {
  --series-1: #2a78d6; --series-2: #eb6834;
  --grid: #e1e0d9; --axis: #898781;
  --tooltip-bg: #fcfcfb; --tooltip-ink: #0b0b0b;
}
:root[data-theme="dark"] .viz-root, :root:not([data-theme]) .viz-root {
  --series-1: #3987e5; --series-2: #d95926;
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

const RESOURCE_TYPES: ResourceType[] = ["solar", "battery", "ev", "load", "wind"];

export default function VppPage() {
  const [vpp, setVpp] = useState<Vpp | null>(null);
  const [performance, setPerformance] = useState<VppPerformance | null>(null);
  const [bids, setBids] = useState<GridServiceBid[]>([]);
  const [settlements, setSettlements] = useState<VppSettlement[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState("Riverside VPP");
  const [ownerId, setOwnerId] = useState("GALICE");
  const [resourceType, setResourceType] = useState<ResourceType>("solar");
  const [resourceName, setResourceName] = useState("Rooftop array");
  const [resourceCapacity, setResourceCapacity] = useState("100");
  const [bidEnergy, setBidEnergy] = useState("50");
  const [bidPrice, setBidPrice] = useState("0.20");
  const [openBidId, setOpenBidId] = useState<string>("");

  const refresh = useCallback(async (vppId: string) => {
    setError(null);
    try {
      const [detail, perf, bidList, settled] = await Promise.all([
        fetchVpp(vppId),
        fetchPerformance(vppId),
        fetchBids(vppId),
        fetchSettlements(vppId),
      ]);
      setVpp(detail);
      setPerformance(perf);
      setBids(bidList);
      setSettlements(settled);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  async function run(vppId: string, action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await refresh(vppId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const settlement = settlements[settlements.length - 1];
  const revenueChart = settlement
    ? settlement.shares.map((share) => ({
        member: share.memberId.replace(/^G/, "").slice(0, 10),
        amount: share.amountXlm,
        delivered: share.deliveredKwh,
      }))
    : [];

  return (
    <>
      <Navbar />
      <style>{TOKENS}</style>
      <main className="viz-root mx-auto max-w-6xl p-6">
        <h1 className="mb-1 text-2xl font-bold">Virtual power plant</h1>
        <p className="mb-4 text-sm opacity-70">
          Aggregate distributed resources into one dispatchable unit that bids into grid service
          markets. Revenue follows delivered energy, not nameplate capacity.
        </p>

        {error && <p className="mb-4 rounded border border-red-500/40 bg-red-900/20 p-3 text-sm text-red-300">{error}</p>}

        <section className="rounded-lg border border-white/10 p-4">
          <h2 className="text-sm font-semibold">Create a VPP</h2>
          <div className="mt-2 flex flex-wrap items-end gap-2 text-sm">
            <label className="flex flex-col gap-1">
              <span className="text-xs opacity-60">Name</span>
              <input className="rounded border bg-transparent px-2 py-1" value={name} onChange={(e) => setName(e.target.value)} aria-label="VPP name" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs opacity-60">Operator</span>
              <input className="rounded border bg-transparent px-2 py-1" value={ownerId} onChange={(e) => setOwnerId(e.target.value)} aria-label="Operator ID" />
            </label>
            <button
              type="button"
              disabled={busy}
              className="rounded border border-white/20 px-3 py-1 disabled:opacity-50"
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  const created = await createVpp({ name, service: "frequency_response", operatorId: ownerId });
                  setVpp(created);
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Create
            </button>
          </div>
        </section>

        {vpp && performance && (
          <div className="mt-6 space-y-6">
            <div className="flex flex-wrap items-baseline gap-3">
              <h2 className="text-xl font-bold">{vpp.name}</h2>
              <span className="rounded-full bg-white/10 px-2 py-0.5 text-xs">{SERVICE_LABEL[vpp.service]}</span>
              <span className="text-xs opacity-60">{vpp.id}</span>
              <span className={`rounded-full px-2 py-0.5 text-xs ${vpp.status === "active" ? "bg-green-900/40 text-green-300" : "bg-yellow-900/40 text-yellow-300"}`}>
                {vpp.status}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Tile label="Aggregated capacity" value={`${performance.aggregateCapacityKw} kW`} detail={`${performance.freeCapacityKw} kW free`} />
              <Tile label="Utilisation" value={`${performance.utilisationPct.toFixed(0)}%`} detail={`${performance.committedKw} kW committed`} />
              <Tile label="Fleet health" value={`${performance.healthScore}%`} detail={`${performance.resourceCount} resources`} />
              <Tile label="Revenue settled" value={formatXlm(performance.revenueXlm, 2)} detail={`${performance.deliveredKwh} kWh delivered`} />
            </div>

            <div className="grid gap-6 lg:grid-cols-2">
              <section className="rounded-lg border border-white/10 p-4">
                <h3 className="text-sm font-semibold">Capacity by resource</h3>
                <div className="mt-2 h-56">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={vpp.resources.map((r) => ({
                        name: r.name.slice(0, 12),
                        available: r.availableKw,
                        capacity: r.capacityKw,
                      }))}
                      margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
                      barGap={2}
                    >
                      <CartesianGrid stroke="var(--grid)" vertical={false} />
                      <XAxis dataKey="name" {...AXIS} interval={0} />
                      <YAxis {...AXIS} width={44} />
                      <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: "var(--grid)" }} formatter={(v: number) => [`${v} kW`, ""]} />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Bar dataKey="capacity" name="Nameplate" fill="var(--series-2)" isAnimationActive={false} />
                      <Bar dataKey="available" name="Dispatchable" isAnimationActive={false}>
                        {vpp.resources.map((_, i) => (
                          <Cell key={i} fill="var(--series-1)" />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </section>

              <section className="rounded-lg border border-white/10 p-4">
                <h3 className="text-sm font-semibold">Join with a resource</h3>
                <div className="mt-2 flex flex-wrap items-end gap-2 text-sm">
                  <label className="flex flex-col gap-1">
                    <span className="text-xs opacity-60">Owner</span>
                    <input className="rounded border bg-transparent px-2 py-1" value={ownerId} onChange={(e) => setOwnerId(e.target.value)} aria-label="Resource owner" />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-xs opacity-60">Type</span>
                    <select className="rounded border bg-transparent px-2 py-1" value={resourceType} onChange={(e) => setResourceType(e.target.value as ResourceType)} aria-label="Resource type">
                      {RESOURCE_TYPES.map((type) => (
                        <option key={type} value={type}>
                          {type}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-xs opacity-60">Name</span>
                    <input className="rounded border bg-transparent px-2 py-1" value={resourceName} onChange={(e) => setResourceName(e.target.value)} aria-label="Resource name" />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-xs opacity-60">kW</span>
                    <input className="rounded border bg-transparent px-2 py-1" type="number" min={1} value={resourceCapacity} onChange={(e) => setResourceCapacity(e.target.value)} aria-label="Resource capacity" />
                  </label>
                  <button
                    type="button"
                    disabled={busy}
                    className="rounded border border-white/20 px-3 py-1 disabled:opacity-50"
                    onClick={() =>
                      run(vpp.id, () =>
                        joinVpp(vpp.id, {
                          ownerId,
                          name: resourceName,
                          type: resourceType,
                          capacityKw: Number(resourceCapacity),
                        }),
                      )
                    }
                  >
                    Enrol
                  </button>
                </div>

                <table className="mt-3 w-full text-sm">
                  <thead className="text-left text-xs opacity-60">
                    <tr>
                      <th className="py-1">Resource</th>
                      <th className="py-1 text-right">kW</th>
                      <th className="py-1">Status</th>
                    </tr>
                  </thead>
                  <tbody className="tabular-nums">
                    {vpp.resources.map((r) => (
                      <tr key={r.id} className="border-t border-white/5">
                        <td className="py-1">{r.name}</td>
                        <td className="py-1 text-right">
                          {r.availableKw} / {r.capacityKw}
                        </td>
                        <td className="py-1">{r.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            </div>

            <section className="rounded-lg border border-white/10 p-4">
              <h3 className="text-sm font-semibold">Bid into {SERVICE_LABEL[vpp.service]}</h3>
              <div className="mt-2 flex flex-wrap items-end gap-2 text-sm">
                <label className="flex flex-col gap-1">
                  <span className="text-xs opacity-60">Energy (kWh)</span>
                  <input className="rounded border bg-transparent px-2 py-1" type="number" min={1} value={bidEnergy} onChange={(e) => setBidEnergy(e.target.value)} aria-label="Bid energy" />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs opacity-60">Price (XLM/kWh)</span>
                  <input className="rounded border bg-transparent px-2 py-1" type="number" step="0.01" min={0} value={bidPrice} onChange={(e) => setBidPrice(e.target.value)} aria-label="Bid price" />
                </label>
                <button
                  type="button"
                  disabled={busy}
                  className="rounded border border-white/20 px-3 py-1 disabled:opacity-50"
                  onClick={() =>
                    run(vpp.id, async () => {
                      const bid = await submitBid(vpp.id, { energyKwh: Number(bidEnergy), priceXlmPerKwh: Number(bidPrice) });
                      setOpenBidId(bid.id);
                    })
                  }
                >
                  Submit bid
                </button>
                <button
                  type="button"
                  disabled={busy || !openBidId}
                  className="rounded border border-white/20 px-3 py-1 disabled:opacity-50"
                  onClick={() =>
                    run(vpp.id, async () => {
                      const delivered: Record<string, number> = {};
                      for (const [resourceId, kw] of Object.entries(
                        bids.find((b) => b.id === openBidId)?.reservedKw ?? {},
                      )) {
                        delivered[resourceId] = kw;
                      }
                      await settleBid(openBidId, delivered);
                      setOpenBidId("");
                    })
                  }
                >
                  Dispatch &amp; settle
                </button>
              </div>

              {bids.length > 0 && (
                <table className="mt-3 w-full text-sm">
                  <thead className="text-left text-xs opacity-60">
                    <tr>
                      <th className="py-1">Bid</th>
                      <th className="py-1 text-right">Energy</th>
                      <th className="py-1 text-right">Price</th>
                      <th className="py-1">Status</th>
                    </tr>
                  </thead>
                  <tbody className="tabular-nums">
                    {bids.map((bid) => (
                      <tr key={bid.id} className="border-t border-white/5">
                        <td className="py-1">{bid.id.slice(-10)}</td>
                        <td className="py-1 text-right">{bid.energyKwh}</td>
                        <td className="py-1 text-right">{bid.priceXlmPerKwh}</td>
                        <td className="py-1">
                          <span className={`rounded-full px-2 py-0.5 text-xs ${BID_STATUS_BADGE[bid.status]}`}>
                            {bid.status}
                          </span>
                          {bid.rejectionReason && <span className="ml-2 text-xs opacity-60">{bid.rejectionReason}</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            <section className="rounded-lg border border-white/10 p-4">
              <h3 className="text-sm font-semibold">Revenue distribution</h3>
              {revenueChart.length === 0 ? (
                <p className="mt-2 text-sm opacity-60">Nothing settled yet.</p>
              ) : (
                <div className="mt-2 grid gap-4 lg:grid-cols-2">
                  <div className="h-56">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={revenueChart} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                        <CartesianGrid stroke="var(--grid)" vertical={false} />
                        <XAxis dataKey="member" {...AXIS} interval={0} />
                        <YAxis {...AXIS} width={52} />
                        <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: "var(--grid)" }} formatter={(v: number) => [formatXlm(v), "Paid"]} />
                        <Bar dataKey="amount" name="Paid" fill="var(--series-1)" radius={[4, 4, 0, 0]} isAnimationActive={false} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                  <table className="w-full self-start text-sm">
                    <thead className="text-left text-xs opacity-60">
                      <tr>
                        <th className="py-1">Member</th>
                        <th className="py-1 text-right">Delivered</th>
                        <th className="py-1 text-right">Share</th>
                        <th className="py-1 text-right">Paid</th>
                      </tr>
                    </thead>
                    <tbody className="tabular-nums">
                      {settlement.shares.map((share) => (
                        <tr key={share.memberId} className="border-t border-white/5">
                          <td className="py-1">{share.memberId}</td>
                          <td className="py-1 text-right">{share.deliveredKwh} kWh</td>
                          <td className="py-1 text-right">{share.sharePct.toFixed(1)}%</td>
                          <td className="py-1 text-right">{formatXlm(share.amountXlm)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t border-white/10 font-semibold">
                        <td className="py-1">Total</td>
                        <td className="py-1 text-right">{settlement.deliveredKwh} kWh</td>
                        <td className="py-1 text-right">100%</td>
                        <td className="py-1 text-right">{formatXlm(settlement.totalXlm)}</td>
                      </tr>
                    </tfoot>
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

function Tile({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-lg border border-white/10 p-4">
      <p className="text-xs opacity-60">{label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums">{value}</p>
      <p className="mt-1 text-xs opacity-70">{detail}</p>
    </div>
  );
}