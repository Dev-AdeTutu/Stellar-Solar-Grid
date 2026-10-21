export type HourlyEnergySample = { timestamp: string; energyKwh: number };

export type HourlyEnergyModel = {
  coefficients: number[];
  trainingSamples: number;
  observedSamples: number;
  accuracyPct: number | null;
  trainedAt: string;
};

const FEATURE_COUNT = 5;
const RIDGE_LAMBDA = 1e-6;

function features(timestamp: string): number[] {
  const date = new Date(timestamp);
  const hour = date.getUTCHours();
  const weekday = date.getUTCDay();
  return [
    1,
    Math.sin((2 * Math.PI * hour) / 24),
    Math.cos((2 * Math.PI * hour) / 24),
    Math.sin((2 * Math.PI * weekday) / 7),
    Math.cos((2 * Math.PI * weekday) / 7),
  ];
}

/**
 * Gauss-Jordan elimination for a square system with partial pivoting.
 * Exported so other ridge models in this package reuse one solver.
 */
export function solveLinearSystem(matrix: number[][], values: number[]): number[] {
  const size = values.length;
  const augmented = matrix.map((row, index) => [...row, values[index]]);
  for (let column = 0; column < size; column++) {
    let pivot = column;
    for (let row = column + 1; row < size; row++) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    }
    if (Math.abs(augmented[pivot][column]) < 1e-12) continue;
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    const divisor = augmented[column][column];
    for (let entry = column; entry <= size; entry++) augmented[column][entry] /= divisor;
    for (let row = 0; row < size; row++) {
      if (row === column) continue;
      const factor = augmented[row][column];
      for (let entry = column; entry <= size; entry++) {
        augmented[row][entry] -= factor * augmented[column][entry];
      }
    }
  }
  return augmented.map((row) => row[size]);
}

function fit(samples: HourlyEnergySample[]): number[] {
  if (samples.length === 0) return Array(FEATURE_COUNT).fill(0);
  if (samples.length < FEATURE_COUNT + 1) {
    const mean = samples.reduce((sum, sample) => sum + sample.energyKwh, 0) / samples.length;
    return [mean, 0, 0, 0, 0];
  }

  const xtx = Array.from({ length: FEATURE_COUNT }, () => Array(FEATURE_COUNT).fill(0));
  const xty = Array(FEATURE_COUNT).fill(0);
  for (const sample of samples) {
    const row = features(sample.timestamp);
    for (let i = 0; i < FEATURE_COUNT; i++) {
      xty[i] += row[i] * sample.energyKwh;
      for (let j = 0; j < FEATURE_COUNT; j++) xtx[i][j] += row[i] * row[j];
    }
  }
  for (let i = 1; i < FEATURE_COUNT; i++) xtx[i][i] += RIDGE_LAMBDA;
  return solveLinearSystem(xtx, xty);
}

function predictWith(coefficients: number[], timestamp: string): number {
  return Math.max(0, features(timestamp).reduce((sum, feature, index) => sum + feature * coefficients[index], 0));
}

export function trainHourlyModel(input: HourlyEnergySample[], now = new Date()): HourlyEnergyModel {
  const samples = input
    .filter((sample) => Number.isFinite(Date.parse(sample.timestamp)) && Number.isFinite(sample.energyKwh) && sample.energyKwh >= 0)
    .slice()
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

  let accuracyPct: number | null = null;
  if (samples.length >= 48) {
    const holdoutSize = Math.max(12, Math.floor(samples.length * 0.2));
    const split = samples.length - holdoutSize;
    const coefficients = fit(samples.slice(0, split));
    const holdout = samples.slice(split);
    const totalObserved = holdout.reduce((sum, sample) => sum + sample.energyKwh, 0);
    if (totalObserved > 0) {
      const weightedAbsoluteError = holdout.reduce(
        (sum, sample) => sum + Math.abs(sample.energyKwh - predictWith(coefficients, sample.timestamp)),
        0,
      ) / totalObserved;
      accuracyPct = Math.max(0, Math.min(100, (1 - weightedAbsoluteError) * 100));
    }
  }

  return {
    coefficients: fit(samples),
    trainingSamples: samples.length,
    observedSamples: samples.filter((sample) => sample.energyKwh > 0).length,
    accuracyPct,
    trainedAt: now.toISOString(),
  };
}

export function predictHourly(model: HourlyEnergyModel, timestamp: string): number {
  return predictWith(model.coefficients, timestamp);
}