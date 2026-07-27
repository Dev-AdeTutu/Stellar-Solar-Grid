import { notFound } from "next/navigation";
import Link from "next/link";
import { QRCodeCanvas } from "qrcode.react";
import { env } from "@/lib/env";

// ── Types ─────────────────────────────────────────────────────────────────

interface MeterBalance {
  meter_id: string;
  balance: number;
  units_used: number;
  active: boolean;
}

interface UsageEventRecord {
  id: number;
  meter_id: string;
  units: number;
  cost: string;
  received_at: string;
}

interface UsageHistory {
  events: UsageEventRecord[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
}

// ── Server Data Fetching ──────────────────────────────────────────────────

const BACKEND_URL = env.NEXT_PUBLIC_BACKEND_URL;

async function fetchMeterBalance(meterId: string): Promise<MeterBalance | null> {
  try {
    const res = await fetch(`${BACKEND_URL}/api/meters/${meterId}/balance`, {
      cache: "no-store",
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

async function fetchMeterHistory(meterId: string): Promise<UsageHistory | null> {
  try {
    const res = await fetch(`${BACKEND_URL}/api/meters/${meterId}/history?pageSize=5`, {
      cache: "no-store",
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

// ── Component ─────────────────────────────────────────────────────────────

export default async function MeterReportPage({ params }: { params: { id: string } }) {
  const { id: meterId } = params;

  const [balance, history] = await Promise.all([
    fetchMeterBalance(meterId),
    fetchMeterHistory(meterId),
  ]);

  if (!balance) {
    notFound();
  }

  const balanceXlm = (balance.balance / 1e7).toFixed(2);
  const reportUrl = `${process.env.NEXT_PUBLIC_BACKEND_URL}/meters/${meterId}`;
  const generatedAt = new Date().toLocaleString();

  return (
    <main className="min-h-screen bg-solar-dark text-white p-4 sm:p-8 print-report">
      <div className="max-w-4xl mx-auto">
        {/* Screen-only: Back + Print buttons */}
        <div className="no-print flex items-center justify-between mb-6">
            <Link
              href="/dashboard/user"
              className="text-sm text-gray-400 hover:text-solar-yellow transition"
            >
              ← Back
            </Link>
            <button
              onClick={() => window.print()}
              className="rounded-lg bg-solar-yellow px-4 py-2 text-sm font-semibold text-solar-dark hover:opacity-90 transition"
            >
              Print
            </button>
          </div>

          {/* Report Header */}
          <div className="border border-white/10 bg-solar-accent rounded-xl p-6 mb-6">
            <h1 className="text-2xl font-bold text-solar-yellow mb-2">Meter Status Report</h1>
            <p className="text-sm text-gray-400">Generated at {generatedAt}</p>
          </div>

          {/* Main Grid: Meter Info + QR Code */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
            {/* Meter Details (2/3) */}
            <div className="md:col-span-2 border border-white/10 bg-solar-accent rounded-xl p-6 space-y-4">
              <div>
                <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">Meter ID</p>
                <p className="text-lg font-mono font-semibold text-white">{meterId}</p>
              </div>

              <div>
                <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">Balance</p>
                <p className="text-lg font-bold text-white">
                  {balanceXlm} <span className="text-sm text-gray-400">XLM</span>
                </p>
              </div>

              <div>
                <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">Units Used</p>
                <p className="text-lg font-medium text-white">{balance.units_used}</p>
              </div>

              <div>
                <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">Status</p>
                <span
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold ${
                    balance.active
                      ? "border-green-600/40 bg-green-900/30 text-green-400"
                      : "border-red-600/40 bg-red-900/30 text-red-400"
                  }`}
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      balance.active ? "bg-green-400" : "bg-red-400"
                    }`}
                  />
                  {balance.active ? "Active" : "Inactive"}
                </span>
              </div>
            </div>

            {/* QR Code (1/3) */}
            <div className="border border-white/10 bg-solar-accent rounded-xl p-6 flex flex-col items-center justify-center space-y-3">
              <p className="text-xs text-gray-500 uppercase tracking-wider text-center">
                QR Code
              </p>
              <div className="bg-white p-3 rounded-lg">
                <QRCodeCanvas value={reportUrl} size={128} />
              </div>
              <p className="text-xs text-gray-400 text-center">Scan to view this meter</p>
            </div>
          </div>

          {/* Recent Readings */}
          <div className="border border-white/10 bg-solar-accent rounded-xl p-6">
            <h2 className="text-lg font-bold text-white mb-4">Recent Readings (Last 5)</h2>

            {history && history.events.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-white/10">
                      <th className="py-2 px-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">
                        Date
                      </th>
                      <th className="py-2 px-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">
                        Units
                      </th>
                      <th className="py-2 px-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">
                        Cost (XLM)
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.events.map((event) => (
                      <tr key={event.id} className="border-b border-white/5">
                        <td className="py-2 px-3 text-gray-300">
                          {new Date(event.received_at).toLocaleString()}
                        </td>
                        <td className="py-2 px-3 text-gray-300">{event.units}</td>
                        <td className="py-2 px-3 text-gray-300 font-mono">
                          {(Number(event.cost) / 1e7).toFixed(4)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm text-gray-400">No readings available.</p>
            )}
          </div>
        </div>
      </main>
  );
}
