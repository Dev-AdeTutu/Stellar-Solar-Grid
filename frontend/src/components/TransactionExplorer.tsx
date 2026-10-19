"use client";

import React, { useEffect, useState } from "react";

export type TransactionCategory = "payments" | "registrations" | "transfers" | "admin_actions";

export interface IndexedTransaction {
  txHash: string;
  address: string;
  category: TransactionCategory;
  meterId: string | null;
  amountStroops: number | null;
  assetCode: string;
  status: "success" | "failed";
  ledger: number;
  timestamp: string;
  description: string;
  explorerUrl: string;
}

const CATEGORY_ICONS: Record<TransactionCategory, string> = {
  payments: "💳",
  registrations: "⚡",
  transfers: "🔄",
  admin_actions: "🛡️",
};

const CATEGORY_LABELS: Record<TransactionCategory, string> = {
  payments: "Payment",
  registrations: "Registration",
  transfers: "Transfer",
  admin_actions: "Admin Action",
};

const FALLBACK_TXS: IndexedTransaction[] = [
  {
    txHash: "a1b2c3d4e5f601",
    address: "GABC1234567890SOLARUSER",
    category: "registrations",
    meterId: "meter-101",
    amountStroops: null,
    assetCode: "XLM",
    status: "success",
    ledger: 501200,
    timestamp: "2026-10-10T09:00:00.000Z",
    description: "Registered smart meter #101 on-chain",
    explorerUrl: "https://stellar.expert/explorer/testnet/tx/a1b2c3d4e5f601",
  },
  {
    txHash: "a1b2c3d4e5f602",
    address: "GABC1234567890SOLARUSER",
    category: "payments",
    meterId: "meter-101",
    amountStroops: 250000000,
    assetCode: "XLM",
    status: "success",
    ledger: 501245,
    timestamp: "2026-10-12T14:30:00.000Z",
    description: "Meter balance top-up payment (25 XLM)",
    explorerUrl: "https://stellar.expert/explorer/testnet/tx/a1b2c3d4e5f602",
  },
  {
    txHash: "a1b2c3d4e5f603",
    address: "GABC1234567890SOLARUSER",
    category: "transfers",
    meterId: "meter-102",
    amountStroops: 50000000,
    assetCode: "USDC",
    status: "success",
    ledger: 501310,
    timestamp: "2026-10-14T11:15:00.000Z",
    description: "Transferred energy credit units to meter-102",
    explorerUrl: "https://stellar.expert/explorer/testnet/tx/a1b2c3d4e5f603",
  },
  {
    txHash: "a1b2c3d4e5f604",
    address: "GABC1234567890SOLARUSER",
    category: "admin_actions",
    meterId: "meter-101",
    amountStroops: null,
    assetCode: "XLM",
    status: "success",
    ledger: 501400,
    timestamp: "2026-10-15T18:45:00.000Z",
    description: "Admin tariff parameter update approved",
    explorerUrl: "https://stellar.expert/explorer/testnet/tx/a1b2c3d4e5f604",
  },
];

