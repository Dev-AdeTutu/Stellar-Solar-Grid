"use client";

/**
 * Monthly bill history (#902): every bill generated for a meter, with PDF
 * download and a pay link for anything still outstanding.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import Navbar from "@/components/Navbar";
import { usePaymentStore } from "@/store/paymentStore";
import { env } from "@/lib/env";

const API = env.NEXT_PUBLIC_BACKEND_URL;
const STROOPS_PER_XLM = 10_000_000;

type Bill = {
  id: string;
  bill_number: string;
  meter_id: string;
  period: string;
  units: number;
  energy_charge: number;
  discount_percent: number;
  discount_amount: number;
  service_charge: number;
  tax: number;
  total: number;
  status: "issued" | "paid" | "void";
  issued_at: string;
  due_at: string;
  paid_at: string | null;
  payment_link: string;
};

const xlm = (stroops: number) => `${(stroops / STROOPS_PER_XLM).toFixed(2)} XLM`;

function periodLabel(period: string) {
  const [y, m] = period.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
}

function StatusBadge({ bill }: { bill: Bill }) {
  const overdue = bill.status === "issued" && new Date(bill.due_at) < new Date();
  const label = overdue ? "Overdue" : bill.status === "issued" ? "Unpaid" : bill.status === "paid" ? "Paid" : "Void";
  const cls = overdue
    ? "bg-red-500/20 text-red-400"
    : bill.status === "paid"
      ? "bg-green-500/20 text-green-400"
      : "bg-yellow-500/20 text-yellow-400";
  return <span className={`px-2 py-0.5 rounded text-xs font-medium ${cls}`}>{label}</span>;
}

export default function BillsPage() {
  const storedMeter = usePaymentStore((s) => s.meterId);
  const [meterId, setMeterId] = useState("");
  const [query, setQuery] = useState("");
  const [bills, setBills] = useState<Bill[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get("meter");
    const initial = fromUrl ?? storedMeter;
    if (initial) {
      setMeterId(initial);
      setQuery(initial);
    }
  }, [storedMeter]);

  useEffect(() => {
    if (!query) return;
    setLoading(true);
    setError(null);
    fetch(`${API}/api/billing/meters/${encodeURIComponent(query)}/bills`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: { bills: Bill[] }) => setBills(d.bills))
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [query]);

  const outstanding = bills?.filter((b) => b.status === "issued").reduce((sum, b) => sum + b.total, 0) ?? 0;

  return (
    <>
      <Navbar />
      <main className="p-6 max-w-4xl mx-auto">
        <h1 className="text-2xl font-bold mb-1">Bills</h1>
        <p className="text-sm opacity-70 mb-6">
          Bills are generated on the 1st of each month for the previous month&apos;s usage and emailed to the address on
          your billing account.
        </p>

        <form
          className="flex gap-2 mb-6"
          onSubmit={(e) => {
            e.preventDefault();
            setQuery(meterId.trim());
          }}
        >
          <label htmlFor="bill-meter" className="sr-only">
            Meter ID
          </label>
          <input
            id="bill-meter"
            className="flex-1 rounded border px-3 py-2 bg-transparent"
            placeholder="Meter ID"
            value={meterId}
            onChange={(e) => setMeterId(e.target.value)}
          />
          <button type="submit" className="rounded bg-sky-600 px-4 py-2 text-white disabled:opacity-50" disabled={!meterId.trim()}>
            Show bills
          </button>
        </form>

        {loading && <p>Loading…</p>}
        {error && <p className="text-red-500">Failed to load bills: {error}</p>}

        {bills && !loading && (
          <>
            {outstanding > 0 && (
              <p className="mb-4 rounded border border-yellow-500/40 bg-yellow-500/10 p-3 text-sm">
                Outstanding balance: <strong>{xlm(outstanding)}</strong>
              </p>
            )}
            {bills.length === 0 ? (
              <p className="opacity-70">No bills yet for this meter.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left border-b">
                      <th className="py-2">Period</th>
                      <th>Units</th>
                      <th>Total</th>
                      <th>Due</th>
                      <th>Status</th>
                      <th className="text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bills.map((b) => (
                      <tr key={b.id} className="border-b">
                        <td className="py-2">
                          <div>{periodLabel(b.period)}</div>
                          <div className="text-xs opacity-60">{b.bill_number}</div>
                        </td>
                        <td>{b.units}</td>
                        <td title={`Energy ${xlm(b.energy_charge)} · Service ${xlm(b.service_charge)} · Tax ${xlm(b.tax)}`}>
                          {xlm(b.total)}
                          {b.discount_amount > 0 && (
                            <div className="text-xs text-green-500">{b.discount_percent}% community discount</div>
                          )}
                        </td>
                        <td>{new Date(b.due_at).toLocaleDateString()}</td>
                        <td>
                          <StatusBadge bill={b} />
                        </td>
                        <td className="text-right space-x-3 whitespace-nowrap">
                          <a className="underline" href={`${API}/api/billing/bills/${b.id}/pdf`}>
                            PDF
                          </a>
                          {b.status === "issued" && b.total > 0 && (
                            <Link
                              className="underline text-sky-500"
                              href={`/pay?meter=${encodeURIComponent(b.meter_id)}&amount=${(b.total / STROOPS_PER_XLM).toFixed(7)}&bill=${b.id}`}
                            >
                              Pay
                            </Link>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </main>
    </>
  );
}
