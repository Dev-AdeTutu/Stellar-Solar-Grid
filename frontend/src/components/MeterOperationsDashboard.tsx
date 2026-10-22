"use client";

import { useCallback, useEffect, useState } from "react";
import { env } from "@/lib/env";

export type LoadGroup = {
  rule: { id: string; enabled: boolean };
  meters: Array<{ meterId: string; capacityWatts: number; ratio: number | null; stale: boolean; observation: { load_watts: number } | null }>;
  commands: Array<{ id: string; from_id: string; to_id: string; watts: number; status: string; reason: string | null }>;
};
export type SlaMeter = {
  meterId: string;
  report: { since: number; until: number; metrics: { uptimePct: number; responseP95Ms: number | null; responseSuccessPct: number | null; mtbfMs: number | null }; compliance: Record<string, string> } | null;
  trends: Array<{ report: SlaMeter["report"] }>;
};
export type SlaAlert = { id: string; event: string; meterId: string; metric: string; timestamp: string };

export function LoadDistribution({ groups }: { groups: LoadGroup[] }) {
  if (!groups.length) return <p>No commissioned load groups configured. Automatic control is disabled by default.</p>;
  return <div className="space-y-6">{groups.map(group => <section key={group.rule.id} className="space-y-3">
    <h3 className="font-bold">{group.rule.id}: {group.rule.enabled ? "Enabled (controller acknowledgement required)" : "Disabled"}</h3>
    {group.meters.map(meter => <div key={meter.meterId}>
      <label htmlFor={`load-${group.rule.id}-${meter.meterId}`}>{meter.meterId}: {meter.observation?.load_watts ?? "Unknown"} W / {meter.capacityWatts} W — {meter.stale ? "Stale or unavailable; excluded" : `${((meter.ratio ?? 0) * 100).toFixed(1)}% load`}</label>
      <meter id={`load-${group.rule.id}-${meter.meterId}`} min={0} max={meter.capacityWatts} value={Math.min(meter.observation?.load_watts ?? 0, meter.capacityWatts)} className="block w-full" />
    </div>)}
    <ul aria-label={`Command history for ${group.rule.id}`}>{group.commands.map(command => <li key={command.id} className="text-sm py-1">
      {command.from_id} → {command.to_id}: {command.watts} W — <strong>{command.status === "acknowledged" ? "Controller acknowledged execution" : command.status}</strong>
      {command.reason && ` (${command.reason})`}
    </li>)}</ul>
  </section>)}</div>;
}

export function SlaReports({ meters, alerts }: { meters: SlaMeter[]; alerts: SlaAlert[] }) {
  return <div className="space-y-5">
    {!meters.length && <p>No meter SLA targets configured.</p>}
    {meters.map(meter => <section key={meter.meterId}>
      <h3 className="font-bold">SLA — {meter.meterId}</h3>
      {!meter.report ? <p>Waiting for a measurement window.</p> : <>
        <p className="text-sm">{new Date(meter.report.since).toISOString()} to {new Date(meter.report.until).toISOString()}</p>
        <dl className="grid grid-cols-2 gap-2 mt-2">
          <dt>Uptime</dt><dd>{meter.report.metrics.uptimePct.toFixed(2)}%</dd>
          <dt>Response p95</dt><dd>{meter.report.metrics.responseP95Ms === null ? "Insufficient data" : `${meter.report.metrics.responseP95Ms.toFixed(0)} ms`}</dd>
          <dt>Successful probes</dt><dd>{meter.report.metrics.responseSuccessPct === null ? "Insufficient data" : `${meter.report.metrics.responseSuccessPct.toFixed(2)}%`}</dd>
          <dt>Mean uptime between failures</dt><dd>{meter.report.metrics.mtbfMs === null ? "Insufficient data (no failures)" : `${(meter.report.metrics.mtbfMs / 3_600_000).toFixed(2)} hours`}</dd>
        </dl>
        <ul className="text-sm mt-2">{Object.entries(meter.report.compliance).map(([metric, state]) => <li key={metric}>{metric}: <strong>{state.replaceAll("_", " ")}</strong></li>)}</ul>
      </>}
      <details className="mt-3"><summary>Historical hourly compliance reports ({meter.trends.length})</summary>
        <table className="text-sm text-left w-full"><caption>Uptime trend (first snapshot in each hour)</caption><thead><tr><th scope="col">Report time</th><th scope="col">Uptime</th></tr></thead>
          <tbody>{meter.trends.map((trend, index) => trend.report && <tr key={index}><td>{new Date(trend.report.until).toISOString()}</td><td>{trend.report.metrics.uptimePct.toFixed(2)}%</td></tr>)}</tbody>
        </table>
      </details>
    </section>)}
    <section><h3 className="font-bold">Breach and recovery history</h3>
      {!alerts.length ? <p>No SLA alerts recorded.</p> : <ul>{alerts.map(alert => <li key={alert.id}>{alert.timestamp}: {alert.meterId} — {alert.metric} — {alert.event.replaceAll("_", " ")}</li>)}</ul>}
    </section>
  </div>;
}

