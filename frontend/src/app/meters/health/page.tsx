"use client";

/**
 * Meter health dashboard (#834): red/yellow/green status for every meter.
 */
import { useEffect, useState } from "react";
import { env } from "@/lib/env";

const API = env.NEXT_PUBLIC_BACKEND_URL;

type Status = "green" | "yellow" | "red";
type MeterHealth = {
  meterId: string;
  status: Status;
  lastHeartbeat: string;
  errorRate: number;
  avgResponseTimeMs: number | null;
  uptimePercent: number;
};

const DOT: Record<Status, string> = {
  green: "bg-green-500",
  yellow: "bg-yellow-400",
  red: "bg-red-500",
};

export default function MeterHealthPage() {
  const [data, setData] = useState<{ summary: Record<Status, number>; meters: MeterHealth[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = () =>
      fetch(`${API}/api/meters/health`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then(setData)
        .catch((e) => setError(e.message));
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, []);

  return (
    <main className="p-6 max-w-5xl mx-auto">
      <h1 className="text-2xl font-bold mb-4">Meter Health</h1>
      {error && <p className="text-red-600">Failed to load: {error}</p>}
      {data && (
        <>
          <div className="flex gap-4 mb-6">
            {(["green", "yellow", "red"] as Status[]).map((s) => (
              <div key={s} className="flex items-center gap-2">
                <span className={`inline-block w-3 h-3 rounded-full ${DOT[s]}`} aria-hidden />
                <span className="capitalize">{s}</span>: {data.summary[s]}
              </div>
            ))}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left border-b">
                  <th className="py-2">Status</th>
                  <th>Meter</th>
                  <th>Last heartbeat</th>
                  <th>Error rate</th>
                  <th>Avg response</th>
                  <th>Uptime</th>
                </tr>
              </thead>
              <tbody>
                {data.meters.map((m) => (
                  <tr key={m.meterId} className="border-b">
                    <td className="py-2">
                      <span
                        className={`inline-block w-3 h-3 rounded-full ${DOT[m.status]}`}
                        title={m.status}
                        aria-label={m.status}
                      />
                    </td>
                    <td>{m.meterId}</td>
                    <td>{new Date(m.lastHeartbeat).toLocaleString()}</td>
                    <td>{(m.errorRate * 100).toFixed(1)}%</td>
                    <td>{m.avgResponseTimeMs === null ? "—" : `${Math.round(m.avgResponseTimeMs)} ms`}</td>
                    <td>{m.uptimePercent.toFixed(1)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </main>
  );
}
