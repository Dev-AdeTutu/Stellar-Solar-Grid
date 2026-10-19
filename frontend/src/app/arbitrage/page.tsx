"use client";

import { useEffect, useState } from "react";
import Navbar from "@/components/Navbar";
import { env } from "@/lib/env";
import { usePaymentStore } from "@/store/paymentStore";

const API = env.NEXT_PUBLIC_BACKEND_URL;

interface ArbitrageWindowOpportunity {
  id: string;
  meterId: string;
  chargeWindowStartHour: number;
  chargeWindowEndHour: number;
  dischargeWindowStartHour: number;
  dischargeWindowEndHour: number;
  avgChargePricePerKwh: number;
  avgDischargePricePerKwh: number;
  spreadPerKwh: number;
  spreadPercent: number;
  recommendedKwh: number;
  estimatedProfitUsd: number;
  solarAssistKwh: number;
  confidence: number;
  recommendation: string;
}

interface ArbitrageScheduleSlot {
  hour: number;
  action: "charge" | "discharge" | "hold";
  source: "solar" | "grid" | "battery" | "none";
  energyKwh: number;
  gridPricePerKwh: number;
  solarGenerationKwh: number;
  batterySocKwh: number;
  cashflowUsd: number;
}

interface ArbitrageAlert {
  id: string;
  meterId: string;
  severity: "info" | "high_profit";
  message: string;
  estimatedProfitUsd: number;
  triggeredAt: string;
}

interface MeterArbitrageReport {
  meterId: string;
  generatedAt: string;
  batteryCapacityKwh: number;
  roundTripEfficiency: number;
  currentGridPricePerKwh: number;
  currentSolarGenerationKw: number;
  estimatedDailyProfitUsd: number;
  estimatedMonthlyProfitUsd: number;
  opportunities: ArbitrageWindowOpportunity[];
  optimalSchedule: ArbitrageScheduleSlot[];
  alerts: ArbitrageAlert[];
}

