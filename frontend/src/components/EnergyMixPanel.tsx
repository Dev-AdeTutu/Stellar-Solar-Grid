"use client";

import { useEffect, useState } from "react";
import { env } from "@/lib/env";

export type EnergyMix = {
  meterId: string; totalUnits: number; hasData: boolean; readings: number;
  percentages: Record<"solar" | "grid" | "battery" | "unknown", number>;
  units: Record<"solar" | "grid" | "battery" | "unknown", number>;
};
const SOURCES = [
  { key: "solar", label: "Solar", color: "#facc15" },
  { key: "grid", label: "Grid", color: "#60a5fa" },
  { key: "battery", label: "Battery", color: "#4ade80" },
  { key: "unknown", label: "Unreported", color: "#9ca3af" },
] as const;

export function EnergyMixChart({ mix }: { mix: EnergyMix }) {
  let start = 0;
  const gradient = SOURCES.map(source => {
    const end = start + mix.percentages[source.key];
    const segment = `${source.color} ${start}% ${end}%`;
    start = end;
    return segment;
  }).join(",");
  if (!mix.hasData) return <p>No energy readings available. No source percentages can be inferred.</p>;
  return <figure className="flex flex-wrap gap-6 items-center">
    <div role="img" aria-label={`Energy source pie chart for ${mix.meterId}; exact values in source breakdown table`} className="w-40 h-40 rounded-full shrink-0" style={{ background: `conic-gradient(${gradient})` }} />
    <table className="text-sm text-left">
      <caption className="text-left mb-2">Source breakdown — energy-weighted, not reading count</caption>
      <thead><tr><th scope="col" className="pr-6">Source</th><th scope="col" className="pr-6">Energy (kWh)</th><th scope="col">Share</th></tr></thead>
      <tbody>{SOURCES.map(source => <tr key={source.key}>
        <th scope="row" className="pr-6 py-1"><span aria-hidden="true" style={{ backgroundColor: source.color }} className="inline-block w-3 h-3 mr-2" />{source.label}</th>
        <td className="pr-6">{(mix.units[source.key] / 1000).toFixed(3)}</td><td>{mix.percentages[source.key].toFixed(2)}%</td>
      </tr>)}</tbody>
    </table>
    <figcaption className="w-full text-sm text-gray-400">{mix.readings} locally received readings. Pending billing is included; this is device-reported attribution, not verified renewable certification.</figcaption>
  </figure>;
}

export default function EnergyMixPanel({ meterId }: { meterId: string }) {
  const [mix, setMix] = useState<EnergyMix | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setMix(null); setError(null);
    fetch(`${env.NEXT_PUBLIC_BACKEND_URL}/api/meters/${encodeURIComponent(meterId)}/energy-mix`, { signal: controller.signal })
      .then(async response => { if (!response.ok) throw new Error("Energy source report unavailable"); return response.json(); })
      .then(setMix).catch(err => { if (err.name !== "AbortError") setError(err.message); });
    return () => controller.abort();
  }, [meterId, refresh]);
  return <section aria-label="Energy source tracking" className="rounded-xl border border-white/10 p-6 space-y-4">
    <h2 className="text-xl font-bold">Energy mix — {meterId}</h2>
    <button type="button" className="underline" onClick={() => setRefresh(n => n + 1)}>Refresh energy mix</button>
    {error ? <p role="alert">{error}</p> : mix ? <EnergyMixChart mix={mix} /> : <p role="status">Loading energy mix…</p>}
  </section>;
}
