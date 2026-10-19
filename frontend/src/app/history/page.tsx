"use client";

import { Suspense, useEffect, useState, useCallback, useRef } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import Navbar from "@/components/Navbar";
import { Skeleton } from "@/components/Skeleton";
import { useWalletStore } from "@/store/walletStore";
import { useToast } from "@/components/ToastProvider";
import {
  getPaymentHistory,
  type PaymentRecord,
  type PaymentHistoryResponse,
} from "@/services/paymentService";
import { downloadPaymentReceipt } from "@/lib/receipt";
import ShareReceiptButton from "@/components/ShareReceiptButton";
import { env } from "@/lib/env";
import { formatXlmAmount } from "@/lib/format";

type SortField = "date" | "amountXlm" | "plan" | "meterId";
type SortDir = "asc" | "desc";
type StatusFilter = "All" | "Completed" | "Pending" | "Failed";

const NETWORK = env.NEXT_PUBLIC_NETWORK_PASSPHRASE.includes("Test") ? "testnet" : "mainnet";

const EXPLORER_BASE =
  NETWORK === "testnet"
    ? "https://stellar.expert/explorer/testnet/tx"
    : "https://stellar.expert/explorer/public/tx";

const PAGE_SIZE = 10;
// Safety bound on how many pages CSV export will walk via cursor before
// giving up — prevents a runaway loop if the API ever misbehaves.
const MAX_EXPORT_PAGES = 200;

export const dynamic = "force-dynamic";

export default function HistoryPage() {
  return (
    <Suspense fallback={null}>
      <HistoryPageContent />
    </Suspense>
  );
}

