"use client";
import { useMemo, useState } from "react";

export type MeterMapPoint = { meter_id: string; latitude: number; longitude: number; active: boolean; usage: number; region?: string; provider?: string };
export type MeterMapFilters = { region?: string; status?: "all" | "active" | "inactive"; provider?: string };

const CLUSTER_THRESHOLD = 200;
const CLUSTER_CELL_SIZE = 5; // grid cell size in projected map percent

function project(point: MeterMapPoint) { return { x: ((point.longitude + 180) / 360) * 100, y: ((90 - point.latitude) / 180) * 100 }; }
export default function MeterMap({ points }: { points: MeterMapPoint[] }) {
  const [filters, setFilters] = useState<MeterMapFilters>({ status: "all" });
  const [expandedClusters, setExpandedClusters] = useState<Set<string>>(() => new Set());
  const regions = useMemo(() => [...new Set(points.map((p) => p.region).filter(Boolean))] as string[], [points]);
  const providers = useMemo(() => [...new Set(points.map((p) => p.provider).filter(Boolean))] as string[], [points]);
  const visible = points.filter((p) => (!filters.region || p.region === filters.region) && (!filters.provider || p.provider === filters.provider) && (filters.status === "all" || !filters.status || (filters.status === "active" ? p.active : !p.active)));

  // Group visible markers into grid cells once the map becomes too dense.
  const clustered = visible.length > CLUSTER_THRESHOLD;
  const clusters = new Map<string, MeterMapPoint[]>();
  if (clustered) {
    for (const point of visible) {
      const pos = project(point);
      const key = `${Math.floor(pos.x / CLUSTER_CELL_SIZE)}:${Math.floor(pos.y / CLUSTER_CELL_SIZE)}`;
      const cell = clusters.get(key);
      if (cell) cell.push(point);
      else clusters.set(key, [point]);
    }
  }

  const expandCluster = (key: string) => {
    setExpandedClusters((prev) => {
      if (prev.has(key)) return prev;
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  };

  const renderMarker = (point: MeterMapPoint) => {
    const pos = project(point);
    const radius = Math.max(0.8, Math.min(4, Math.log10(point.usage + 1) + 1));
    return <button key={point.meter_id} type="button" title={`${point.meter_id}: ${point.usage} usage`} aria-label={`Meter ${point.meter_id}`} className={`absolute rounded-full border-2 border-white/70 ${point.active ? "bg-emerald-400" : "bg-slate-500"}`} style={{ left: `${pos.x}%`, top: `${pos.y}%`, width: `${radius * 2}%`, aspectRatio: "1", transform: "translate(-50%, -50%)", boxShadow: `0 0 ${radius * 3}px ${point.active ? "#34d399" : "#64748b"}` }}>{point.meter_id}</button>;
  };

  return <section aria-label="Meter geographic heat map" className="rounded-xl border border-white/10 bg-solar-accent p-4 space-y-3">
    <div className="flex flex-wrap gap-2 text-xs"><select aria-label="Filter by region" value={filters.region ?? ""} onChange={(e) => setFilters({ ...filters, region: e.target.value || undefined })} className="rounded bg-solar-dark p-2 text-white"><option value="">All regions</option>{regions.map((r) => <option key={r}>{r}</option>)}</select><select aria-label="Filter by status" value={filters.status ?? "all"} onChange={(e) => setFilters({ ...filters, status: e.target.value as MeterMapFilters["status"] })} className="rounded bg-solar-dark p-2 text-white"><option value="all">All statuses</option><option value="active">Active</option><option value="inactive">Inactive</option></select><select aria-label="Filter by provider" value={filters.provider ?? ""} onChange={(e) => setFilters({ ...filters, provider: e.target.value || undefined })} className="rounded bg-solar-dark p-2 text-white"><option value="">All providers</option>{providers.map((p) => <option key={p}>{p}</option>)}</select></div>
    <div className="relative aspect-[2/1] overflow-hidden rounded-lg bg-solar-dark" role="img" aria-label={`${visible.length} meters shown on map`}><div className="absolute inset-0 opacity-20" style={{ backgroundImage: "linear-gradient(#94a3b8 1px, transparent 1px), linear-gradient(90deg, #94a3b8 1px, transparent 1px)", backgroundSize: "10% 20%" }} />
      {!clustered && visible.map(renderMarker)}
      {clustered && [...clusters.entries()].map(([key, members]) => {
        if (expandedClusters.has(key)) return members.map(renderMarker);
        const [col, row] = key.split(":").map(Number);
        return <button key={`cluster-${key}`} type="button" data-testid={`meter-cluster-${key}`} title={`${members.length} meters in this cluster`} aria-label={`Cluster of ${members.length} meters - click to expand`} onClick={() => expandCluster(key)} className="absolute flex items-center justify-center rounded-full border-2 border-white/80 bg-solar-accent text-[10px] font-bold text-white" style={{ left: `${(col + 0.5) * CLUSTER_CELL_SIZE}%`, top: `${(row + 0.5) * CLUSTER_CELL_SIZE}%`, width: "3.5%", aspectRatio: "1", transform: "translate(-50%, -50%)" }}>{members.length}</button>;
      })}
    </div><p className="text-xs text-gray-400">{visible.length} of {points.length} meters shown. Marker size represents usage density; green markers are active.</p>
  </section>;
}
