import { useEffect, useRef, useState } from "react";
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
  const [activeRegion, setActiveRegion] = useState<string | null>(null);
  const [flipLeft, setFlipLeft] = useState(false);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const cellRefs = useRef<Record<string, HTMLDivElement | null>>({});

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

  // Decide whether a right-side tooltip would overflow the viewport (#1234).
  const updatePlacement = () => {
    if (!activeRegion) return;
    const cell = cellRefs.current[activeRegion];
    const tooltip = tooltipRef.current;
    if (!cell || !tooltip) return;
    const cellRect = cell.getBoundingClientRect();
    const tooltipWidth = tooltip.getBoundingClientRect().width;
    setFlipLeft(cellRect.left + cellRect.width + tooltipWidth > window.innerWidth);
  };

  // Recompute placement on hover/focus and whenever the window resizes.
  useEffect(() => {
    if (!activeRegion) return;
    updatePlacement();
    const onResize = () => updatePlacement();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [activeRegion]);

  const active = regions.find((r) => r.region === activeRegion) ?? null;

  return (
    <section aria-label="Regional price heatmap">
      <h3>Grid price by region</h3>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 8 }}>
        {regions.map((r) => (
          <div
            key={r.region}
            ref={(el) => { cellRefs.current[r.region] = el; }}
            tabIndex={0}
            aria-describedby={activeRegion === r.region ? "regional-price-tooltip" : undefined}
            onMouseEnter={() => setActiveRegion(r.region)}
            onMouseLeave={() => setActiveRegion(null)}
            onFocus={() => setActiveRegion(r.region)}
            onBlur={() => setActiveRegion(null)}
            style={{ position: "relative", background: colorFor(r.intensity), color: "#fff", padding: 12, borderRadius: 6 }}
          >
            <strong>{r.region}</strong>
            <div>{r.price} XLM/kWh</div>
            <small>load {Math.round(r.utilization * 100)}%</small>
            {activeRegion === r.region && active && (
              <div
                id="regional-price-tooltip"
                role="tooltip"
                ref={tooltipRef}
                style={{
                  position: "absolute",
                  top: "100%",
                  ...(flipLeft ? { right: 0 } : { left: 0 }),
                  marginTop: 4,
                  background: "#111",
                  color: "#fff",
                  padding: "6px 8px",
                  borderRadius: 4,
                  fontSize: 12,
                  whiteSpace: "nowrap",
                  zIndex: 10,
                }}
              >
                energy {active.energy} + congestion {active.congestion} + loss {active.loss}
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
