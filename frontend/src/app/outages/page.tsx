"use client";

import React, { useState, useEffect } from "react";
import Navbar from "@/components/Navbar";

export interface Outage {
  id: string;
  region: string;
  affectedMeters: string[];
  startedAt: string;
  status: "active" | "resolved";
  estimatedRestorationAt: string;
  cause: string;
  severity: "minor" | "moderate" | "major" | "critical";
}

export default function OutagesPage() {
  const [outages, setOutages] = useState<Outage[]>([
    {
      id: "outage-101",
      region: "North Sector Grid B",
      affectedMeters: ["MTR-8821", "MTR-8822", "MTR-8825"],
      startedAt: new Date(Date.now() - 45 * 60 * 1000).toISOString(),
      status: "active",
      estimatedRestorationAt: new Date(Date.now() + 75 * 60 * 1000).toISOString(),
      cause: "High voltage transmission surge — auto breaker trip",
      severity: "major",
    },
    {
      id: "outage-100",
      region: "East Substation 4",
      affectedMeters: ["MTR-1209"],
      startedAt: new Date(Date.now() - 3 * 3600 * 1000).toISOString(),
      status: "resolved",
      estimatedRestorationAt: new Date(Date.now() - 1 * 3600 * 1000).toISOString(),
      cause: "Routine feeder maintenance",
      severity: "minor",
    },
  ]);

  const [activeFilter, setActiveFilter] = useState<"all" | "active" | "resolved">("all");
  const [reportRegion, setReportRegion] = useState("");
  const [reportMeterId, setReportMeterId] = useState("");
  const [reportSuccess, setReportSuccess] = useState<string | null>(null);

  const activeCount = outages.filter((o) => o.status === "active").length;

  const handleReportOutage = (e: React.FormEvent) => {
    e.preventDefault();
    if (!reportRegion || !reportMeterId) return;

    const newOutage: Outage = {
      id: `outage-${Date.now()}`,
      region: reportRegion,
      affectedMeters: [reportMeterId],
      startedAt: new Date().toISOString(),
      status: "active",
      estimatedRestorationAt: new Date(Date.now() + 2 * 3600 * 1000).toISOString(),
      cause: "Reported by user / pending technician triage",
      severity: "moderate",
    };

    setOutages([newOutage, ...outages]);
    setReportSuccess("Outage report registered and dispatched to field technicians.");
    setReportRegion("");
    setReportMeterId("");
  };

  const filtered = outages.filter((o) => {
    if (activeFilter === "active") return o.status === "active";
    if (activeFilter === "resolved") return o.status === "resolved";
    return true;
  });

  const getSeverityBadge = (sev: Outage["severity"]) => {
    switch (sev) {
      case "critical":
        return "bg-rose-950 text-rose-300 border-rose-800";
      case "major":
        return "bg-amber-950 text-amber-300 border-amber-800";
      default:
        return "bg-blue-950 text-blue-300 border-blue-800";
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      <Navbar />
      <main className="flex-1 max-w-6xl w-full mx-auto px-4 py-8">
        {/* Outage Status Banner */}
        {activeCount > 0 ? (
          <div className="mb-8 p-5 bg-rose-950/40 border border-rose-800/80 rounded-xl flex items-center justify-between">
            <div className="flex items-center gap-4">
              <span className="relative flex h-3.5 w-3.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-3.5 w-3.5 bg-rose-500"></span>
              </span>
              <div>
                <h2 className="font-bold text-rose-200">
                  Active Grid Disruptions Detected ({activeCount})
                </h2>
                <p className="text-sm text-rose-300/80">
                  Real-time telemetry reports localized outages. Crews dispatched for restoration.
                </p>
              </div>
            </div>
            <span className="px-3 py-1 bg-rose-900/60 border border-rose-700 text-rose-200 rounded-lg text-xs font-semibold">
              Disrupted
            </span>
          </div>
        ) : (
          <div className="mb-8 p-5 bg-emerald-950/40 border border-emerald-800/80 rounded-xl flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="h-3 w-3 rounded-full bg-emerald-500"></span>
              <div>
                <h2 className="font-bold text-emerald-200">All Microgrids Operational</h2>
                <p className="text-sm text-emerald-300/80">
                  No active outages reported. Nominal frequency (50.0 Hz) and voltage across all sectors.
                </p>
              </div>
            </div>
            <span className="px-3 py-1 bg-emerald-900/60 border border-emerald-700 text-emerald-200 rounded-lg text-xs font-semibold">
              Normal
            </span>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Main Outage Feed */}
          <div className="lg:col-span-2 space-y-6">
            <div className="flex items-center justify-between">
              <h1 className="text-2xl font-bold text-white">Outage Alerts & Restoration</h1>
              <div className="flex gap-2">
                <button
                  onClick={() => setActiveFilter("all")}
                  className={`px-3 py-1 rounded-lg text-xs font-semibold transition-colors ${
                    activeFilter === "all"
                      ? "bg-emerald-600 text-white"
                      : "bg-slate-900 text-slate-400 border border-slate-800"
                  }`}
                >
                  All
                </button>
                <button
                  onClick={() => setActiveFilter("active")}
                  className={`px-3 py-1 rounded-lg text-xs font-semibold transition-colors ${
                    activeFilter === "active"
                      ? "bg-emerald-600 text-white"
                      : "bg-slate-900 text-slate-400 border border-slate-800"
                  }`}
                >
                  Active ({activeCount})
                </button>
                <button
                  onClick={() => setActiveFilter("resolved")}
                  className={`px-3 py-1 rounded-lg text-xs font-semibold transition-colors ${
                    activeFilter === "resolved"
                      ? "bg-emerald-600 text-white"
                      : "bg-slate-900 text-slate-400 border border-slate-800"
                  }`}
                >
                  Resolved
                </button>
              </div>
            </div>

            <div className="space-y-4">
              {filtered.map((outage) => (
                <div
                  key={outage.id}
                  className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-lg space-y-3"
                >
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-white text-base">
                          {outage.region}
                        </span>
                        <span
                          className={`px-2 py-0.5 rounded text-[11px] font-semibold border ${getSeverityBadge(
                            outage.severity
                          )}`}
                        >
                          {outage.severity.toUpperCase()}
                        </span>
                      </div>
                      <p className="text-xs text-slate-400 mt-1">{outage.cause}</p>
                    </div>

                    <span
                      className={`px-2.5 py-1 rounded-full text-xs font-semibold ${
                        outage.status === "active"
                          ? "bg-rose-950 text-rose-300 border border-rose-800"
                          : "bg-emerald-950 text-emerald-300 border border-emerald-800"
                      }`}
                    >
                      {outage.status === "active" ? "Active Outage" : "Resolved"}
                    </span>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 pt-2 text-xs border-t border-slate-800/80">
                    <div>
                      <span className="text-slate-500 block">Affected Meters</span>
                      <span className="text-slate-300 font-medium">
                        {outage.affectedMeters.join(", ")}
                      </span>
                    </div>
                    <div>
                      <span className="text-slate-500 block">Outage Started</span>
                      <span className="text-slate-300 font-medium">
                        {new Date(outage.startedAt).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                    </div>
                    <div>
                      <span className="text-slate-500 block">Estimated Restoration</span>
                      <span className="text-amber-400 font-semibold">
                        {outage.status === "active"
                          ? new Date(outage.estimatedRestorationAt).toLocaleTimeString([], {
                              hour: "2-digit",
                              minute: "2-digit",
                            })
                          : "Restored"}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Report Outage Sidebar */}
          <div className="space-y-6">
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-lg">
              <h2 className="text-lg font-bold text-white mb-2">Report Power Outage</h2>
              <p className="text-xs text-slate-400 mb-4">
                If your smart meter has lost grid power and is running on backup storage, report it to dispatch crews.
              </p>

              {reportSuccess && (
                <div className="mb-4 p-3 bg-emerald-950 border border-emerald-800 rounded text-xs text-emerald-300">
                  {reportSuccess}
                </div>
              )}

              <form onSubmit={handleReportOutage} className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    Region or District
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Sector 3, West Microgrid"
                    value={reportRegion}
                    onChange={(e) => setReportRegion(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white text-xs focus:outline-none focus:border-emerald-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    Meter ID
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. MTR-4910"
                    value={reportMeterId}
                    onChange={(e) => setReportMeterId(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white text-xs focus:outline-none focus:border-emerald-500"
                  />
                </div>

                <button
                  type="submit"
                  className="w-full py-2 px-4 bg-emerald-600 hover:bg-emerald-500 text-white font-semibold rounded-lg text-xs transition-colors"
                >
                  Submit Outage Report
                </button>
              </form>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