export default function ArbitrageOpportunityDashboard() {
  const defaultMeterId = usePaymentStore((s) => s.meterId);
  const [meterId, setMeterId] = useState(defaultMeterId || "METER-001");
  const [batteryCapacityKwh, setBatteryCapacityKwh] = useState("13.5");
  const [report, setReport] = useState<MeterArbitrageReport | null>(null);
  const [loading, setLoading] = useState(false);

  const loadOpportunities = async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `${API}/api/meters/${encodeURIComponent(meterId)}/arbitrage?batteryCapacityKwh=${encodeURIComponent(batteryCapacityKwh)}`,
      );
      if (res.ok) {
        const data = (await res.json()) as MeterArbitrageReport;
        setReport(data);
      }
    } catch {
      // Fallback local preview if backend is unreachable
      setReport({
        meterId,
        generatedAt: new Date().toISOString(),
        batteryCapacityKwh: Number(batteryCapacityKwh) || 13.5,
        roundTripEfficiency: 0.9,
        currentGridPricePerKwh: 0.14,
        currentSolarGenerationKw: 2.8,
        estimatedDailyProfitUsd: 5.18,
        estimatedMonthlyProfitUsd: 155.4,
        opportunities: [
          {
            id: `${meterId}-arb-night-peak`,
            meterId,
            chargeWindowStartHour: 1,
            chargeWindowEndHour: 5,
            dischargeWindowStartHour: 17,
            dischargeWindowEndHour: 21,
            avgChargePricePerKwh: 0.08,
            avgDischargePricePerKwh: 0.31,
            spreadPerKwh: 0.22,
            spreadPercent: 287.5,
            recommendedKwh: 10.8,
            estimatedProfitUsd: 2.38,
            solarAssistKwh: 0,
            confidence: 0.92,
            recommendation:
              "Charge battery from grid between 01:00–05:00 ($0.08/kWh) and discharge during 17:00–21:00 peak ($0.31/kWh).",
          },
          {
            id: `${meterId}-arb-solar-peak`,
            meterId,
            chargeWindowStartHour: 10,
            chargeWindowEndHour: 15,
            dischargeWindowStartHour: 17,
            dischargeWindowEndHour: 21,
            avgChargePricePerKwh: 0,
            avgDischargePricePerKwh: 0.31,
            spreadPerKwh: 0.279,
            spreadPercent: 244.4,
            recommendedKwh: 10.0,
            estimatedProfitUsd: 2.8,
            solarAssistKwh: 10.0,
            confidence: 0.89,
            recommendation:
              "Store 10 kWh of midday excess solar (10:00–15:00) and discharge during evening peak (17:00–21:00) to save/earn $2.80.",
          },
        ],
        optimalSchedule: [],
        alerts: [
          {
            id: `alert-${meterId}`,
            meterId,
            severity: "high_profit",
            message:
              "Arbitrage opportunity detected: Store 10 kWh of midday excess solar and discharge during 17:00–21:00 peak.",
            estimatedProfitUsd: 2.8,
            triggeredAt: new Date().toISOString(),
          },
        ],
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadOpportunities();
  }, [meterId]);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <Navbar />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <header className="mb-8 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold text-emerald-400">
              Energy Arbitrage Opportunity Dashboard
            </h1>
            <p className="mt-1 text-slate-400">
              Real-time grid price monitoring, solar storage optimization, and automated charge/discharge windows.
            </p>
          </div>
          <div className="flex items-end gap-3">
            <div>
              <label htmlFor="arb-meter-id" className="block text-xs text-slate-400">
                Meter ID
              </label>
              <input
                id="arb-meter-id"
                type="text"
                value={meterId}
                onChange={(e) => setMeterId(e.target.value)}
                className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-sm text-white"
              />
            </div>
            <div>
              <label htmlFor="arb-battery-kwh" className="block text-xs text-slate-400">
                Battery (kWh)
              </label>
              <input
                id="arb-battery-kwh"
                type="number"
                value={batteryCapacityKwh}
                onChange={(e) => setBatteryCapacityKwh(e.target.value)}
                className="w-24 rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-sm text-white"
              />
            </div>
            <button
              type="button"
              onClick={() => void loadOpportunities()}
              disabled={loading}
              className="rounded-lg bg-emerald-500 px-4 py-1.5 text-sm font-semibold text-slate-950 hover:bg-emerald-400"
            >
              {loading ? "Scanning..." : "Refresh"}
            </button>
          </div>
        </header>

        {report && (
          <>
            {report.alerts.length > 0 && (
              <section aria-label="Arbitrage Alerts" className="mb-6 space-y-2">
                {report.alerts.map((alert) => (
                  <div
                    key={alert.id}
                    className="flex items-center justify-between rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-amber-200"
                  >
                    <span className="text-sm font-medium">⚡ {alert.message}</span>
                    <span className="text-xs font-bold uppercase text-amber-300">
                      Est. +${alert.estimatedProfitUsd.toFixed(2)}
                    </span>
                  </div>
                ))}
              </section>
            )}

            <section className="mb-8 grid gap-4 sm:grid-cols-4">
              <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
                <p className="text-xs text-slate-400">Current Grid Price</p>
                <p className="mt-1 text-2xl font-bold text-white">
                  ${report.currentGridPricePerKwh.toFixed(3)}/kWh
                </p>
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
                <p className="text-xs text-slate-400">Solar Generation</p>
                <p className="mt-1 text-2xl font-bold text-amber-400">
                  {report.currentSolarGenerationKw.toFixed(2)} kW
                </p>
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
                <p className="text-xs text-slate-400">Est. Daily Arbitrage Profit</p>
                <p className="mt-1 text-2xl font-bold text-emerald-400">
                  ${report.estimatedDailyProfitUsd.toFixed(2)}
                </p>
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
                <p className="text-xs text-slate-400">Est. Monthly Profit</p>
                <p className="mt-1 text-2xl font-bold text-emerald-300">
                  ${report.estimatedMonthlyProfitUsd.toFixed(2)}
                </p>
              </div>
            </section>

            <section className="mb-8">
              <h2 className="mb-4 text-xl font-semibold">Detected Charge / Discharge Windows</h2>
              <div className="grid gap-4 md:grid-cols-2">
                {report.opportunities.map((opp) => (
                  <div
                    key={opp.id}
                    className="rounded-xl border border-slate-800 bg-slate-900 p-5"
                  >
                    <div className="flex items-center justify-between">
                      <span className="rounded-md bg-emerald-500/20 px-2.5 py-1 text-xs font-semibold text-emerald-300">
                        Spread +{opp.spreadPercent}%
                      </span>
                      <span className="text-lg font-bold text-emerald-400">
                        +${opp.estimatedProfitUsd.toFixed(2)} / cycle
                      </span>
                    </div>
                    <p className="mt-3 text-sm text-slate-200">{opp.recommendation}</p>
                    <div className="mt-4 grid grid-cols-2 gap-2 text-xs text-slate-400">
                      <div>
                        Charge Window: {opp.chargeWindowStartHour}:00–{opp.chargeWindowEndHour}:00 UTC
                      </div>
                      <div>
                        Discharge Window: {opp.dischargeWindowStartHour}:00–{opp.dischargeWindowEndHour}:00 UTC
                      </div>
                      <div>Recommended Energy: {opp.recommendedKwh} kWh</div>
                      <div>Confidence: {Math.round(opp.confidence * 100)}%</div>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
