"use client";

import React, { useState } from "react";

export interface CircuitItem {
  id: number;
  name: string;
  priority: 1 | 2 | 3 | 4; // 1 = Essential, 2 = High, 3 = Medium, 4 = Low
  loadWatts: number;
  isShed: boolean;
}

export default function CircuitManagement() {
  const [circuits, setCircuits] = useState<CircuitItem[]>([
    { id: 1, name: "Refrigeration & Medical", priority: 1, loadWatts: 350, isShed: false },
    { id: 2, name: "Living Room Lighting & Wi-Fi", priority: 2, loadWatts: 180, isShed: false },
    { id: 3, name: "Washing Machine & Kitchen", priority: 3, loadWatts: 1200, isShed: false },
    { id: 4, name: "EV Fast Charger", priority: 4, loadWatts: 3600, isShed: true },
    { id: 5, name: "Water Heater", priority: 4, loadWatts: 2000, isShed: true },
  ]);

  const [thresholdXlm, setThresholdXlm] = useState<number>(10);
  const [currentBalance, setCurrentBalance] = useState<number>(8.5);
  const [autoShedEnabled, setAutoShedEnabled] = useState<boolean>(true);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const getPriorityBadge = (priority: CircuitItem["priority"]) => {
    switch (priority) {
      case 1:
        return { label: "P1 · Essential", color: "bg-emerald-950 text-emerald-300 border-emerald-800" };
      case 2:
        return { label: "P2 · High", color: "bg-blue-950 text-blue-300 border-blue-800" };
      case 3:
        return { label: "P3 · Medium", color: "bg-amber-950 text-amber-300 border-amber-800" };
      case 4:
        return { label: "P4 · Low", color: "bg-slate-800 text-slate-300 border-slate-700" };
    }
  };

  const handleToggleCircuit = (circuitId: number) => {
    setCircuits((prev) =>
      prev.map((c) => {
        if (c.id === circuitId) {
          const nextShed = !c.isShed;
          setStatusMessage(
            `Circuit ${c.name} manually ${nextShed ? "SHED (powered down)" : "RESTORED (powered on)"}.`
          );
          return { ...c, isShed: nextShed };
        }
        return c;
      })
    );
  };

  const handlePriorityChange = (circuitId: number, newPriority: 1 | 2 | 3 | 4) => {
    setCircuits((prev) =>
      prev.map((c) => (c.id === circuitId ? { ...c, priority: newPriority } : c))
    );
    setStatusMessage("Circuit priority updated.");
  };

  const totalLoad = circuits.filter((c) => !c.isShed).reduce((sum, c) => sum + c.loadWatts, 0);
  const shedLoad = circuits.filter((c) => c.isShed).reduce((sum, c) => sum + c.loadWatts, 0);

  return (
    <div className="space-y-6">
      {/* Metric Summary */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-lg">
          <div className="text-slate-400 text-xs font-medium">Active Connected Load</div>
          <div className="text-2xl font-bold text-white mt-1">
            {(totalLoad / 1000).toFixed(2)} <span className="text-emerald-400 text-sm">kW</span>
          </div>
          <div className="text-xs text-slate-500 mt-1">Currently drawing power</div>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-lg">
          <div className="text-slate-400 text-xs font-medium">Load Shed (Saved)</div>
          <div className="text-2xl font-bold text-amber-400 mt-1">
            {(shedLoad / 1000).toFixed(2)} <span className="text-amber-500 text-sm">kW</span>
          </div>
          <div className="text-xs text-slate-500 mt-1">Conserved during low reserve</div>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-lg">
          <div className="text-slate-400 text-xs font-medium">Meter Balance</div>
          <div className="text-2xl font-bold text-white mt-1">
            {currentBalance.toFixed(2)} <span className="text-slate-400 text-sm">XLM</span>
          </div>
          <div className="text-xs text-slate-500 mt-1">
            {currentBalance < thresholdXlm ? "⚠️ Under auto-shed threshold" : "✓ Normal reserve"}
          </div>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-lg">
          <div className="text-slate-400 text-xs font-medium">Auto-Shedding Mode</div>
          <div className="flex items-center gap-2 mt-2">
            <span
              className={`px-2.5 py-0.5 rounded text-xs font-semibold ${
                autoShedEnabled
                  ? "bg-emerald-950 text-emerald-300 border border-emerald-800"
                  : "bg-slate-800 text-slate-400 border border-slate-700"
              }`}
            >
              {autoShedEnabled ? "ENABLED" : "DISABLED"}
            </span>
          </div>
          <div className="text-xs text-slate-500 mt-1">Triggers when balance &lt; {thresholdXlm} XLM</div>
        </div>
      </div>

      {statusMessage && (
        <div className="p-3 bg-blue-950/60 border border-blue-800/80 rounded-lg text-blue-300 text-xs">
          {statusMessage}
        </div>
      )}

      {/* Circuit Control Table */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 shadow-lg">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-lg font-bold text-white">Circuit Priority & Load Control</h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Control individual home and facility circuits. Priority 1 (Essential) is never shed automatically.
            </p>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-950 text-slate-400 uppercase tracking-wider font-semibold border-b border-slate-800">
              <tr>
                <th className="py-3 px-4">Circuit</th>
                <th className="py-3 px-4">Priority Level</th>
                <th className="py-3 px-4">Rated Load</th>
                <th className="py-3 px-4">Current State</th>
                <th className="py-3 px-4 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800 text-slate-300">
              {circuits.map((c) => {
                const badge = getPriorityBadge(c.priority);
                return (
                  <tr key={c.id} className="hover:bg-slate-950/50 transition-colors">
                    <td className="py-3.5 px-4 font-semibold text-white">{c.name}</td>
                    <td className="py-3.5 px-4">
                      <select
                        value={c.priority}
                        onChange={(e) =>
                          handlePriorityChange(c.id, parseInt(e.target.value, 10) as 1 | 2 | 3 | 4)
                        }
                        className={`bg-slate-950 border px-2 py-1 rounded text-xs font-semibold focus:outline-none ${badge.color}`}
                      >
                        <option value={1}>P1 · Essential (Never Shed)</option>
                        <option value={2}>P2 · High</option>
                        <option value={3}>P3 · Medium</option>
                        <option value={4}>P4 · Low</option>
                      </select>
                    </td>
                    <td className="py-3.5 px-4 font-mono text-slate-400">
                      {c.loadWatts >= 1000
                        ? `${(c.loadWatts / 1000).toFixed(1)} kW`
                        : `${c.loadWatts} W`}
                    </td>
                    <td className="py-3.5 px-4">
                      <span
                        className={`px-2.5 py-1 rounded-full text-[11px] font-semibold ${
                          c.isShed
                            ? "bg-rose-950 text-rose-300 border border-rose-800"
                            : "bg-emerald-950 text-emerald-300 border border-emerald-800"
                        }`}
                      >
                        {c.isShed ? "SHED (OFF)" : "ACTIVE (ON)"}
                      </span>
                    </td>
                    <td className="py-3.5 px-4 text-right">
                      <button
                        onClick={() => handleToggleCircuit(c.id)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                          c.isShed
                            ? "bg-emerald-600 hover:bg-emerald-500 text-white"
                            : "bg-rose-600/20 hover:bg-rose-600 text-rose-300 hover:text-white border border-rose-600/40"
                        }`}
                      >
                        {c.isShed ? "Restore Power" : "Shed Load"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