function HistoryPageContent() {
  const { address } = useWalletStore();
  const { showToast } = useToast();
  const searchParams = useSearchParams();
  const router = useRouter();
  const filterMeterId = searchParams.get("meterId");
  const [filtersOpen, setFiltersOpen] = useState(Boolean(searchParams.get("from") || searchParams.get("to") || searchParams.get("min") || searchParams.get("max") || searchParams.get("plan") || searchParams.get("status") || searchParams.get("q")));
  const [fromDate, setFromDate] = useState(searchParams.get("from") ?? "");
  const [toDate, setToDate] = useState(searchParams.get("to") ?? "");
  const [minAmount, setMinAmount] = useState(searchParams.get("min") ?? "");
  const [maxAmount, setMaxAmount] = useState(searchParams.get("max") ?? "");
  const [planFilter, setPlanFilter] = useState(searchParams.get("plan") ?? "All");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>((searchParams.get("status") as StatusFilter) || "All");
  const [query, setQuery] = useState(searchParams.get("q") ?? "");
  const historySectionRef = useRef<HTMLElement | null>(null);

  const [records, setRecords] = useState<PaymentRecord[]>([]);
  // Issue #767: pagination is cursor-based, not offset-based (see
  // services/paymentService.ts). `cursorStack[i]` is the cursor used to
  // fetch the page at index `i`; `pageIndex` tracks which page is current so
  // "Prev" can re-fetch an earlier cursor without losing our place.
  const [cursorStack, setCursorStack] = useState<(string | undefined)[]>([undefined]);
  const [pageIndex, setPageIndex] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sortField, setSortField] = useState<SortField>("date");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [downloadingHash, setDownloadingHash] = useState<string | null>(null);

  function updateFilters(next: Record<string, string>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(next)) { if (value && value !== "All") params.set(key, value); else params.delete(key); }
    router.replace(`/history${params.toString() ? `?${params.toString()}` : ""}`, { scroll: false });
  }
  const activeFilterCount = [fromDate, toDate, minAmount, maxAmount, planFilter !== "All" ? planFilter : "", statusFilter !== "All" ? statusFilter : "", query, filterMeterId ?? ""].filter(Boolean).length;
  function clearFilters() {
    setFromDate(""); setToDate(""); setMinAmount(""); setMaxAmount(""); setPlanFilter("All"); setStatusFilter("All"); setQuery("");
    router.replace("/history", { scroll: false });
  }



  async function handleDownloadReceipt(record: PaymentRecord) {
    if (!record.txHash || downloadingHash) return;
    setDownloadingHash(record.txHash);
    try {
      await downloadPaymentReceipt(record, `${EXPLORER_BASE}/${record.txHash}`);
    } catch (e: any) {
      setError(e.message ?? "Failed to generate receipt");
    } finally {
      setDownloadingHash(null);
    }
  }

  const [exporting, setExporting] = useState(false);

  async function handleExportCsv() {
    if (!address) return;
    setExporting(true);
    try {
      // Walk every page via cursor (rather than requesting one huge "page")
      // so export isn't silently truncated by the server's per-request
      // limit cap — see Issue #767.
      const all: PaymentRecord[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < MAX_EXPORT_PAGES; i++) {
        const data = await getPaymentHistory(address, cursor, 50, sortDir);
        all.push(...data.payments);
        if (!data.pagination?.hasMore || !data.pagination.nextCursor) break;
        cursor = data.pagination.nextCursor;
      }

      const header = "Date,Meter ID,Amount (XLM),Plan,Note,Transaction Hash";
      const rows = all.map((r) =>
        [
          new Date(r.date).toISOString(),
          r.meterId,
          r.amountXlm.toFixed(7),
          r.plan,
          r.memo ? `"${r.memo.replace(/"/g, '""')}"` : "",
          r.txHash || "",
        ].join(","),
      );
      const csv = [header, ...rows].join("\n");
      const blob = new Blob([csv], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `payments-${address.slice(0, 8)}-${Date.now()}.csv`;
      a.click();
      URL.revokeObjectURL(url);

      showToast({
        variant: "success",
        title: "Export Successful",
        description: `Exported ${all.length} records to CSV.`,
      });
    } catch (e: any) {
      setError(e.message ?? "Failed to export history");
      showToast({
        variant: "error",
        title: "Export Failed",
        description: e.message ?? "Failed to export history",
      });
    } finally {
      setExporting(false);
    }
  }

  const fetchHistory = useCallback(
    async (cursor: string | undefined) => {
      if (!address) return;
      setLoading(true);
      setError(null);
      try {
        const serverSort = sortField === "date" ? sortDir : "desc";
        const data: PaymentHistoryResponse = await getPaymentHistory(
          address,
          cursor,
          PAGE_SIZE,
          sortDir,
          { from: fromDate, to: toDate, min: minAmount, max: maxAmount, plan: planFilter, status: statusFilter, q: query },
        );
        if (!data || !data.payments) {
          throw new Error("Invalid response: missing payments data");
        }
        setRecords(data.payments);
        setHasMore(Boolean(data.pagination?.hasMore));
      } catch (e: any) {
        const errorMsg = e.message ?? "Failed to load payment history";
        setError(errorMsg);
        setRecords([]);
        setHasMore(false);
      } finally {
        setLoading(false);
      }
    },
    [address, sortField, sortDir, fromDate, toDate, minAmount, maxAmount, planFilter, statusFilter, query],
  );

  // Changing address or sort order invalidates the cursor stack — the
  // underlying ordering is different, so start over from the first page.
  useEffect(() => {
    setCursorStack([undefined]);
    setPageIndex(0);
    fetchHistory(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, sortField, sortDir]);

  function handlePageChange(direction: "next" | "prev") {
    if (loading) return;
    if (direction === "next") {
      if (!hasMore || records.length === 0) return;
      const lastCursor = records[records.length - 1]?.cursor;
      if (!lastCursor) return;
      const nextIndex = pageIndex + 1;
      setCursorStack((prev) => {
        const next = prev.slice(0, nextIndex);
        next[nextIndex] = lastCursor;
        return next;
      });
      setPageIndex(nextIndex);
      fetchHistory(lastCursor);
    } else {
      if (pageIndex === 0) return;
      const prevIndex = pageIndex - 1;
      setPageIndex(prevIndex);
      fetchHistory(cursorStack[prevIndex]);
    }
    historySectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function handleSort(field: SortField) {
    if (field === sortField) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir("desc");
    }
  }

  const sorted = [...records].filter((r) => {
    const date = new Date(r.date);
    const min = minAmount === "" ? -Infinity : Number(minAmount);
    const max = maxAmount === "" ? Infinity : Number(maxAmount);
    const matchesDate = (!fromDate || date >= new Date(`${fromDate}T00:00:00`)) && (!toDate || date <= new Date(`${toDate}T23:59:59.999`));
    const matchesAmount = r.amountXlm >= min && r.amountXlm <= max;
    const matchesPlan = planFilter === "All" || r.plan === planFilter || (planFilter === "Usage" && r.plan === "UsageBased");
    const matchesStatus = statusFilter === "All" || statusFilter === "Completed";
    const haystack = `${r.txHash} ${r.meterId}`.toLowerCase();
    return (!filterMeterId || r.meterId === filterMeterId) && matchesDate && matchesAmount && matchesPlan && matchesStatus && (!query || haystack.includes(query.toLowerCase()));
  }).sort((a, b) => {
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
    "px-3 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400 cursor-pointer select-none hover:text-solar-yellow transition whitespace-nowrap";

  return (
    <>
      <Navbar />
      <main
        ref={historySectionRef}
        id="main-content"
        tabIndex={-1}
        className="min-h-screen px-4 py-8 max-w-5xl mx-auto"
      >
        <h1 className="text-2xl sm:text-3xl font-bold text-solar-yellow mb-1">Payment History</h1>
        <p className="text-gray-400 mb-3 text-sm">
          All <code className="text-solar-yellow">make_payment</code> transactions for your wallet.
        </p>
        {filterMeterId && (
          <div className="mb-4 inline-flex items-center gap-2 rounded-lg border border-solar-yellow/30 bg-solar-yellow/10 px-3 py-1.5 text-xs text-solar-yellow">
            <span>Filtered by meter:</span>
            <span className="font-mono font-semibold">{filterMeterId}</span>
            <Link
              href="/history"
              className="ml-1 rounded px-1 hover:bg-solar-yellow/20 transition"
              aria-label="Clear filter"
            >
              ✕
            </Link>
          </div>
        )}

        {!address && (
          <div className="rounded-lg border border-white/10 bg-solar-accent p-8 text-center text-gray-400 text-sm">
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
            <section className="mb-5 rounded-xl border border-white/10 bg-solar-accent/60 p-4" aria-label="Transaction filters">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <button type="button" onClick={() => setFiltersOpen((open) => !open)} className="flex items-center gap-2 text-sm font-semibold text-gray-200 hover:text-solar-yellow">
                  Filters {activeFilterCount > 0 && <span className="rounded-full bg-solar-yellow px-2 py-0.5 text-xs font-bold text-solar-dark">{activeFilterCount}</span>} <span aria-hidden="true">{filtersOpen ? "▴" : "▾"}</span>
                </button>
                {activeFilterCount > 0 && <button type="button" onClick={clearFilters} className="text-xs text-gray-400 underline hover:text-solar-yellow">Clear all filters</button>}
              </div>
              {filtersOpen && <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <label className="text-xs text-gray-400">From<input type="date" value={fromDate} onChange={(e) => { setFromDate(e.target.value); updateFilters({from:e.target.value}); }} className="mt-1 w-full rounded-lg border border-white/10 bg-solar-dark px-2 py-2 text-sm text-gray-200" /></label>
                <label className="text-xs text-gray-400">To<input type="date" value={toDate} onChange={(e) => { setToDate(e.target.value); updateFilters({to:e.target.value}); }} className="mt-1 w-full rounded-lg border border-white/10 bg-solar-dark px-2 py-2 text-sm text-gray-200" /></label>
                <label className="text-xs text-gray-400">Min XLM<input type="number" min="0" step="0.0000001" value={minAmount} onChange={(e) => { setMinAmount(e.target.value); updateFilters({min:e.target.value}); }} className="mt-1 w-full rounded-lg border border-white/10 bg-solar-dark px-2 py-2 text-sm text-gray-200" /></label>
                <label className="text-xs text-gray-400">Max XLM<input type="number" min="0" step="0.0000001" value={maxAmount} onChange={(e) => { setMaxAmount(e.target.value); updateFilters({max:e.target.value}); }} className="mt-1 w-full rounded-lg border border-white/10 bg-solar-dark px-2 py-2 text-sm text-gray-200" /></label>
                <label className="text-xs text-gray-400">Payment plan<select value={planFilter} onChange={(e) => { setPlanFilter(e.target.value); updateFilters({plan:e.target.value}); }} className="mt-1 w-full rounded-lg border border-white/10 bg-solar-dark px-2 py-2 text-sm text-gray-200"><option>All</option><option>Daily</option><option>Weekly</option><option>Monthly</option><option>Usage</option></select></label>
                <label className="text-xs text-gray-400">Status<select value={statusFilter} onChange={(e) => { const v=e.target.value as StatusFilter; setStatusFilter(v); updateFilters({status:v}); }} className="mt-1 w-full rounded-lg border border-white/10 bg-solar-dark px-2 py-2 text-sm text-gray-200"><option>All</option><option>Completed</option><option>Pending</option><option>Failed</option></select></label>
                <label className="text-xs text-gray-400 sm:col-span-2">Hash or meter ID<input type="search" value={query} onChange={(e) => { setQuery(e.target.value); updateFilters({q:e.target.value}); }} placeholder="Search transactions…" className="mt-1 w-full rounded-lg border border-white/10 bg-solar-dark px-2 py-2 text-sm text-gray-200" /></label>
              </div>}
            </section>
            <section className="mb-5 rounded-xl border border-white/10 bg-solar-accent/60 p-4" aria-label="Transaction filters">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <button type="button" onClick={() => setFiltersOpen((open) => !open)} className="flex items-center gap-2 text-sm font-semibold text-gray-200 hover:text-solar-yellow">
                  Filters {activeFilterCount > 0 && <span className="rounded-full bg-solar-yellow px-2 py-0.5 text-xs font-bold text-solar-dark">{activeFilterCount}</span>} <span aria-hidden="true">{filtersOpen ? "▴" : "▾"}</span>
                </button>
                {activeFilterCount > 0 && <button type="button" onClick={clearFilters} className="text-xs text-gray-400 underline hover:text-solar-yellow">Clear all filters</button>}
              </div>
              {filtersOpen && <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <label className="text-xs text-gray-400">From<input type="date" value={fromDate} onChange={(e) => { setFromDate(e.target.value); updateFilters({from:e.target.value}); }} className="mt-1 w-full rounded-lg border border-white/10 bg-solar-dark px-2 py-2 text-sm text-gray-200" /></label>
                <label className="text-xs text-gray-400">To<input type="date" value={toDate} onChange={(e) => { setToDate(e.target.value); updateFilters({to:e.target.value}); }} className="mt-1 w-full rounded-lg border border-white/10 bg-solar-dark px-2 py-2 text-sm text-gray-200" /></label>
                <label className="text-xs text-gray-400">Min XLM<input type="number" min="0" step="0.0000001" value={minAmount} onChange={(e) => { setMinAmount(e.target.value); updateFilters({min:e.target.value}); }} className="mt-1 w-full rounded-lg border border-white/10 bg-solar-dark px-2 py-2 text-sm text-gray-200" /></label>
                <label className="text-xs text-gray-400">Max XLM<input type="number" min="0" step="0.0000001" value={maxAmount} onChange={(e) => { setMaxAmount(e.target.value); updateFilters({max:e.target.value}); }} className="mt-1 w-full rounded-lg border border-white/10 bg-solar-dark px-2 py-2 text-sm text-gray-200" /></label>
                <label className="text-xs text-gray-400">Payment plan<select value={planFilter} onChange={(e) => { setPlanFilter(e.target.value); updateFilters({plan:e.target.value}); }} className="mt-1 w-full rounded-lg border border-white/10 bg-solar-dark px-2 py-2 text-sm text-gray-200"><option>All</option><option>Daily</option><option>Weekly</option><option>Monthly</option><option>Usage</option></select></label>
                <label className="text-xs text-gray-400">Status<select value={statusFilter} onChange={(e) => { const v=e.target.value as StatusFilter; setStatusFilter(v); updateFilters({status:v}); }} className="mt-1 w-full rounded-lg border border-white/10 bg-solar-dark px-2 py-2 text-sm text-gray-200"><option>All</option><option>Completed</option><option>Pending</option><option>Failed</option></select></label>
                <label className="text-xs text-gray-400 sm:col-span-2">Hash or meter ID<input type="search" value={query} onChange={(e) => { setQuery(e.target.value); updateFilters({q:e.target.value}); }} placeholder="Search transactions…" className="mt-1 w-full rounded-lg border border-white/10 bg-solar-dark px-2 py-2 text-sm text-gray-200" /></label>
              </div>}
            </section>
            {/* ── Mobile sort control (desktop uses the table's column headers) ── */}
            <div className="sm:hidden flex items-center gap-2 mb-3">
              <label htmlFor="mobile-sort-field" className="text-xs text-gray-400">
                Sort by
              </label>
              <select
                id="mobile-sort-field"
                value={sortField}
                onChange={(e) => handleSort(e.target.value as SortField)}
                className="rounded-lg border border-white/10 bg-solar-accent px-2 py-1.5 text-xs text-gray-200 focus:border-solar-yellow focus:outline-none transition"
              >
                <option value="date">Date</option>
                <option value="amountXlm">Amount</option>
                <option value="plan">Plan</option>
                <option value="meterId">Meter ID</option>
              </select>
              <button
                type="button"
                onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
                aria-label={`Sort direction: ${sortDir === "asc" ? "ascending" : "descending"}. Tap to toggle.`}
                className="rounded-lg border border-white/10 px-2.5 py-1.5 text-xs text-gray-300 hover:border-solar-yellow hover:text-solar-yellow transition"
              >
                {sortDir === "asc" ? "↑ Asc" : "↓ Desc"}
              </button>
            </div>

            {/* ── Mobile card list (hidden on sm+) ── */}
            <div className="sm:hidden space-y-3">
              {loading && [0, 1, 2, 3].map((i) => (
                <div key={i} className="rounded-xl border border-white/10 bg-solar-accent p-4 space-y-2">
                  <div className="flex items-center justify-between">
                    <Skeleton width="35%" height={18} />
                    <Skeleton width="22%" height={22} />
                  </div>
                  <Skeleton width="50%" height={12} />
                  <Skeleton width="60%" height={12} />
                </div>
              ))}
              {!loading && sorted.length === 0 && <EmptyState />}
              {!loading &&
                sorted.map((r, i) => (
                  <div
                    key={r.txHash || i}
                    className="rounded-xl border border-white/10 bg-solar-accent p-4 space-y-2"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-solar-yellow font-bold text-base">
                        {formatXlmAmount(r.amountXlm)} XLM
                      </span>
                      <PlanBadge plan={r.plan} />
                    </div>
                    <div className="text-xs text-gray-400">{new Date(r.date).toLocaleString()}</div>
                    <div className="text-xs text-gray-300 font-mono">Meter: {r.meterId}</div>
                    {r.memo && (
                      <div className="text-xs text-gray-400 italic truncate" title={r.memo}>
                        “{r.memo}”
                      </div>
                    )}
                    {r.txHash && (
                      <a
                        href={`${EXPLORER_BASE}/${r.txHash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block text-xs text-blue-400 underline underline-offset-2 font-mono truncate"
                      >
                        {r.txHash.slice(0, 10)}…{r.txHash.slice(-8)} ↗
                      </a>
                    )}
                    {r.txHash && (
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => handleDownloadReceipt(r)}
                          disabled={downloadingHash === r.txHash}
                          aria-label={`Download receipt for payment on ${new Date(r.date).toLocaleDateString()}`}
                          className="flex-1 rounded-lg border border-white/10 px-3 py-2 text-xs text-gray-300 hover:border-solar-yellow hover:text-solar-yellow transition disabled:opacity-50"
                        >
                          {downloadingHash === r.txHash ? "Generating…" : "Download Receipt"}
                        </button>
                        <ShareReceiptButton
                          record={r}
                          explorerUrl={`${EXPLORER_BASE}/${r.txHash}`}
                          className="rounded-lg border border-white/10 px-3 py-2 text-xs text-gray-300 hover:border-solar-yellow hover:text-solar-yellow transition disabled:opacity-50"
                        />
                      </div>
                    )}
                  </div>
                ))}
            </div>

            {/* ── Desktop table (hidden below sm) ── */}
            <div
              className="hidden sm:block overflow-x-auto rounded-xl border border-white/10"
              style={{ WebkitOverflowScrolling: "touch" }}
            >
              <table className="w-full text-sm min-w-[600px]">
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
                    <th className="px-3 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400 whitespace-nowrap">
                      Tx Hash
                    </th>
                    <th className="px-3 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400 whitespace-nowrap">
                      Receipt
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {loading &&
                    [0, 1, 2, 3, 4].map((i) => (
                      <tr key={i} className="border-t border-white/5">
                        <td className="px-3 py-3"><Skeleton width="80%" height={14} /></td>
                        <td className="px-3 py-3"><Skeleton width="65%" height={14} /></td>
                        <td className="px-3 py-3"><Skeleton width="50%" height={14} /></td>
                        <td className="px-3 py-3"><Skeleton width="55%" height={20} /></td>
                        <td className="px-3 py-3"><Skeleton width="70%" height={14} /></td>
                        <td className="px-3 py-3"><Skeleton width="60%" height={14} /></td>
                      </tr>
                    ))}
                  {!loading && sorted.length === 0 && (
                    <tr>
                      <td colSpan={6}>
                        <EmptyState />
                      </td>
                    </tr>
                  )}
                  {!loading &&
                    sorted.map((r, i) => (
                      <tr
                        key={r.txHash || i}
                        className="border-t border-white/5 hover:bg-white/5 transition"
                      >
                        <td className="px-3 py-3 text-gray-300 whitespace-nowrap text-xs">
                          {new Date(r.date).toLocaleString()}
                        </td>
                        <td className="px-3 py-3 font-mono text-gray-200 text-xs">
                          {r.meterId}
                          {r.memo && (
                            <div
                              className="mt-0.5 max-w-[16rem] truncate font-sans italic text-gray-500"
                              title={r.memo}
                            >
                              “{r.memo}”
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-3 text-solar-yellow font-semibold text-xs">
                          {formatXlmAmount(r.amountXlm)}
                        </td>
                        <td className="px-3 py-3">
                          <PlanBadge plan={r.plan} />
                        </td>
                        <td className="px-3 py-3 font-mono text-xs">
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
                        <td className="px-3 py-3 text-xs">
                          {r.txHash ? (
                            <div className="flex gap-2">
                              <button
                                type="button"
                                onClick={() => handleDownloadReceipt(r)}
                                disabled={downloadingHash === r.txHash}
                                aria-label={`Download receipt for payment on ${new Date(r.date).toLocaleDateString()}`}
                                className="rounded-lg border border-white/10 px-3 py-1.5 text-gray-300 hover:border-solar-yellow hover:text-solar-yellow transition disabled:opacity-50 whitespace-nowrap"
                              >
                                {downloadingHash === r.txHash ? "Generating…" : "Download"}
                              </button>
                              <ShareReceiptButton record={r} explorerUrl={`${EXPLORER_BASE}/${r.txHash}`} />
                            </div>
                          ) : (
                            <span className="text-gray-600">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>

            {/* Action Bar (Export CSV & Pagination) */}
            {sorted.length > 0 && (
              <div className="mt-6 flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-gray-400 border-t border-white/5 pt-6">
                <div>
                  <button
                    onClick={handleExportCsv}
                    disabled={exporting}
                    className="rounded-lg border border-white/10 px-4 py-2 text-sm text-gray-300 hover:border-solar-yellow hover:text-solar-yellow disabled:opacity-30 disabled:cursor-not-allowed transition"
                  >
                    {exporting ? "Exporting..." : "Export CSV"}
                  </button>
                </div>

                {(pageIndex > 0 || hasMore) && (
                  <div className="flex items-center gap-2">
                    <button
                      disabled={pageIndex <= 0 || loading}
                      onClick={() => handlePageChange("prev")}
                      className="rounded-lg border border-white/10 px-4 py-2 hover:border-solar-yellow hover:text-solar-yellow disabled:opacity-30 disabled:cursor-not-allowed transition"
                    >
                      ← Prev
                    </button>
                    <span className="px-2 text-xs">Page {pageIndex + 1}</span>
                    <button
                      disabled={!hasMore || loading}
                      onClick={() => handlePageChange("next")}
                      className="rounded-lg border border-white/10 px-4 py-2 hover:border-solar-yellow hover:text-solar-yellow disabled:opacity-30 disabled:cursor-not-allowed transition"
                    >
                      Next →
                    </button>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </main>
    </>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
      <svg
        width="80"
        height="80"
        viewBox="0 0 80 80"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        <circle cx="40" cy="40" r="38" stroke="#374151" strokeWidth="2" />
        <path
          d="M40 22 L40 42 M34 30 L40 22 L46 30"
          stroke="#F59E0B"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <rect x="26" y="44" width="28" height="4" rx="2" fill="#374151" />
        <rect x="30" y="52" width="20" height="4" rx="2" fill="#374151" />
      </svg>
      <h3 className="mt-5 text-base font-semibold text-white">No payment history yet</h3>
      <p className="mt-1.5 text-sm text-gray-400 max-w-xs">
        Your transactions will appear here once you make a payment.
      </p>
      <Link
        href="/pay"
        className="mt-6 rounded-lg bg-solar-yellow px-5 py-2.5 text-sm font-semibold text-solar-dark hover:opacity-90 transition"
      >
        Make your first payment
      </Link>
    </div>
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
    <span
      className={`rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap ${cls}`}
    >
      {plan}
    </span>
  );
}
