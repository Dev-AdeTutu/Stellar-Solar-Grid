"use client";

import { useState, useMemo } from "react";
import { type MeterData } from "@/services/meterService";

type SortField = "meter_id" | "owner" | "balance" | "units_used" | "expires_at" | "status";
type SortOrder = "asc" | "desc";

interface MeterComparisonProps {
  meters: MeterData[];
  isLoading?: boolean;
}

export function MeterComparison({ meters, isLoading = false }: MeterComparisonProps) {
  const [sortField, setSortField] = useState<SortField>("meter_id");
  const [sortOrder, setSortOrder] = useState<SortOrder>("asc");
  const [viewMode, setViewMode] = useState<"table" | "card">("table");

  const sortedMeters = useMemo(() => {
    const sorted = [...meters].sort((a, b) => {
      let aVal: any;
      let bVal: any;

      switch (sortField) {
        case "meter_id":
          aVal = a.meter_id || "";
          bVal = b.meter_id || "";
          break;
        case "owner":
          aVal = a.owner;
          bVal = b.owner;
          break;
        case "balance":
          aVal = Number(a.balance || 0);
          bVal = Number(b.balance || 0);
          break;
        case "units_used":
          aVal = Number(a.units_used || 0);
          bVal = Number(b.units_used || 0);
          break;
        case "expires_at":
          aVal = Number(a.expires_at || 0);
          bVal = Number(b.expires_at || 0);
          break;
        case "status":
          aVal = a.active ? 1 : 0;
          bVal = b.active ? 1 : 0;
          break;
        default:
          return 0;
      }

      if (typeof aVal === "string") {
        return sortOrder === "asc" ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
      }
      return sortOrder === "asc" ? aVal - bVal : bVal - aVal;
    });

    return sorted;
  }, [meters, sortField, sortOrder]);

  const getHighestLowestValues = useMemo(() => {
    if (sortedMeters.length === 0) return { highest: {}, lowest: {} };

    const balances = sortedMeters.map((m) => Number(m.balance || 0));
    const usages = sortedMeters.map((m) => Number(m.units_used || 0));

    return {
      highest: {
        balance: Math.max(...balances),
        units_used: Math.max(...usages),
      },
      lowest: {
        balance: Math.min(...balances),
        units_used: Math.min(...usages),
      },
    };
  }, [sortedMeters]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortOrder(sortOrder === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortOrder("asc");
    }
  };

  const exportToCSV = () => {
    const headers = [
      "Meter ID",
      "Owner",
      "Status",
      "Balance (stroops)",
      "Units Used (milli-kWh)",
      "Last Payment",
      "Expires At",
    ];
    const rows = sortedMeters.map((m) => [
      m.meter_id || "",
      m.owner,
      m.active ? "Active" : "Inactive",
      String(m.balance || 0),
      String(m.units_used || 0),
      new Date(Number(m.last_payment || 0) * 1000).toISOString(),
      new Date(Number(m.expires_at || 0) * 1000).toISOString(),
    ]);

    const csvContent = [
      headers.join(","),
      ...rows.map((r) => r.map((cell) => `"${cell}"`).join(",")),
    ].join("\n");

    const blob = new Blob([csvContent], { type: "text/csv" });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `meter-comparison-${Date.now()}.csv`;
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    document.body.removeChild(a);
  };

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) return <span className="text-gray-500">⇅</span>;
    return sortOrder === "asc" ? <span className="text-solar-yellow">↑</span> : <span className="text-solar-yellow">↓</span>;
  };

  const getBalanceColor = (balance: bigint) => {
    const val = Number(balance || 0);
    const highest = getHighestLowestValues.highest.balance;
    if (val === highest) return "bg-green-900/20";
    return "";
  };

  const getUsageColor = (usage: bigint) => {
    const val = Number(usage || 0);
    const highest = getHighestLowestValues.highest.units_used;
    if (val === highest) return "bg-blue-900/20";
    return "";
  };

  if (isLoading) {
    return (
      <div className="w-full h-96 flex items-center justify-center">
        <p className="text-gray-400">Loading meters...</p>
      </div>
    );
  }

  if (sortedMeters.length === 0) {
    return (
      <div className="w-full text-center py-12">
        <p className="text-gray-400">No meters to compare</p>
      </div>
    );
  }

  return (
    <div className="w-full space-y-4">
      {/* Controls */}
      <div className="flex flex-wrap gap-3 items-center justify-between">
        <div className="flex gap-2">
          <button
            onClick={() => setViewMode("table")}
            className={`px-4 py-2 rounded-lg font-medium transition ${
              viewMode === "table"
                ? "bg-solar-yellow text-solar-dark"
                : "bg-solar-accent text-gray-300 hover:bg-solar-accent/80"
            }`}
          >
            Table View
          </button>
          <button
            onClick={() => setViewMode("card")}
            className={`px-4 py-2 rounded-lg font-medium transition ${
              viewMode === "card"
                ? "bg-solar-yellow text-solar-dark"
                : "bg-solar-accent text-gray-300 hover:bg-solar-accent/80"
            }`}
          >
            Card View
          </button>
        </div>
        <button
          onClick={exportToCSV}
          className="px-4 py-2 rounded-lg bg-solar-accent text-gray-300 hover:bg-solar-accent/80 font-medium transition flex items-center gap-2"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2m0 0v-8m0 8l-6-4m6 4l6-4" />
          </svg>
          Export CSV
        </button>
      </div>

      {/* Table View */}
      {viewMode === "table" && (
        <div className="overflow-x-auto rounded-xl border border-white/10">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/10 bg-solar-accent/30">
                <th className="px-4 py-3 text-left font-medium text-gray-300 cursor-pointer hover:text-solar-yellow transition" onClick={() => handleSort("meter_id")}>
                  Meter ID <SortIcon field="meter_id" />
                </th>
                <th className="px-4 py-3 text-left font-medium text-gray-300 cursor-pointer hover:text-solar-yellow transition" onClick={() => handleSort("status")}>
                  Status <SortIcon field="status" />
                </th>
                <th className="px-4 py-3 text-right font-medium text-gray-300 cursor-pointer hover:text-solar-yellow transition" onClick={() => handleSort("balance")}>
                  Balance <SortIcon field="balance" />
                </th>
                <th className="px-4 py-3 text-right font-medium text-gray-300 cursor-pointer hover:text-solar-yellow transition" onClick={() => handleSort("units_used")}>
                  Usage (mWh) <SortIcon field="units_used" />
                </th>
                <th className="px-4 py-3 text-left font-medium text-gray-300">Expires</th>
                <th className="px-4 py-3 text-left font-medium text-gray-300">Days Left</th>
              </tr>
            </thead>
            <tbody>
              {sortedMeters.map((meter) => {
                const now = Math.floor(Date.now() / 1000);
                const expiresIn = Math.max(0, (Number(meter.expires_at || 0) - now) / 86400);
                const expiryDate = new Date(Number(meter.expires_at || 0) * 1000);

                return (
                  <tr key={meter.meter_id} className="border-b border-white/5 hover:bg-white/5 transition">
                    <td className="px-4 py-3 font-mono text-white">{meter.meter_id || "—"}</td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-1 rounded text-xs font-medium ${meter.active ? "bg-green-900/30 text-green-300" : "bg-red-900/30 text-red-300"}`}>
                        {meter.active ? "Active" : "Inactive"}
                      </span>
                    </td>
                    <td className={`px-4 py-3 text-right font-mono text-gray-300 ${getBalanceColor(meter.balance)}`}>
                      {Number(meter.balance || 0).toLocaleString()}
                    </td>
                    <td className={`px-4 py-3 text-right font-mono text-gray-300 ${getUsageColor(meter.units_used)}`}>
                      {Number(meter.units_used || 0).toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-gray-400 text-xs">{expiryDate.toLocaleDateString()}</td>
                    <td className="px-4 py-3">
                      <span className={`text-sm font-medium ${expiresIn > 7 ? "text-green-400" : expiresIn > 1 ? "text-yellow-400" : "text-red-400"}`}>
                        {expiresIn.toFixed(1)}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Card View */}
      {viewMode === "card" && (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {sortedMeters.map((meter) => {
            const now = Math.floor(Date.now() / 1000);
            const expiresIn = Math.max(0, (Number(meter.expires_at || 0) - now) / 86400);
            const costPerDay = expiresIn > 0 ? Number(meter.balance || 0) / expiresIn : 0;

            return (
              <div key={meter.meter_id} className="rounded-xl border border-white/10 bg-solar-accent p-4 space-y-3">
                <div className="flex items-start justify-between">
                  <div>
                    <p className="font-mono text-sm text-solar-yellow">{meter.meter_id || "—"}</p>
                    <p className="text-xs text-gray-500 truncate">{meter.owner}</p>
                  </div>
                  <span className={`px-2 py-1 rounded text-xs font-medium ${meter.active ? "bg-green-900/30 text-green-300" : "bg-red-900/30 text-red-300"}`}>
                    {meter.active ? "Active" : "Inactive"}
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <p className="text-gray-500 text-xs">Balance</p>
                    <p className="font-mono text-white">{Number(meter.balance || 0).toLocaleString()}</p>
                  </div>
                  <div>
                    <p className="text-gray-500 text-xs">Usage</p>
                    <p className="font-mono text-white">{Number(meter.units_used || 0).toLocaleString()} mWh</p>
                  </div>
                  <div>
                    <p className="text-gray-500 text-xs">Cost/Day</p>
                    <p className="font-mono text-white">{costPerDay.toFixed(0)}</p>
                  </div>
                  <div>
                    <p className="text-gray-500 text-xs">Days Left</p>
                    <p className={`font-mono ${expiresIn > 7 ? "text-green-400" : expiresIn > 1 ? "text-yellow-400" : "text-red-400"}`}>
                      {expiresIn.toFixed(1)}
                    </p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