export const TransactionExplorer: React.FC<{ defaultAddress?: string }> = ({
  defaultAddress = "GABC1234567890SOLARUSER",
}) => {
  const [address, setAddress] = useState(defaultAddress);
  const [typeFilter, setTypeFilter] = useState<string>("");
  const [meterIdFilter, setMeterIdFilter] = useState<string>("");
  const [startDate, setStartDate] = useState<string>("");
  const [endDate, setEndDate] = useState<string>("");
  const [transactions, setTransactions] = useState<IndexedTransaction[]>(FALLBACK_TXS);

  useEffect(() => {
    const params = new URLSearchParams();
    if (typeFilter) params.set("type", typeFilter);
    if (meterIdFilter) params.set("meter_id", meterIdFilter);
    if (startDate) params.set("start_date", startDate);
    if (endDate) params.set("end_date", endDate);

    fetch(`/api/transactions/${encodeURIComponent(address)}?${params.toString()}`)
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((data) => {
        if (Array.isArray(data.transactions)) {
          setTransactions(data.transactions);
        }
      })
      .catch(() => {
        const filtered = FALLBACK_TXS.filter((tx) => {
          if (typeFilter && tx.category !== typeFilter) return false;
          if (meterIdFilter && tx.meterId !== meterIdFilter) return false;
          return true;
        });
        setTransactions(filtered);
      });
  }, [address, typeFilter, meterIdFilter, startDate, endDate]);

  const handleExportCsv = () => {
    const headers = [
      "txHash",
      "timestamp",
      "category",
      "meterId",
      "amountStroops",
      "assetCode",
      "status",
      "ledger",
      "description",
      "explorerUrl",
    ];
    const rows = transactions.map((tx) =>
      [
        tx.txHash,
        tx.timestamp,
        tx.category,
        tx.meterId ?? "",
        tx.amountStroops ?? "",
        tx.assetCode,
        tx.status,
        tx.ledger,
        `"${tx.description.replace(/"/g, '""')}"`,
        tx.explorerUrl,
      ].join(",")
    );
    const csvContent = [headers.join(","), ...rows].join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `transactions-${address}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="p-6 bg-slate-900 text-white rounded-xl border border-slate-800 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold">Blockchain Transaction History Explorer</h2>
          <p className="text-sm text-slate-400">
            On-chain contract events categorized by payments, registrations, transfers, and admin actions.
          </p>
        </div>

        <button
          type="button"
          onClick={handleExportCsv}
          className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 rounded font-medium text-sm"
        >
          Export CSV
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
        <input
          type="text"
          placeholder="Stellar Address (G...)"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          className="bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm"
        />
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          className="bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm"
        >
          <option value="">All Categories</option>
          <option value="payments">Payments</option>
          <option value="registrations">Registrations</option>
          <option value="transfers">Transfers</option>
          <option value="admin_actions">Admin Actions</option>
        </select>
        <input
          type="text"
          placeholder="Filter by Meter ID"
          value={meterIdFilter}
          onChange={(e) => setMeterIdFilter(e.target.value)}
          className="bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm"
        />
        <input
          type="date"
          value={startDate}
          onChange={(e) => setStartDate(e.target.value)}
          className="bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm"
        />
        <input
          type="date"
          value={endDate}
          onChange={(e) => setEndDate(e.target.value)}
          className="bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm"
        />
      </div>

      <div className="space-y-3" data-testid="transaction-timeline">
        {transactions.map((tx) => (
          <div
            key={tx.txHash}
            className="flex items-start justify-between p-4 bg-slate-950 rounded-lg border border-slate-800"
          >
            <div className="flex items-start gap-3">
              <span className="text-2xl" role="img" aria-label={tx.category}>
                {CATEGORY_ICONS[tx.category]}
              </span>
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-sm">{tx.description}</span>
                  <span className="text-xs px-2 py-0.5 bg-slate-800 text-slate-300 rounded">
                    {CATEGORY_LABELS[tx.category]}
                  </span>
                  {tx.meterId && (
                    <span className="text-xs px-2 py-0.5 bg-amber-950 text-amber-300 rounded">
                      {tx.meterId}
                    </span>
                  )}
                </div>
                <div className="text-xs text-slate-400 mt-1">
                  Ledger #{tx.ledger} &bull; {new Date(tx.timestamp).toLocaleString()}
                </div>
              </div>
            </div>

            <div className="text-right space-y-1">
              {tx.amountStroops !== null && (
                <div className="text-sm font-mono font-semibold text-emerald-400">
                  {(tx.amountStroops / 1e7).toFixed(2)} {tx.assetCode}
                </div>
              )}
              <a
                href={tx.explorerUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-sky-400 hover:underline inline-block"
              >
                View on Stellar Explorer &rarr;
              </a>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default TransactionExplorer;
