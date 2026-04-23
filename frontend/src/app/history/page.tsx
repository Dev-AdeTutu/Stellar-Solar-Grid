"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import Navbar from "@/components/Navbar";
import { useWalletStore } from "@/store/walletStore";
import {
  getPaymentHistory,
  type PaymentRecord,
  type PaymentHistoryResponse,
} from "@/services/paymentService";

type SortField = "date" | "amountXlm" | "plan" | "meterId";
type SortDir = "asc" | "desc";

const NETWORK = process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE?.includes("Test")
  ? "testnet"
  : "mainnet";

const EXPLORER_BASE =
  NETWORK === "testnet"
    ? "https://stellar.expert/explorer/testnet/tx"
    : "https://stellar.expert/explorer/public/tx";

const PAGE_SIZE = 10;

export default function HistoryPage() {
  const { address } = useWalletStore();

  const [records, setRecords] = useState<PaymentRecord[]>([]);
  const [pagination, setPagination] = useState({ page: 1, pages: 1, total: 0 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Client-side sort (within the current page)
  const [sortField, setSortField] = useState<SortField>("date");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const fetchHistory = useCallback(
    async (page: number) => {
      if (!address) return;
      setLoading(true);
      setError(null);
      try {
        // Pass top-level date sort to backend; client handles other columns
        const serverSort = sortField === "date" ? sortDir : "desc";
        const data: PaymentHistoryResponse = await getPaymentHistory(
          address,
          page,
          PAGE_SIZE,
          serverSort
        );
        setRecords(data.payments);
        setPagination({ page: data.pagination.page, pages: data.pagination.pages, total: data.pagination.total });
      } catch (e: any) {
        setError(e.message ?? "Failed to load payment history");
      } finally {
        setLoading(false);
      }
    },
    [address, sortField, sortDir]
  );

  useEffect(() => {
    fetchHistory(1);
  }, [fetchHistory]);

  function handleSort(field: SortField) {
    if (field === sortField) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir("desc");
    }
  }

  const sorted = [...records].sort((a, b) => {
    let cmp = 0;
    if (sortField === "date") cmp = new Date(a.date).getTime() - new Date(b.date).getTime();
    else if (sortField === "amountXlm") cmp = a.amountXlm - b.amountXlm;
    else if (sortField === "plan") cmp = a.plan.localeCompare(b.plan);
    else if (sortField === "meterId") cmp = a.meterId.localeCompare(b.meterId);
    return sortDir === "asc" ? cmp : -cmp;
  });

  function SortIcon({ field }: { field: SortField }) {
    if (sortField !== field) return <span className="ml-1 opacity-30">↕</span>;
    return <span className="ml-1">{sortDir === "asc" ? "↑" : "↓"}</span>;
  }

  const thClass =
    "px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400 cursor-pointer select-none hover:text-solar-yellow transition";

  return (
    <>
      <Navbar />
      <main className="min-h-screen px-4 py-10 max-w-5xl mx-auto">
        <h1 className="text-3xl font-bold text-solar-yellow mb-2">Payment History</h1>
        <p className="text-gray-400 mb-8 text-sm">
          All <code className="text-solar-yellow">make_payment</code> transactions for your wallet.
        </p>

        {!address && (
          <div className="rounded-lg border border-white/10 bg-solar-accent p-8 text-center text-gray-400">
            Connect your wallet to view payment history.
          </div>
        )}

        {address && error && (
          <div className="rounded-lg border border-red-500/40 bg-red-900/20 p-4 text-red-400 text-sm mb-6">
            {error}
          </div>
        )}

        {address && !error && (
          <>
            <div className="overflow-x-auto rounded-xl border border-white/10">
              <table className="w-full text-sm">
                <thead className="bg-solar-accent border-b border-white/10">
                  <tr>
                    <th className={thClass} onClick={() => handleSort("date")}>
                      Date <SortIcon field="date" />
                    </th>
                    <th className={thClass} onClick={() => handleSort("meterId")}>
                      Meter ID <SortIcon field="meterId" />
                    </th>
                    <th className={thClass} onClick={() => handleSort("amountXlm")}>
                      Amount (XLM) <SortIcon field="amountXlm" />
                    </th>
                    <th className={thClass} onClick={() => handleSort("plan")}>
                      Plan <SortIcon field="plan" />
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">
                      Tx Hash
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {loading && (
                    <tr>
                      <td colSpan={5} className="px-4 py-10 text-center text-gray-500">
                        Loading…
                      </td>
                    </tr>
                  )}
                  {!loading && sorted.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-4 py-10 text-center text-gray-500">
                        No payment records found.
                      </td>
                    </tr>
                  )}
                  {!loading &&
                    sorted.map((r, i) => (
                      <tr
                        key={r.txHash || i}
                        className="border-t border-white/5 hover:bg-white/5 transition"
                      >
                        <td className="px-4 py-3 text-gray-300 whitespace-nowrap">
                          {new Date(r.date).toLocaleString()}
                        </td>
                        <td className="px-4 py-3 font-mono text-gray-200">{r.meterId}</td>
                        <td className="px-4 py-3 text-solar-yellow font-semibold">
                          {r.amountXlm.toFixed(4)}
                        </td>
                        <td className="px-4 py-3">
                          <PlanBadge plan={r.plan} />
                        </td>
                        <td className="px-4 py-3 font-mono text-xs">
                          {r.txHash ? (
                            <a
                              href={`${EXPLORER_BASE}/${r.txHash}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-blue-400 hover:text-blue-300 underline underline-offset-2 transition"
                              title={r.txHash}
                            >
                              {r.txHash.slice(0, 8)}…{r.txHash.slice(-6)}
                            </a>
                          ) : (
                            <span className="text-gray-600">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {pagination.pages > 1 && (
              <div className="mt-6 flex items-center justify-between text-sm text-gray-400">
                <span>
                  {pagination.total} record{pagination.total !== 1 ? "s" : ""} total
                </span>
                <div className="flex items-center gap-2">
                  <button
                    disabled={pagination.page <= 1 || loading}
                    onClick={() => fetchHistory(pagination.page - 1)}
                    className="rounded-lg border border-white/10 px-3 py-1.5 hover:border-solar-yellow hover:text-solar-yellow disabled:opacity-30 disabled:cursor-not-allowed transition"
                  >
                    ← Prev
                  </button>
                  <span className="px-2">
                    Page {pagination.page} of {pagination.pages}
                  </span>
                  <button
                    disabled={pagination.page >= pagination.pages || loading}
                    onClick={() => fetchHistory(pagination.page + 1)}
                    className="rounded-lg border border-white/10 px-3 py-1.5 hover:border-solar-yellow hover:text-solar-yellow disabled:opacity-30 disabled:cursor-not-allowed transition"
                  >
                    Next →
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </main>
    </>
  );
}

function PlanBadge({ plan }: { plan: string }) {
  const styles: Record<string, string> = {
    Daily: "bg-blue-900/40 text-blue-300 border-blue-700/40",
    Weekly: "bg-purple-900/40 text-purple-300 border-purple-700/40",
    UsageBased: "bg-green-900/40 text-green-300 border-green-700/40",
    Usage: "bg-green-900/40 text-green-300 border-green-700/40",
  };
  const cls = styles[plan] ?? "bg-gray-800 text-gray-400 border-gray-700/40";
  return (
    <span className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${cls}`}>
      {plan}
    </span>
  );
}
