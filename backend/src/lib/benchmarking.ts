export interface MeterProfile {
  meterId: string;
  lat: number;
  lng: number;
  capacityKw: number;
  ageYears: number;
  /** Actual daily output in kWh */
  dailyKwh: number;
  /** Fraction of daily output produced in morning vs afternoon, used to infer shading */
  morningRatio?: number;
}

export interface Outlier {
  meterId: string;
  clusterId: number;
  performanceRatio: number;
  zScore: number;
  rootCause: string;
  recommendation: string;
}

const features = (m: MeterProfile) => [m.lat, m.lng, m.capacityKw / 10, m.ageYears / 5];
const dist = (a: number[], b: number[]) => Math.sqrt(a.reduce((s, v, i) => s + (v - b[i]) ** 2, 0));

/** k-means clustering on location, capacity and age. */
export function clusterMeters(meters: MeterProfile[], k = Math.max(1, Math.round(Math.sqrt(meters.length / 2))), iters = 20): number[] {
  if (!meters.length) return [];
  const pts = meters.map(features);
  let centroids = pts.slice(0, Math.min(k, pts.length)).map((p) => [...p]);
  let labels = new Array(pts.length).fill(0);
  for (let it = 0; it < iters; it++) {
    labels = pts.map((p) => centroids.reduce((best, c, i) => (dist(p, c) < dist(p, centroids[best]) ? i : best), 0));
    centroids = centroids.map((c, i) => {
      const members = pts.filter((_, j) => labels[j] === i);
      return members.length ? c.map((_, d) => members.reduce((s, m) => s + m[d], 0) / members.length) : c;
    });
  }
  return labels;
}

function diagnose(m: MeterProfile, ratio: number, clusterMean: number): [string, string] {
  if (m.morningRatio !== undefined && (m.morningRatio < 0.3 || m.morningRatio > 0.7))
    return ["Partial shading", "Inspect surroundings and trim vegetation or relocate panels"];
  if (ratio < clusterMean * 0.5) return ["Faulty panel or inverter", "Dispatch technician to test panel strings and inverter"];
  if (m.ageYears > 15) return ["Panel degradation", "Schedule panel replacement"];
  return ["Soiling / dirty panels", "Schedule panel cleaning"];
}

/** Detect underperforming meters within each cluster using z-score of performance ratio. */
export function detectOutliers(meters: MeterProfile[], threshold = -1.5): Outlier[] {
  const labels = clusterMeters(meters);
  const ratios = meters.map((m) => m.dailyKwh / Math.max(m.capacityKw, 0.001));
  const out: Outlier[] = [];
  for (const cid of new Set(labels)) {
    const idx = labels.map((l, i) => (l === cid ? i : -1)).filter((i) => i >= 0);
    const vals = idx.map((i) => ratios[i]);
    const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
    const std = Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length) || 1e-9;
    for (const i of idx) {
      const z = (ratios[i] - mean) / std;
      if (vals.length > 2 && z < threshold) {
        const [rootCause, recommendation] = diagnose(meters[i], ratios[i], mean);
        out.push({ meterId: meters[i].meterId, clusterId: cid, performanceRatio: ratios[i], zScore: z, rootCause, recommendation });
      }
    }
  }
  return out;
}

/** Tracks performance before/after corrective actions. */
const fixes = new Map<string, { baseline: number; fixedAt: number; action: string }>();

export function recordFix(meterId: string, baselineRatio: number, action: string) {
  fixes.set(meterId, { baseline: baselineRatio, fixedAt: Date.now(), action });
}

export function improvement(meterId: string, currentRatio: number) {
  const f = fixes.get(meterId);
  if (!f) return null;
  return { ...f, current: currentRatio, improvementPct: ((currentRatio - f.baseline) / (f.baseline || 1)) * 100 };
}