export default function MeterOperationsDashboard() {
  const [groups, setGroups] = useState<LoadGroup[]>([]);
  const [meters, setMeters] = useState<SlaMeter[]>([]);
  const [alerts, setAlerts] = useState<SlaAlert[]>([]);
  const [status, setStatus] = useState("Loading operational reports…");
  const [error, setError] = useState<string | null>(null);
  const [groupId, setGroupId] = useState("");
  const [ruleJson, setRuleJson] = useState("");
  const [meterId, setMeterId] = useState("");
  const [targetJson, setTargetJson] = useState('{"uptimePct":99.5,"responseP95Ms":1000,"responseSuccessPct":99,"mtbfMs":86400000}');
  const request = useCallback(async (path: string, init?: RequestInit) => {
    const token = sessionStorage.getItem("admin_token");
    if (!token) throw new Error("Sign in as admin to view or configure operational reports");
    const res = await fetch(`${env.NEXT_PUBLIC_BACKEND_URL}/api${path}`, { ...init, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` } });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "Operational request failed");
    return data;
  }, []);
  const refresh = useCallback(async () => {
    setError(null); setStatus("Loading operational reports…");
    try {
      const [load, sla] = await Promise.all([request("/load-balancing"), request("/sla")]);
      setGroups(load.groups); setMeters(sla.meters); setAlerts(sla.alerts); setStatus("Operational reports updated");
    } catch (err) { setError(err instanceof Error ? err.message : "Report failed"); setStatus(""); }
  }, [request]);
  useEffect(() => { void refresh(); }, [refresh]);
  async function save(kind: "rule" | "sla") {
    setError(null);
    try {
      const id = kind === "rule" ? groupId : meterId;
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error("Enter a valid ID (letters, digits, underscore, hyphen)");
      const value = JSON.parse(kind === "rule" ? ruleJson : targetJson);
      // Server is the authoritative strict validator; never enable a generated/default topology.
      await request(kind === "rule" ? `/load-balancing/rules/${encodeURIComponent(id)}` : `/meters/${encodeURIComponent(id)}/sla`, { method: "PUT", body: JSON.stringify(value) });
      await refresh();
    } catch (err) { setError(err instanceof Error ? err.message : "Save failed"); }
  }
  return <div className="space-y-8">
    <p className="text-sm text-gray-300">Only use commissioned electrical paths and a compatible interlocked controller. A published request is not a physical transfer; unresolved outcomes stop further automatic control.</p>
    <button type="button" onClick={() => void refresh()} className="underline">Refresh operational reports</button>
    <p role="status">{status}</p>{error && <p role="alert" className="text-red-400">{error}</p>}
    <section className="border border-white/10 rounded-xl p-5 space-y-4"><h2 className="text-xl font-bold">Load distribution</h2><LoadDistribution groups={groups} />
      <details><summary>Configure explicit load rules</summary><form onSubmit={e => { e.preventDefault(); void save("rule"); }} className="space-y-3 mt-3">
        <label className="block">Group ID<input required value={groupId} onChange={e => setGroupId(e.target.value)} className="block bg-solar-dark border p-2 w-full" /></label>
        <label className="block">Validated rule JSON<textarea required rows={8} value={ruleJson} onChange={e => setRuleJson(e.target.value)} className="block bg-solar-dark border p-2 w-full font-mono" /></label>
        <p className="text-sm">Required: id, controllerId, members with capacityWatts, directed paths, maxTransferWatts. enabled defaults to false. See backend/README.md before enabling.</p>
        <button className="underline" type="submit">Save load rules</button>
      </form></details>
    </section>
    <section className="border border-white/10 rounded-xl p-5 space-y-4"><h2 className="text-xl font-bold">Meter SLA dashboard</h2><SlaReports meters={meters} alerts={alerts} />
      <details><summary>Configure SLA targets</summary><form onSubmit={e => { e.preventDefault(); void save("sla"); }} className="space-y-3 mt-3">
        <label className="block">Meter ID<input required value={meterId} onChange={e => setMeterId(e.target.value)} className="block bg-solar-dark border p-2 w-full" /></label>
        <label className="block">SLA target JSON<textarea required rows={5} value={targetJson} onChange={e => setTargetJson(e.target.value)} className="block bg-solar-dark border p-2 w-full font-mono" /></label>
        <p className="text-sm">Saving starts a new measurement epoch. SLA_PING/PONG firmware support is needed for response targets. See docs/SLA.md.</p>
        <button className="underline" type="submit">Save SLA targets</button>
      </form></details>
    </section>
  </div>;
}
