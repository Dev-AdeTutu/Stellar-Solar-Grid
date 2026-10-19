"use client";

/**
 * Meter health dashboard (#834): red/yellow/green status for every meter.
 * Technician diagnostic console (#993): trigger remote diagnostics and view logs.
 */
import { useCallback, useEffect, useState } from "react";
import { env } from "@/lib/env";
import { getPowerQuality, type PowerQualityResponse } from "@/services/meterService";

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

type DiagnosticCommand = "reboot" | "self-test" | "connectivity";

type DiagnosticLog = {
  id: string;
  meterId: string;
  command: DiagnosticCommand;
  status: "pending" | "success" | "failure";
  result?: string | null;
  issuePattern?: string | null;
  suggestedFix?: string | null;
  createdAt: string;
};

const DOT: Record<Status, string> = {
  green: "bg-green-500",
  yellow: "bg-yellow-400",
  red: "bg-red-500",
};

const COMMANDS: { command: DiagnosticCommand; label: string }[] = [
  { command: "reboot", label: "Reboot" },
  { command: "self-test", label: "Run self-test" },
  { command: "connectivity", label: "Check connectivity" },
];

const LOG_STATUS: Record<DiagnosticLog["status"], string> = {
  pending: "text-yellow-600",
  success: "text-green-600",
  failure: "text-red-600",
};

export default function MeterHealthPage() {
  const [data, setData] = useState<{ summary: Record<Status, number>; meters: MeterHealth[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedMeter, setSelectedMeter] = useState<string | null>(null);

  const [selectedMeter, setSelectedMeter] = useState<string | null>(null);
  const [logs, setLogs] = useState<DiagnosticLog[]>([]);
  const [logsError, setLogsError] = useState<string | null>(null);
  const [running, setRunning] = useState<DiagnosticCommand | null>(null);

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

  const loadLogs = useCallback(
    (meterId: string) =>
      fetch(`${API}/api/meters/${encodeURIComponent(meterId)}/diagnostic-logs`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((body) => {
          setLogs(Array.isArray(body) ? body : body.logs ?? []);
          setLogsError(null);
        })
        .catch((e) => setLogsError(e.message)),
    [],
  );

  useEffect(() => {
    if (!selectedMeter) {
      setLogs([]);
      return;
    }
    loadLogs(selectedMeter);
    const id = setInterval(() => loadLogs(selectedMeter), 5_000);
    return () => clearInterval(id);
  }, [selectedMeter, loadLogs]);

  const runDiagnostic = async (command: DiagnosticCommand) => {
    if (!selectedMeter) return;
    setRunning(command);
    try {
      const res = await fetch(
        `${API}/api/meters/${encodeURIComponent(selectedMeter)}/diagnostics`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ command }),
        },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await loadLogs(selectedMeter);
    } catch (e) {
      setLogsError((e as Error).message);
    } finally {
      setRunning(null);
    }
  };

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
          <div className="mb-4">
            <label htmlFor="pq-meter" className="mr-2 text-sm font-medium">
              Power quality meter:
            </label>
            <select
              id="pq-meter"
              className="border rounded px-2 py-1 text-sm"
              value={selectedMeter ?? data.meters[0]?.meterId ?? ""}
              onChange={(e) => setSelectedMeter(e.target.value)}
            >
              {data.meters.map((m) => (
                <option key={m.meterId} value={m.meterId}>
                  {m.meterId}
                </option>
              ))}
            </select>
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
                  <tr
                    key={m.meterId}
                    className={`border-b cursor-pointer ${
                      selectedMeter === m.meterId ? "bg-blue-50" : ""
                    }`}
                    onClick={() => setSelectedMeter(m.meterId)}
                  >
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

          <section className="mt-8" aria-label="Diagnostic console">
            <h2 className="text-xl font-semibold mb-2">Diagnostic console</h2>
            {!selectedMeter ? (
              <p className="text-gray-600">Select a meter above to run diagnostics.</p>
            ) : (
              <>
                <p className="mb-3">
                  Selected meter: <span className="font-mono">{selectedMeter}</span>
                </p>
                <div className="flex flex-wrap gap-2 mb-4">
                  {COMMANDS.map(({ command, label }) => (
                    <button
                      key={command}
                      type="button"
                      className="px-3 py-1.5 rounded border border-gray-300 bg-white hover:bg-gray-100 disabled:opacity-50"
                      disabled={running !== null}
                      onClick={() => runDiagnostic(command)}
                    >
                      {running === command ? "Running…" : label}
                    </button>
                  ))}
                </div>
                {logsError && <p className="text-red-600">Failed to load logs: {logsError}</p>}
                {logs.length === 0 && !logsError ? (
                  <p className="text-gray-600">No diagnostic results yet.</p>
                ) : (
                  <ul className="space-y-3">
                    {logs.map((log) => (
                      <li key={log.id} className="border rounded p-3">
                        <div className="flex items-center justify-between">
                          <span className="font-medium">{log.command}</span>
                          <span className={`text-sm ${LOG_STATUS[log.status] ?? ""}`}>{log.status}</span>
                        </div>
                        <div className="text-xs text-gray-500">
                          {new Date(log.createdAt).toLocaleString()}
                        </div>
                        {log.result && <p className="mt-1 text-sm">{log.result}</p>}
                        {log.issuePattern && (
                          <p className="mt-2 text-sm">
                            <span className="font-semibold">Issue pattern:</span> {log.issuePattern}
                          </p>
                        )}
                        {log.suggestedFix && (
                          <p className="text-sm">
                            <span className="font-semibold">Suggested fix:</span> {log.suggestedFix}
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </section>
        </>
      )}
    </main>
  );
}
