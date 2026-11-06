import { useEffect, useState } from "react";
import { env } from "@/lib/env";

const BACKEND_URL = env.NEXT_PUBLIC_BACKEND_URL;
const REFRESH_MS = 60_000;

interface RegionPrice {
  region: string;
  price: number;
  energy: number;
  congestion: number;
  loss: number;
  utilization: number;
  intensity: number;
}

/** Green (cheap) → red (congested) colour for a 0..1 intensity. */
const colorFor = (t: number) => `hsl(${Math.round(120 * (1 - t))}, 70%, 45%)`;

/** Locational marginal price heatmap by region (#1057). */
export function RegionalPriceHeatmap() {
  const [regions, setRegions] = useState<RegionPrice[]>([]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const res = await fetch(`${BACKEND_URL}/api/pricing/heatmap`);
      if (res.ok && !cancelled) setRegions(await res.json());
    };
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  return (
    <section aria-label="Regional price heatmap">
      <h3>Grid price by region</h3>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 8 }}>
        {regions.map((r) => (
          <div
            key={r.region}
            title={`energy ${r.energy} + congestion ${r.congestion} + loss ${r.loss}`}
            style={{ background: colorFor(r.intensity), color: "#fff", padding: 12, borderRadius: 6 }}
          >
            <strong>{r.region}</strong>
            <div>{r.price} XLM/kWh</div>
            <small>load {Math.round(r.utilization * 100)}%</small>
          </div>
        ))}
      </div>
    </section>
  );
}
