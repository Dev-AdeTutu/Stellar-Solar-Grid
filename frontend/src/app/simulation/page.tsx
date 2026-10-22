"use client";

import { useState } from "react";
import Navbar from "@/components/Navbar";
import { env } from "@/lib/env";

const API = env.NEXT_PUBLIC_BACKEND_URL;

type UsagePatternType = "residential" | "commercial" | "industrial" | "solar_prosumer";
type WeatherCondition = "sunny" | "partly_cloudy" | "overcast" | "storm" | "heatwave";
type FaultType =
  | "none"
  | "voltage_sag"
  | "relay_stuck_open"
  | "relay_stuck_closed"
  | "tamper_detected"
  | "comms_dropout"
  | "lightning_surge";

interface VirtualMeterTwin {
  id: string;
  name: string;
  usagePattern: UsagePatternType;
  weather: WeatherCondition;
  fault: FaultType;
  active: boolean;
  relayClosed: boolean;
  balanceStroops: number;
  unitsUsed: number;
  daySpentUnits: number;
  trainingMode: boolean;
  contractRules: {
    unitPriceStroops: number;
    dailyLimitUnits: number;
    plan: string;
    autoDeactivate: boolean;
  };
}

export default function MeterSimulationControlPanel() {
  const [meterId, setMeterId] = useState("V-METER-101");
  const [usagePattern, setUsagePattern] = useState<UsagePatternType>("residential");
  const [weather, setWeather] = useState<WeatherCondition>("sunny");
  const [fault, setFault] = useState<FaultType>("none");
  const [unitPriceStroops, setUnitPriceStroops] = useState("10");
  const [dailyLimitUnits, setDailyLimitUnits] = useState("500");
  const [balanceStroops, setBalanceStroops] = useState("5000");
  const [trainingMode, setTrainingMode] = useState(false);
  const [twin, setTwin] = useState<VirtualMeterTwin | null>(null);
  const [scenarioLog, setScenarioLog] = useState<string[]>([]);

  const handleCreateTwin = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch(`${API}/api/simulation/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: meterId,
          usagePattern,
          weather,
          fault,
          balanceStroops: Number(balanceStroops),
          trainingMode,
          contractRules: {
            unitPriceStroops: Number(unitPriceStroops),
            dailyLimitUnits: Number(dailyLimitUnits),
            plan: "UsageBased",
            autoDeactivate: true,
          },
        }),
      });
      if (res.ok) {
        const created = (await res.json()) as VirtualMeterTwin;
        setTwin(created);
        setScenarioLog((prev) => [`Created virtual twin ${created.id} (${created.usagePattern}, ${created.weather})`, ...prev]);
        return;
      }
    } catch {
      // Local fallback state
    }

    const fallbackTwin: VirtualMeterTwin = {
      id: meterId,
      name: `Virtual Twin ${meterId}`,
      usagePattern,
      weather,
      fault,
      active: Number(balanceStroops) > 0 && fault !== "lightning_surge",
      relayClosed: fault === "relay_stuck_closed" ? true : fault !== "relay_stuck_open",
      balanceStroops: Number(balanceStroops),
      unitsUsed: 0,
      daySpentUnits: 0,
      trainingMode,
      contractRules: {
        unitPriceStroops: Number(unitPriceStroops),
        dailyLimitUnits: Number(dailyLimitUnits),
        plan: "UsageBased",
        autoDeactivate: true,
      },
    };
    setTwin(fallbackTwin);
    setScenarioLog((prev) => [`Created virtual twin ${fallbackTwin.id} (local emulation)`, ...prev]);
  };

  const handleRun24hScenario = async () => {
    if (!twin) return;
    try {
      const res = await fetch(`${API}/api/simulation/meters/${encodeURIComponent(twin.id)}/scenario`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hours: 24,
          weather,
          fault,
          contractRules: {
            unitPriceStroops: Number(unitPriceStroops),
            dailyLimitUnits: Number(dailyLimitUnits),
          },
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setScenarioLog((prev) => [
          `24h Scenario complete: consumed ${data.totalUnitsConsumed} units, final balance ${data.finalBalanceStroops} stroops, deactivated=${data.deactivatedByContract}`,
          ...prev,
        ]);
        return;
      }
    } catch {
      // Fallback calculation
    }
    const simulatedUnits = usagePattern === "industrial" ? 320 : usagePattern === "commercial" ? 180 : 65;
    const cost = simulatedUnits * Number(unitPriceStroops);
    const nextBalance = Math.max(0, twin.balanceStroops - cost);
    setTwin({
      ...twin,
      weather,
      fault,
      unitsUsed: twin.unitsUsed + simulatedUnits,
      daySpentUnits: twin.daySpentUnits + simulatedUnits,
      balanceStroops: nextBalance,
      active: nextBalance > 0 && twin.daySpentUnits + simulatedUnits < Number(dailyLimitUnits),
    });
    setScenarioLog((prev) => [
      `24h Scenario complete: consumed ${simulatedUnits} units, remaining balance ${nextBalance} stroops`,
      ...prev,
    ]);
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <Navbar />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <header className="mb-8">
          <h1 className="text-3xl font-bold text-cyan-400">
            Meter Virtual Twin Simulation Control Panel
          </h1>
          <p className="mt-1 text-slate-400">
            Emulate IoT smart meters, inject hardware faults & weather impacts, test contract rule changes, and train field technicians.
          </p>
        </header>

        <div className="grid gap-8 md:grid-cols-2">
          <form
            onSubmit={handleCreateTwin}
            className="space-y-4 rounded-xl border border-slate-800 bg-slate-900 p-6"
          >
            <h2 className="text-xl font-semibold">Configure Virtual Twin</h2>

            <div>
              <label htmlFor="sim-meter-id" className="block text-sm text-slate-300">
                Virtual Meter ID
              </label>
              <input
                id="sim-meter-id"
                type="text"
                value={meterId}
                onChange={(e) => setMeterId(e.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-white"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="sim-pattern" className="block text-sm text-slate-300">
                  Usage Pattern
                </label>
                <select
                  id="sim-pattern"
                  value={usagePattern}
                  onChange={(e) => setUsagePattern(e.target.value as UsagePatternType)}
                  className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-white"
                >
                  <option value="residential">Residential</option>
                  <option value="commercial">Commercial</option>
                  <option value="industrial">Industrial</option>
                  <option value="solar_prosumer">Solar Prosumer</option>
                </select>
              </div>

              <div>
                <label htmlFor="sim-weather" className="block text-sm text-slate-300">
                  Weather Condition
                </label>
                <select
                  id="sim-weather"
                  value={weather}
                  onChange={(e) => setWeather(e.target.value as WeatherCondition)}
                  className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-white"
                >
                  <option value="sunny">Sunny</option>
                  <option value="partly_cloudy">Partly Cloudy</option>
                  <option value="overcast">Overcast</option>
                  <option value="storm">Severe Storm</option>
                  <option value="heatwave">Heatwave</option>
                </select>
              </div>
            </div>

            <div>
              <label htmlFor="sim-fault" className="block text-sm text-slate-300">
                Fault Injection
              </label>
              <select
                id="sim-fault"
                value={fault}
                onChange={(e) => setFault(e.target.value as FaultType)}
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-white"
              >
                <option value="none">No Fault (Normal Operation)</option>
                <option value="voltage_sag">Grid Voltage Sag (&lt;190V)</option>
                <option value="relay_stuck_closed">Contactor Relay Stuck Closed</option>
                <option value="relay_stuck_open">Contactor Relay Stuck Open</option>
                <option value="tamper_detected">Enclosure Tamper Alert</option>
                <option value="comms_dropout">MQTT Telemetry Dropout</option>
                <option value="lightning_surge">Lightning Transient Surge</option>
              </select>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div>
                <label htmlFor="sim-balance" className="block text-xs text-slate-400">
                  Balance (Stroops)
                </label>
                <input
                  id="sim-balance"
                  type="number"
                  value={balanceStroops}
                  onChange={(e) => setBalanceStroops(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-white"
                />
              </div>
              <div>
                <label htmlFor="sim-price" className="block text-xs text-slate-400">
                  Unit Price
                </label>
                <input
                  id="sim-price"
                  type="number"
                  value={unitPriceStroops}
                  onChange={(e) => setUnitPriceStroops(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-white"
                />
              </div>
              <div>
                <label htmlFor="sim-limit" className="block text-xs text-slate-400">
                  Daily Limit
                </label>
                <input
                  id="sim-limit"
                  type="number"
                  value={dailyLimitUnits}
                  onChange={(e) => setDailyLimitUnits(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-white"
                />
              </div>
            </div>

            <label className="flex items-center gap-2 text-sm text-slate-300">
              <input
                type="checkbox"
                checked={trainingMode}
                onChange={(e) => setTrainingMode(e.target.checked)}
              />
              Enable Technician Training Mode
            </label>

            <div className="flex gap-3 pt-2">
              <button
                type="submit"
                className="rounded-lg bg-cyan-500 px-4 py-2 font-semibold text-slate-950 hover:bg-cyan-400"
              >
                Create Virtual Meter
              </button>
              <button
                type="button"
                onClick={() => void handleRun24hScenario()}
                disabled={!twin}
                className="rounded-lg bg-amber-500 px-4 py-2 font-semibold text-slate-950 hover:bg-amber-400 disabled:opacity-40"
              >
                Run 24h Contract Test
              </button>
            </div>
          </form>

          <div className="space-y-6">
            <div className="rounded-xl border border-slate-800 bg-slate-900 p-6">
              <h2 className="mb-4 text-xl font-semibold">Live Twin Telemetry & State</h2>
              {!twin ? (
                <p className="text-sm text-slate-400">
                  Create a virtual meter to inspect live telemetry and contract state.
                </p>
              ) : (
                <dl className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <dt className="text-slate-400">Meter ID</dt>
                    <dd className="font-semibold text-white">{twin.id}</dd>
                  </div>
                  <div>
                    <dt className="text-slate-400">Contract Status</dt>
                    <dd className={twin.active ? "text-emerald-400" : "text-rose-400"}>
                      {twin.active ? "Active" : "Deactivated"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-slate-400">Physical Relay</dt>
                    <dd>{twin.relayClosed ? "Closed (Energized)" : "Open (Isolated)"}</dd>
                  </div>
                  <div>
                    <dt className="text-slate-400">Remaining Balance</dt>
                    <dd>{twin.balanceStroops} stroops</dd>
                  </div>
                  <div>
                    <dt className="text-slate-400">Units Consumed</dt>
                    <dd>{twin.unitsUsed} units</dd>
                  </div>
                  <div>
                    <dt className="text-slate-400">Active Fault</dt>
                    <dd className="text-amber-300">{twin.fault}</dd>
                  </div>
                </dl>
              )}
            </div>

            <div className="rounded-xl border border-slate-800 bg-slate-900 p-6">
              <h2 className="mb-3 text-lg font-semibold">Simulation & Training Log</h2>
              {scenarioLog.length === 0 ? (
                <p className="text-xs text-slate-500">No simulation events recorded yet.</p>
              ) : (
                <ul className="space-y-2 text-xs text-slate-300">
                  {scenarioLog.map((entry, idx) => (
                    <li key={idx} className="rounded bg-slate-950 p-2">
                      {entry}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
