"use client";

/**
 * Renewable Energy Credit marketplace (#927).
 *
 * Issues RECs (registry view), shows the price-discovery snapshot, and lets a
 * producer list units and a buyer bid and settle — the same flow the Soroban
 * contract enforces.
 */
import { useCallback, useEffect, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import Navbar from "@/components/Navbar";
import {
  COMPLIANCE_BADGE,
  REC_PRICE_SCALE,
  cancelOrder,
  executeTrade,
  fetchMarket,
  fetchOrders,
  fetchRecs,
  fetchTrades,
  listSell,
  priceToUnits,
  submitBid,
  type Rec,
  type RecMarket,
  type RecOrder,
  type RecTrade,
} from "@/lib/recs";

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
.viz-root [data-slot="1"] { fill: var(--series-1); }
.viz-root [data-slot="2"] { fill: var(--series-2); }
.viz-root [data-slot="3"] { fill: var(--series-3); }
`;

const TOOLTIP_STYLE = {
  background: "var(--tooltip-bg)",
  color: "var(--tooltip-ink)",
  border: "1px solid var(--grid)",
  borderRadius: 6,
  fontSize: 12,
};
const AXIS = { stroke: "var(--axis)", fontSize: 11, tickLine: false } as const;
const PRICE_COLORS = ["var(--series-1)", "var(--series-2)", "var(--series-3)"];

export default function RecMarketplacePage() {
  const [market, setMarket] = useState<RecMarket | null>(null);
  const [recs, setRecs] = useState<Rec[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [asks, setAsks] = useState<RecOrder[]>([]);
  const [trades, setTrades] = useState<RecTrade[]>([]);
  const [party, setParty] = useState("GALICE");
  const [units, setUnits] = useState("1");
  const [price, setPrice] = useState("12.5");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const priceMicro = Math.round(Number(price) * REC_PRICE_SCALE);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [m, r] = await Promise.all([fetchMarket(), fetchRecs()]);
      setMarket(m);
      setRecs(r);
      if (m.recs.length > 0) setSelected((prev) => prev || m.recs[0]!.recId);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const refreshBook = useCallback(async () => {
    if (!selected) return;
    try {
      const [a, t] = await Promise.all([fetchOrders(selected, "sell"), fetchTrades(selected)]);
      setAsks(a);
      setTrades(t);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [selected]);

  useEffect(() => {
    refresh();
  }, [refresh]);
  useEffect(() => {
    refreshBook();
  }, [refreshBook]);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await refresh();
      await refreshBook();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const summary = market?.recs.find((entry) => entry.recId === selected);
  const priceRows = market?.recs
    .filter((entry) => entry.lastPriceMicro > 0 || entry.indexPriceMicro > 0)
    .map((entry) => ({
      recId: entry.recId.slice(-8),
      last: entry.lastPriceMicro / REC_PRICE_SCALE,
      index: entry.indexPriceMicro / REC_PRICE_SCALE,
    }));

  return (
    <>
      <Navbar />
      <style>{TOKENS}</style>
      <main className="viz-root mx-auto max-w-6xl p-6">
        <h1 className="mb-1 text-2xl font-bold">Renewable energy credits</h1>
        <p className="mb-4 text-sm opacity-70">
          One REC is 1 MWh of verified renewable generation. Credits only trade once the compliance
          authority has attested them, and every fill settles immediately.
        </p>

        {error && <p className="mb-4 rounded border border-red-500/40 bg-red-900/20 p-3 text-sm text-red-300">{error}</p>}

        {!market || market.recs.length === 0 ? (
          <p className="text-sm opacity-60">
            No credits issued yet. A registry issues credits from metered generation.
          </p>
        ) : (
          <div className="space-y-6">
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Tile label="Credits issued" value={`${market.totalIssuedUnits} MWh`} detail={`${market.verifiedRecs} verified`} />
              <Tile label="Traded" value={`${market.totalTradedUnits} MWh`} detail={`${market.totalTradedValue.toFixed(2)} XLM settled`} />
              <Tile
                label="Best ask"
                value={priceToUnits(summary?.bestAskMicro)}
                detail={summary ? `${summary.openAsks} open asks` : "—"}
              />
              <Tile
                label="Volume-weighted index"
                value={priceToUnits(summary?.indexPriceMicro)}
                detail={summary ? `${summary.tradeCount} trades` : "—"}
              />
            </div>

            <div className="grid gap-6 lg:grid-cols-2">
              <section className="rounded-lg border border-white/10 p-4">
                <label htmlFor="rec-select" className="text-sm font-semibold">
                  Credit
                </label>
                <select
                  id="rec-select"
                  className="mt-2 w-full rounded border bg-transparent px-2 py-1.5 text-sm"
                  value={selected}
                  onChange={(e) => setSelected(e.target.value)}
                >
                  {market.recs.map((entry) => (
                    <option key={entry.recId} value={entry.recId}>
                      {entry.recId} · {entry.tradeCount} trades
                    </option>
                  ))}
                </select>

                <h2 className="mt-4 text-sm font-semibold">Sell orders</h2>
                {asks.length === 0 ? (
                  <p className="mt-1 text-sm opacity-60">No open asks.</p>
                ) : (
                  <div className="mt-2 h-56">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={asks.map((a) => ({ units: a.remaining, price: a.priceMicro / REC_PRICE_SCALE }))} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                        <CartesianGrid stroke="var(--grid)" vertical={false} />
                        <XAxis dataKey="units" {...AXIS} />
                        <YAxis {...AXIS} width={48} />
                        <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: "var(--grid)" }} />
                        <Bar dataKey="price" name="Ask price" radius={[4, 4, 0, 0]} isAnimationActive={false}>
                          {asks.map((_, i) => (
                            <Cell key={i} fill={PRICE_COLORS[i % PRICE_COLORS.length]} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </section>

              <section className="rounded-lg border border-white/10 p-4">
                <h2 className="text-sm font-semibold">Market prices</h2>
                {!priceRows || priceRows.length === 0 ? (
                  <p className="mt-2 text-sm opacity-60">Nothing has traded yet, so there is no price.</p>
                ) : (
                  <div className="mt-2 h-56">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={priceRows} layout="vertical" margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barGap={4}>
                        <CartesianGrid stroke="var(--grid)" horizontal={false} />
                        <XAxis type="number" {...AXIS} />
                        <YAxis type="category" dataKey="recId" {...AXIS} width={72} />
                        <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: "var(--grid)" }} formatter={(v: number) => [v.toFixed(3), "XLM / REC"]} />
                        <Bar dataKey="last" name="Last traded" fill="var(--series-1)" isAnimationActive={false} />
                        <Bar dataKey="index" name="VWAP index" fill="var(--series-2)" isAnimationActive={false} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </section>
            </div>

            <section className="rounded-lg border border-white/10 p-4">
              <h2 className="text-sm font-semibold">Trade</h2>
              <div className="mt-2 flex flex-wrap items-end gap-2 text-sm">
                <label className="flex flex-col gap-1">
                  <span className="text-xs opacity-60">Account</span>
                  <input
                    className="rounded border bg-transparent px-2 py-1"
                    value={party}
                    onChange={(e) => setParty(e.target.value)}
                    aria-label="Account ID"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs opacity-60">Units</span>
                  <input
                    className="rounded border bg-transparent px-2 py-1"
                    type="number"
                    min={1}
                    value={units}
                    onChange={(e) => setUnits(e.target.value)}
                    aria-label="Units"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs opacity-60">Price (XLM / REC)</span>
                  <input
                    className="rounded border bg-transparent px-2 py-1"
                    type="number"
                    step="0.001"
                    min={0}
                    value={price}
                    onChange={(e) => setPrice(e.target.value)}
                    aria-label="Price in XLM per REC"
                  />
                </label>
                <button
                  type="button"
                  disabled={busy}
                  className="rounded border border-white/20 px-3 py-1 disabled:opacity-50"
                  onClick={() => run(() => listSell(selected, { ownerId: party, units: Number(units), priceMicro }))}
                >
                  List ask
                </button>
                <button
                  type="button"
                  disabled={busy}
                  className="rounded border border-white/20 px-3 py-1 disabled:opacity-50"
                  onClick={() => run(() => submitBid(selected, { ownerId: party, units: Number(units), priceMicro }))}
                >
                  Place bid
                </button>
              </div>

              {asks.length > 0 && (
                <table className="mt-4 w-full text-sm">
                  <thead className="text-left text-xs opacity-60">
                    <tr>
                      <th className="py-1">Seller</th>
                      <th className="py-1 text-right">Units</th>
                      <th className="py-1 text-right">Price</th>
                      <th className="py-1" />
                    </tr>
                  </thead>
                  <tbody className="tabular-nums">
                    {asks.map((ask) => (
                      <tr key={ask.id} className="border-t border-white/5">
                        <td className="py-1">{ask.ownerId}</td>
                        <td className="py-1 text-right">{ask.remaining}</td>
                        <td className="py-1 text-right">{priceToUnits(ask.priceMicro)}</td>
                        <td className="py-1 text-right">
                          <button
                            type="button"
                            disabled={busy}
                            className="text-xs underline opacity-70 hover:opacity-100 disabled:opacity-40"
                            onClick={() => run(() => cancelOrder(ask.id, party))}
                          >
                            Cancel
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            <section className="rounded-lg border border-white/10 p-4">
              <h2 className="text-sm font-semibold">Place a bid and settle</h2>
              <p className="mt-1 text-xs opacity-60">
                A bid crosses every resting ask priced at or below it, cheapest first, at the
                seller&apos;s price. Fills transfer credits and settle XLM in the same call.
              </p>
              <BidExecutor recId={selected} buyerId={party} onSettled={run} busy={busy} />
            </section>

            <section className="rounded-lg border border-white/10 p-4">
              <h2 className="text-sm font-semibold">Issued credits</h2>
              <div className="mt-2 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs opacity-60">
                    <tr>
                      <th className="py-1">Credit</th>
                      <th className="py-1">Meter</th>
                      <th className="py-1 text-right">Units</th>
                      <th className="py-1 text-right">Available</th>
                      <th className="py-1">Compliance</th>
                    </tr>
                  </thead>
                  <tbody className="tabular-nums">
                    {recs.map((rec) => (
                      <tr key={rec.id} className="border-t border-white/5">
                        <td className="py-1">{rec.id}</td>
                        <td className="py-1">{rec.meterId}</td>
                        <td className="py-1 text-right">{rec.totalUnits}</td>
                        <td className="py-1 text-right">{rec.availableUnits}</td>
                        <td className="py-1">
                          <span className={`rounded-full px-2 py-0.5 text-xs ${COMPLIANCE_BADGE[rec.compliance]}`}>
                            {rec.compliance}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="rounded-lg border border-white/10 p-4">
              <h2 className="text-sm font-semibold">Settled trades</h2>
              {trades.length === 0 ? (
                <p className="mt-1 text-sm opacity-60">No trades yet.</p>
              ) : (
                <table className="mt-2 w-full text-sm">
                  <thead className="text-left text-xs opacity-60">
                    <tr>
                      <th className="py-1">Seller</th>
                      <th className="py-1">Buyer</th>
                      <th className="py-1 text-right">Units</th>
                      <th className="py-1 text-right">Price</th>
                      <th className="py-1 text-right">Fee</th>
                      <th className="py-1 text-right">Seller receives</th>
                    </tr>
                  </thead>
                  <tbody className="tabular-nums">
                    {trades.map((trade) => (
                      <tr key={trade.id} className="border-t border-white/5">
                        <td className="py-1">{trade.sellerId}</td>
                        <td className="py-1">{trade.buyerId}</td>
                        <td className="py-1 text-right">{trade.units}</td>
                        <td className="py-1 text-right">{priceToUnits(trade.priceMicro)}</td>
                        <td className="py-1 text-right">{trade.fee.toFixed(4)}</td>
                        <td className="py-1 text-right">{trade.proceeds.toFixed(4)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          </div>
        )}
      </main>
    </>
  );
}

/** Bid entry plus the execute action, kept separate to avoid remounting the form. */
function BidExecutor({
  recId,
  buyerId,
  busy,
  onSettled,
}: {
  recId: string;
  buyerId: string;
  busy: boolean;
  onSettled: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const [units, setUnits] = useState("1");
  const [price, setPrice] = useState("20");
  const [orderId, setOrderId] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const priceMicro = Math.round(Number(price) * REC_PRICE_SCALE);

  return (
    <div className="mt-3 flex flex-wrap items-end gap-2 text-sm">
      <label className="flex flex-col gap-1">
        <span className="text-xs opacity-60">Bid units</span>
        <input className="rounded border bg-transparent px-2 py-1" type="number" min={1} value={units} onChange={(e) => setUnits(e.target.value)} aria-label="Bid units" />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs opacity-60">Bid price</span>
        <input className="rounded border bg-transparent px-2 py-1" type="number" step="0.001" min={0} value={price} onChange={(e) => setPrice(e.target.value)} aria-label="Bid price" />
      </label>
      <button
        type="button"
        disabled={busy || !recId}
        className="rounded border border-white/20 px-3 py-1 disabled:opacity-50"
        onClick={async () => {
          const order = await submitBid(recId, { ownerId: buyerId, units: Number(units), priceMicro });
          setOrderId(order.id);
          setResult(`Bid ${order.id} posted for ${order.remaining} REC.`);
        }}
      >
        Post bid
      </button>
      <button
        type="button"
        disabled={busy || !orderId}
        className="rounded border border-white/20 px-3 py-1 disabled:opacity-50"
        onClick={() =>
          onSettled(async () => {
            const filled = await executeTrade(orderId, buyerId);
            setResult(
              filled.length === 0
                ? "No ask was crossed — the bid stays open."
                : `Settled ${filled.length} fill(s): ${filled
                    .map((t) => `${t.units} REC @ ${priceToUnits(t.priceMicro)}`)
                    .join(", ")}.`,
            );
            setOrderId("");
          })
        }
      >
        Match and settle
      </button>
      {result && <p className="text-xs opacity-80">{result}</p>}
    </div>
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