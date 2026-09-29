const MIN_BASELINE_SIZE = 12;
function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function scoreUsageAnomaly(units: number, history: number[], minSpikeUnits = 10): { baseline: number; score: number; anomalous: boolean } {
  const samples = history.filter((value) => Number.isFinite(value) && value >= 0);
  const baseline = median(samples);
  if (samples.length < MIN_BASELINE_SIZE || !Number.isFinite(units) || units < 0) {
    return { baseline, score: 0, anomalous: false };
  }
  const mad = median(samples.map((sample) => Math.abs(sample - baseline)));
  const robustScale = Math.max(1.4826 * mad, baseline * 0.25, 1);
  const safeMinimum = Number.isFinite(minSpikeUnits) && minSpikeUnits >= 0 ? minSpikeUnits : 10;
  const threshold = baseline + Math.max(6 * robustScale, baseline * 3, safeMinimum);
  const score = Math.max(0, (units - baseline) / robustScale);
  return { baseline, score, anomalous: units > threshold };
}