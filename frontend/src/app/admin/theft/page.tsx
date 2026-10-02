"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Navbar from "@/components/Navbar";
import { env } from "@/lib/env";

const API = env.NEXT_PUBLIC_BACKEND_URL;
type AlertStatus = "open" | "investigating" | "resolved" | "false_positive";
type TheftAlert = {
  id: number;
  meter_id: string;
  observed_units: number;
  baseline_median: number;
  anomaly_score: number;
  severity: "high" | "critical";
  detected_at: string;
  status: AlertStatus;
  assigned_to: string | null;
  investigation_note: string | null;
};
type MonthlyReport = {
  month: string;
  generatedAt: string;
  totalAlerts: number;
  openAlerts: number;
  investigatingAlerts: number;
  resolvedAlerts: number;
  falsePositiveAlerts: number;
  falsePositiveRate: number | null;
  affectedMeters: number;
  meters: Array<{ meterId: string; alerts: number; highestScore: number }>;
};
type HistoryEvent = { action: string; actor: string; note: string | null; created_at: string };

function authHeaders(json = false): Record<string, string> {
  const token = sessionStorage.getItem("admin_token");
  return { ...(json ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

function AlertRow({ alert, onSaved }: { alert: TheftAlert; onSaved: () => void }) {
  const [status, setStatus] = useState<AlertStatus>(alert.status);
  const [assignedTo, setAssignedTo] = useState(alert.assigned_to ?? "");
  const [note, setNote] = useState("");
  const [history, setHistory] = useState<HistoryEvent[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  async function loadHistory() {
    const response = await fetch(`${API}/api/theft/alerts/${alert.id}/investigation`, { headers: authHeaders() });
    if (response.ok) setHistory((await response.json()).events ?? []);
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setMessage(null);
    const response = await fetch(`${API}/api/theft/alerts/${alert.id}/investigation`, {
      method: "PATCH",
      headers: authHeaders(true),
      body: JSON.stringify({ status, assignedTo: assignedTo.trim() || null, note: note.trim() || undefined, actor: "admin" }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      setMessage(body.error ?? "Investigation update failed");
      return;
    }
    setNote("");
    setMessage("Investigation saved");
    await loadHistory();
    onSaved();
  }

  return (
    <article className="border-b border-white/10 py-4">
      <div className="grid gap-3 lg:grid-cols-[1fr_auto]">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold">Meter {alert.meter_id}</h3>
            <span className={`border px-2 py-0.5 text-[11px] uppercase ${alert.severity === "critical" ? "border-rose-500/50 text-rose-300" : "border-amber-500/50 text-amber-300"}`}>{alert.severity}</span>
            <span className="text-xs text-gray-400">{alert.status.replace("_", " ")}</span>
          </div>
          <p className="mt-2 text-xs text-gray-400">
            Detected {new Date(alert.detected_at).toLocaleString()} · reading {alert.observed_units} · baseline {alert.baseline_median.toFixed(2)} · robust score {alert.anomaly_score.toFixed(1)}
          </p>
          {alert.investigation_note && <p className="mt-2 text-sm text-gray-300">Latest note: {alert.investigation_note}</p>}
        </div>
        <details onToggle={(event) => { if (event.currentTarget.open) void loadHistory(); }} className="text-xs text-gray-400">
          <summary className="cursor-pointer">History ({history.length})</summary>
          <ul className="mt-2 space-y-1">
            {history.map((event, index) => <li key={`${event.created_at}-${index}`}>{new Date(event.created_at).toLocaleString()} · {event.action} by {event.actor}{event.note ? `: ${event.note}` : ""}</li>)}
          </ul>
        </details>
      </div>
      <form onSubmit={save} className="mt-3 grid gap-2 sm:grid-cols-[140px_minmax(120px,1fr)_minmax(180px,2fr)_auto]">
        <label className="sr-only" htmlFor={`alert-status-${alert.id}`}>Investigation status</label>
        <select id={`alert-status-${alert.id}`} value={status} onChange={(event) => setStatus(event.target.value as AlertStatus)} className="min-h-9 border border-white/15 bg-solar-accent px-2 text-xs">
          <option value="open">Open</option><option value="investigating">Investigating</option><option value="resolved">Resolved</option><option value="false_positive">False positive</option>
        </select>
        <label className="sr-only" htmlFor={`alert-assignee-${alert.id}`}>Assigned investigator</label>
        <input id={`alert-assignee-${alert.id}`} value={assignedTo} maxLength={100} onChange={(event) => setAssignedTo(event.target.value)} placeholder="Assign to" className="min-h-9 min-w-0 border border-white/15 bg-transparent px-2 text-xs" />
        <label className="sr-only" htmlFor={`alert-note-${alert.id}`}>Investigation note</label>
        <input id={`alert-note-${alert.id}`} value={note} maxLength={2000} onChange={(event) => setNote(event.target.value)} placeholder="Add investigation note" className="min-h-9 min-w-0 border border-white/15 bg-transparent px-2 text-xs" />
        <button type="submit" className="min-h-9 border border-emerald-400/60 px-3 text-xs text-emerald-200 hover:bg-emerald-400/10">Save</button>
      </form>
      {message && <p role="status" className="mt-2 text-xs text-gray-400">{message}</p>}
    </article>
  );
}

export default function TheftDashboardPage() {
  const router = useRouter();
  const [alerts, setAlerts] = useState<TheftAlert[]>([]);
  const [report, setReport] = useState<MonthlyReport | null>(null);
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [status, setStatus] = useState("open");
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  const refresh = useCallback(async () => {
    const query = new URLSearchParams({ status, limit: "100" });
    const [alertResponse, reportResponse] = await Promise.all([
      fetch(`${API}/api/theft/alerts?${query}`, { headers: authHeaders() }),
      fetch(`${API}/api/theft/reports/monthly?month=${month}`, { headers: authHeaders() }),
    ]);
    if (alertResponse.status === 401 || alertResponse.status === 403 || reportResponse.status === 401 || reportResponse.status === 403) {
      router.replace("/admin/login");
      return;
    }
    if (!alertResponse.ok || !reportResponse.ok) throw new Error("Could not load theft monitoring data");
    const [alertBody, reportBody] = await Promise.all([alertResponse.json(), reportResponse.json()]);
    setAlerts(alertBody.alerts ?? []);
    setReport(reportBody);
    setError(null);
  }, [month, router, status]);

  useEffect(() => {
    if (!sessionStorage.getItem("admin_token")) {
      router.replace("/admin/login");
      return;
    }
    let stopped = false;
    const load = () => { if (!stopped) void refresh().catch((err) => setError(err.message)); };
    load();
    const interval = window.setInterval(load, 30_000);
    return () => { stopped = true; window.clearInterval(interval); };
  }, [refresh, reload, router]);

  return (
    <>
      <Navbar />
      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-4 border-b border-white/10 pb-4">
          <div><p className="text-xs uppercase tracking-wide text-rose-300">Grid integrity</p><h1 className="mt-1 text-2xl font-semibold">Theft detection</h1></div>
          <Link href="/admin" className="text-xs text-gray-400 underline">Admin home</Link>
        </div>
        {error && <p role="alert" className="mt-4 text-sm text-rose-300">{error}</p>}
        <section aria-label="Monthly theft report" className="mt-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-sm font-semibold">Monthly report</h2>
            <label className="flex items-center gap-2 text-xs text-gray-400">Reporting month <input type="month" value={month} onChange={(event) => setMonth(event.target.value)} className="min-h-8 border border-white/15 bg-solar-accent px-2 text-white" /></label>
          </div>
          {report && <>
            <div className="mt-3 grid grid-cols-2 gap-3 border-y border-white/10 py-3 sm:grid-cols-4 lg:grid-cols-6">
              <div><p className="text-xs text-gray-400">Alerts</p><p className="mt-1 text-lg font-semibold">{report.totalAlerts}</p></div>
              <div><p className="text-xs text-gray-400">Open</p><p className="mt-1 text-lg font-semibold">{report.openAlerts}</p></div>
              <div><p className="text-xs text-gray-400">Investigating</p><p className="mt-1 text-lg font-semibold">{report.investigatingAlerts}</p></div>
              <div><p className="text-xs text-gray-400">Resolved</p><p className="mt-1 text-lg font-semibold">{report.resolvedAlerts}</p></div>
              <div><p className="text-xs text-gray-400">False positives</p><p className="mt-1 text-lg font-semibold">{report.falsePositiveAlerts}</p></div>
              <div><p className="text-xs text-gray-400">Closed-alert FP rate</p><p className="mt-1 text-lg font-semibold">{report.falsePositiveRate === null ? "--" : `${(report.falsePositiveRate * 100).toFixed(1)}%`}</p></div>
            </div>
            <p className="mt-2 text-right text-[11px] text-gray-500">{report.affectedMeters} affected meter(s) · generated {new Date(report.generatedAt).toLocaleString()}</p>
          </>}
        </section>
        <section aria-label="Theft alerts" className="mt-7">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-sm font-semibold">Investigation queue</h2>
            <label className="flex items-center gap-2 text-xs text-gray-400">Filter <select value={status} onChange={(event) => setStatus(event.target.value)} className="min-h-8 border border-white/15 bg-solar-accent px-2 text-white"><option value="open">Open</option><option value="investigating">Investigating</option><option value="resolved">Resolved</option><option value="false_positive">False positive</option></select></label>
          </div>
          {alerts.length === 0 ? <p className="mt-4 text-sm text-gray-500">No alerts in this queue.</p> : alerts.map((alert) => <AlertRow key={alert.id} alert={alert} onSaved={() => setReload((value) => value + 1)} />)}
        </section>
      </main>
    </>
  );
}