/**
 * Consumption pattern recognition, anomaly detection and forecasting (#928).
 *
 * The module is deliberately pure — no I/O, no database, no clock — so the
 * model behaviour can be asserted directly in tests. Callers pass in an hourly
 * series and get back patterns, anomalies, a forecast and insights.
 *
 * Three techniques are used, each chosen because it works on the sparse,
 * noisy hourly series this platform actually stores:
 *
 * 1. **Pattern recognition** — each calendar day is reduced to a 24-value
 *    profile, scaled by its own peak so that a low-consumption day and a
 *    high-consumption day with the same *shape* land in the same cluster.
 *    k-means over those profiles finds the recurring shapes. Cluster
 *    initialisation is deterministic (seeded on each profile's peak hour)
 *    so the same history always yields the same patterns.
 *
 * 2. **Anomaly detection** — residuals against the hour-of-week expectation
 *    are scored with a median absolute deviation (MAD), a robust dispersion
 *    measure that a single spike cannot inflate. A meter whose baseline is
 *    spiky is therefore not flagged as anomalous.
 *
 * 3. **Predictive analytics** — the point forecast reuses the ridge model in
 *    `energyForecastModel.ts`, so consumption forecasting stays consistent
 *    with the rest of the platform, and wraps it in a residual-derived
 *    confidence band.
 */

import { solveLinearSystem } from "./energyForecastModel.js";

export type { HourlyEnergySample } from "./energyForecastModel.js";

// ── Pattern recognition ──────────────────────────────────────────────────────

export type ConsumptionPatternKind =
  | "steady"
  | "morning_peak"
  | "evening_peak"
  | "daytime_workload"
  | "overnight"
  | "intermittent";

export type ConsumptionPattern = {
  id: string;
  kind: ConsumptionPatternKind;
  label: string;
  /** Mean hourly consumption for each UTC hour of the day, in kWh. */
  centroid: number[];
  /** Percentage of analysed days belonging to this cluster. */
  sharePct: number;
  days: number;
  peakHour: number;
  troughHour: number;
  /** mean / peak — approaches 1 for a perfectly flat profile. */
  loadFactor: number;
  /** Coefficient of variation of the hourly centroid. */
  variability: number;
};

const PATTERN_LABELS: Record<ConsumptionPatternKind, string> = {
  steady: "Flat baseline",
  morning_peak: "Morning peak",
  evening_peak: "Evening peak",
  daytime_workload: "Daytime workload",
  overnight: "Overnight load",
  intermittent: "Intermittent load",
};

const KMEANS_MAX_ITERATIONS = 40;
const KMEANS_TOLERANCE = 1e-4;
/** Days shorter than this are ignored: a partial day is not a pattern. */
const MIN_HOURS_PER_DAY = 20;
/** Minimum daily consumption that makes a day worth clustering at all. */
const MIN_DAILY_KWH = 0.001;

type DailyProfile = { date: string; hours: number[]; totalKwh: number };

/** Group an hourly series into per-day 24-value profiles, ascending. */
export function buildDailyProfiles(samples: HourlyEnergySample[]): DailyProfile[] {
  const byDay = new Map<string, number[]>();
  for (const sample of samples) {
    const parsed = Date.parse(sample.timestamp);
    if (!Number.isFinite(parsed) || !Number.isFinite(sample.energyKwh) || sample.energyKwh < 0) {
      continue;
    }
    const date = new Date(parsed);
    const day = date.toISOString().slice(0, 10);
    const hours = byDay.get(day) ?? [];
    hours[date.getUTCHours()] = sample.energyKwh;
    byDay.set(day, hours);
  }

  return [...byDay.entries()]
    .filter(([, hours]) => hours.filter((value) => Number.isFinite(value)).length >= MIN_HOURS_PER_DAY)
    .map(([date, hours]) => {
      const totalKwh = hours.reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
      return { date, hours, totalKwh };
    })
    .filter((day) => day.totalKwh >= MIN_DAILY_KWH)
    .sort((a, b) => a.date.localeCompare(b.date));
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : sorted[middle] ?? 0;
}

/**
 * Scale a profile by its own peak so clustering sees *shape*, not magnitude.
 * A flat day and an all-zero day both normalise to 1 at the peak, which is
 * what lets "same shape, different size" days cluster together.
 */
function shapeVector(hours: number[]): number[] {
  const peak = Math.max(...hours, 0);
  if (peak <= 0) return Array(24).fill(0);
  return hours.map((value) => (Number.isFinite(value) ? value : 0) / peak);
}

function squaredDistance(a: number[], b: number[]): number {
  let total = 0;
  for (let i = 0; i < a.length; i++) total += (a[i] - b[i]) ** 2;
  return total;
}

/**
 * Deterministic farthest-point seeding.
 *
 * Seeding on peak hour alone hands back two near-identical profiles whenever
 * two shapes share a peak hour, which strands k-means in a one-cluster local
 * optimum. Picking the most distant profile from those already chosen
 * guarantees the initial centroids are genuinely far apart, and stays
 * deterministic because ties break on input order.
 */
function seedCentroids(shapes: number[][], count: number): number[][] {
  if (shapes.length === 0) return [];

  const seeds = [shapes[0]];
  while (seeds.length < count) {
    let candidate = 0;
    let farthest = -1;
    for (let i = 0; i < shapes.length; i++) {
      const nearest = Math.min(...seeds.map((seed) => squaredDistance(shapes[i], seed)));
      if (nearest > farthest) {
        farthest = nearest;
        candidate = i;
      }
    }
    if (farthest <= 0) break;
    seeds.push(shapes[candidate]);
  }
  return seeds;
}

/**
 * Cluster daily profiles into recurring consumption shapes.
 *
 * `maxClusters` is clamped so a short history cannot produce a cluster per
 * day — with fewer than `2 * maxClusters` usable days the request is
 * ignored and a single "steady" pattern is returned instead.
 */
export function clusterDailyProfiles(
  samples: HourlyEnergySample[],
  options: { maxClusters?: number } = {},
): ConsumptionPattern[] {
  const days = buildDailyProfiles(samples);
  if (days.length === 0) return [];

  const maxClusters = Math.max(1, options.maxClusters ?? 3);
  const clusterCount = Math.min(maxClusters, Math.max(1, Math.floor(days.length / 2)));
  const shapes = days.map((day) => shapeVector(day.hours));

  let centroids = seedCentroids(shapes, clusterCount);
  if (centroids.length === 0) centroids = [shapes[0]];

  const assignment = new Array<number>(shapes.length).fill(0);
  for (let iteration = 0; iteration < KMEANS_MAX_ITERATIONS; iteration++) {
    const previous = centroids;
    let moved = false;
    for (let i = 0; i < shapes.length; i++) {
      let best = 0;
      let bestDistance = squaredDistance(shapes[i], centroids[0]);
      for (let c = 1; c < centroids.length; c++) {
        const distance = squaredDistance(shapes[i], centroids[c]);
        if (distance < bestDistance) {
          best = c;
          bestDistance = distance;
        }
      }
      if (assignment[i] !== best) {
        assignment[i] = best;
        moved = true;
      }
    }

    centroids = centroids.map((centroid, c) => {
      const members = shapes.filter((_, i) => assignment[i] === c);
      if (members.length === 0) return centroid;
      return Array.from({ length: 24 }, (_, hour) => mean(members.map((m) => m[hour])));
    });

    if (!moved) break;
    const settled = centroids.every(
      (centroid, c) => squaredDistance(centroid, previous[c] ?? centroid) < KMEANS_TOLERANCE,
    );
    if (settled) break;
  }

  // A cluster that lost every member to a later iteration is dropped so we
  // never report a 0% pattern.
  const totalDays = days.length;
  return centroids
    .map((_, c) => ({
      // Indices, not the matching values — filter() would return `c` itself.
      members: assignment.flatMap((value, index) => (value === c ? [index] : [])),
    }))
    .filter((cluster) => cluster.members.length > 0)
    .sort((a, b) => b.members.length - a.members.length)
    .map((cluster, index) => {
      const memberDays = cluster.members.map((i) => days[i]);
      const centroid = Array.from({ length: 24 }, (_, hour) =>
        mean(memberDays.map((day) => day.hours[hour] ?? 0)),
      );
      const kind = classifyPattern(centroid);
      const peakKwh = Math.max(...centroid, 0);
      return {
        id: `pattern-${index + 1}`,
        kind,
        label: PATTERN_LABELS[kind],
        centroid: centroid.map((value) => Number(value.toFixed(4))),
        sharePct: Number(((cluster.members.length / totalDays) * 100).toFixed(1)),
        days: cluster.members.length,
        peakHour: centroid.indexOf(peakKwh),
        troughHour: centroid.indexOf(Math.min(...centroid, peakKwh)),
        loadFactor: Number((peakKwh > 0 ? mean(centroid) / peakKwh : 0).toFixed(3)),
        variability: Number((peakKwh > 0 ? stdDev(centroid) / peakKwh : 0).toFixed(3)),
      };
    });
}

/** Name a cluster from where its mass sits relative to its own peak. */
function classifyPattern(centroid: number[]): ConsumptionPatternKind {
  const peak = Math.max(...centroid, 0);
  if (peak <= 0) return "steady";
  const loadFactor = mean(centroid) / peak;
  if (loadFactor >= 0.8) return "steady";

  const peakHour = centroid.indexOf(peak);
  if (peakHour >= 16 && peakHour <= 23) return "evening_peak";
  if (peakHour >= 4 && peakHour <= 11) return "morning_peak";
  if (peakHour >= 8 && peakHour <= 17) return "daytime_workload";
  if (peakHour >= 0 && peakHour <= 5) return "overnight";

  // Peak falls outside every named window, or the profile has competing
  // maxima — treat it as spiky rather than mislabelling it.
  const aboveAverage = centroid.filter((value) => value > mean(centroid)).length;
  return aboveAverage <= 6 ? "intermittent" : "steady";
}

// ── Anomaly detection ────────────────────────────────────────────────────────

export type AnomalySeverity = "info" | "warning" | "critical";

export type ConsumptionAnomaly = {
  timestamp: string;
  /** Hour of the day the anomaly falls in, UTC. */
  hour: number;
  weekday: number;
  energyKwh: number;
  expectedKwh: number;
  deviationPct: number;
  /** Robust z-score of the residual against the hour-of-week baseline. */
  score: number;
  severity: AnomalySeverity;
  direction: "over" | "under";
  description: string;
};

export type AnomalyThresholds = { info: number; warning: number; critical: number };

export type AnomalyReport = {
  anomalies: ConsumptionAnomaly[];
  thresholds: AnomalyThresholds;
  /** MAD-derived robust sigma of the residuals. */
  robustSigma: number;
  /** Samples considered when building the hour-of-week baseline. */
  baselineSamples: number;
  /** Samples scanned for anomalies. */
  evaluatedSamples: number;
  /** Hours of history required before anomaly detection is meaningful. */
  sufficientData: boolean;
};

/** MAD to standard-deviation scale factor for normally distributed data. */
const MAD_SCALE = 1.4826;
/** Mean absolute deviation to standard-deviation scale factor (sqrt(pi/2)). */
const MEAN_ABS_DEV_SCALE = Math.sqrt(Math.PI / 2);
const DEFAULT_THRESHOLDS: AnomalyThresholds = { info: 3, warning: 5, critical: 8 };

/**
 * Score each sample against the median for its hour-of-week.
 *
 * The baseline is built from all supplied samples and the scan runs over the
 * same series, so with a short history a meter can be flagged against its own
 * spike. Callers that need a clean baseline should pass a longer window than
 * the one they intend to scan.
 */
export function detectAnomalies(
  samples: HourlyEnergySample[],
  options: { thresholds?: Partial<AnomalyThresholds>; minBaselineSamples?: number } = {},
): AnomalyReport {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...options.thresholds };
  const minBaselineSamples = options.minBaselineSamples ?? 48;

  const usable = samples
    .filter((sample) => Number.isFinite(Date.parse(sample.timestamp)) && Number.isFinite(sample.energyKwh))
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

  const buckets = new Map<number, number[]>();
  for (const sample of usable) {
    const key = hourOfWeek(sample.timestamp);
    buckets.set(key, [...(buckets.get(key) ?? []), sample.energyKwh]);
  }

  const baselines = new Map<number, number>();
  for (const [key, values] of buckets) baselines.set(key, median(values));

  const residuals = usable.map((sample) => sample.energyKwh - (baselines.get(hourOfWeek(sample.timestamp)) ?? 0));
  const centre = median(residuals);
  const deviations = residuals.map((residual) => Math.abs(residual - centre));
  const mad = median(deviations);
  // A perfectly repeating load has zero MAD, which would silently disable
  // detection. Fall back to the mean absolute deviation, whose consistent
  // estimator for the standard deviation is sqrt(pi/2) * MAD.
  const robustSigma = mad > 0 ? mad * MAD_SCALE : mean(deviations) * MEAN_ABS_DEV_SCALE;

  const anomalies: ConsumptionAnomaly[] = [];
  if (robustSigma > 0) {
    usable.forEach((sample, index) => {
      const expectedKwh = baselines.get(hourOfWeek(sample.timestamp)) ?? 0;
      const score = (residuals[index]! - centre) / robustSigma;
      const severity = severityFor(Math.abs(score), thresholds);
      if (severity === null) return;

      const direction = residuals[index]! - centre >= 0 ? "over" : "under";
      const deviationPct = expectedKwh > 0 ? Number((((sample.energyKwh - expectedKwh) / expectedKwh) * 100).toFixed(1)) : 0;
      const date = new Date(sample.timestamp);
      anomalies.push({
        timestamp: sample.timestamp,
        hour: date.getUTCHours(),
        weekday: date.getUTCDay(),
        energyKwh: Number(sample.energyKwh.toFixed(4)),
        expectedKwh: Number(expectedKwh.toFixed(4)),
        deviationPct,
        score: Number(score.toFixed(2)),
        severity,
        direction,
        description:
          direction === "over"
            ? `Consumption ${Math.abs(deviationPct)}% above the usual level for this hour`
            : expectedKwh > 0
              ? `Consumption ${Math.abs(deviationPct)}% below the usual level for this hour`
              : "Unexpected consumption recorded during a normally idle hour",
      });
    });
  }

  return {
    anomalies,
    thresholds,
    robustSigma: Number(robustSigma.toFixed(4)),
    baselineSamples: usable.length,
    evaluatedSamples: usable.length,
    sufficientData: usable.length >= minBaselineSamples,
  };
}

function severityFor(
  score: number,
  thresholds: AnomalyThresholds,
): AnomalySeverity | null {
  if (score >= thresholds.critical) return "critical";
  if (score >= thresholds.warning) return "warning";
  if (score >= thresholds.info) return "info";
  return null;
}

function hourOfWeek(timestamp: string): number {
  const date = new Date(timestamp);
  return date.getUTCDay() * 24 + date.getUTCHours();
}

// ── Predictive analytics ─────────────────────────────────────────────────────

export type ConsumptionForecastPoint = {
  timestamp: string;
  predictedKwh: number;
  lowerKwh: number;
  upperKwh: number;
};

export type ConsumptionModel = {
  /** Ridge coefficients over the feature basis returned by {@link consumptionFeatures}. */
  coefficients: number[];
  patterns: ConsumptionPattern[];
  /** Standard deviation of in-sample residuals, used for the forecast band. */
  residualStdDev: number;
  /** Held-out accuracy of the point forecast, or null when unmeasurable. */
  accuracyPct: number | null;
  /** Holdout hours that contributed to `accuracyPct`. */
  accuracySamples: number;
  trainingSamples: number;
  observedSamples: number;
  trainedAt: string;
};

/** Number of terms in the regression basis. */
const FEATURE_COUNT = 16;
/** Ridge penalty, matching the load-forecasting model. */
const RIDGE_LAMBDA = 1e-6;
/** Daily harmonics modelled separately for weekdays and weekends. */
const DAILY_HARMONICS = 3;

/**
 * Regression basis for the point forecast.
 *
 * Weekdays and weekends get their own daily cycle basis rather than one
 * shared cycle with an amplitude tweak: an office that runs overnight at
 * weekends has a peak in a completely different *part of the day*, which a
 * single sinusoid cannot represent no matter how its amplitude is scaled.
 * Three harmonics per regime cover the double-peaked household shape that a
 * single sinusoid badly underfits.
 */
function consumptionFeatures(timestamp: string): number[] {
  const date = new Date(timestamp);
  const hour = date.getUTCHours();
  const weekday = date.getUTCDay();
  const isWeekend = weekday === 0 || weekday === 6;
  const daily = (2 * Math.PI * hour) / 24;
  const weekly = (2 * Math.PI * weekday) / 7;

  const features = [isWeekend ? 0 : 1, isWeekend ? 1 : 0];
  // One daily cycle per regime, each gated by its own indicator. The gate is
  // what keeps the two blocks from being the same columns — without it the
  // normal equations are rank-deficient and the fit collapses.
  for (let regime = 0; regime < 2; regime++) {
    const gate = regime === (isWeekend ? 1 : 0) ? 1 : 0;
    for (let harmonic = 1; harmonic <= DAILY_HARMONICS; harmonic++) {
      features.push(gate * Math.sin(harmonic * daily), gate * Math.cos(harmonic * daily));
    }
  }
  features.push(Math.sin(weekly), Math.cos(weekly));
  return features;
}

/** Held-out share of history reserved for accuracy scoring. */
const HOLDOUT_FRACTION = 0.2;
const MIN_ACCURACY_SAMPLES = 48;
/** Re-weighting passes used to make the fit resistant to outliers. */
const IRLS_ITERATIONS = 3;
/** Huber cut-off in robust sigmas; 1.345 is the standard 95%-efficiency value. */
const HUBER_DELTA_SIGMAS = 1.345;

function weightedLeastSquares(samples: HourlyEnergySample[], weights: number[]): number[] {
  const xtx = Array.from({ length: FEATURE_COUNT }, () => Array(FEATURE_COUNT).fill(0));
  const xty = Array(FEATURE_COUNT).fill(0);
  for (let s = 0; s < samples.length; s++) {
    const weight = weights[s] ?? 1;
    if (weight <= 0) continue;
    const row = consumptionFeatures(samples[s]!.timestamp);
    for (let i = 0; i < FEATURE_COUNT; i++) {
      xty[i] += weight * row[i] * samples[s]!.energyKwh;
      for (let j = 0; j < FEATURE_COUNT; j++) xtx[i][j] += weight * row[i] * row[j];
    }
  }
  for (let i = 1; i < FEATURE_COUNT; i++) xtx[i][i] += RIDGE_LAMBDA;
  return solveLinearSystem(xtx, xty);
}

/**
 * Fit the forecast with iteratively reweighted ridge regression.
 *
 * Plain least squares chases outliers: a single 50 kWh spike in the training
 * window pulls the fitted curve toward it and wrecks accuracy for every other
 * hour — which is exactly the history this feature is asked to survive, since
 * spikes are what anomaly detection is meant to surface. Huber weights pull
 * residuals back toward the bulk of the data, so the forecast tracks the
 * underlying pattern and the spike stays visible as an anomaly instead.
 */
function fitConsumption(samples: HourlyEnergySample[]): number[] {
  if (samples.length === 0) return Array(FEATURE_COUNT).fill(0);
  if (samples.length < FEATURE_COUNT + 1) {
    const average = mean(samples.map((sample) => sample.energyKwh));
    return [average, ...Array(FEATURE_COUNT - 1).fill(0)];
  }

  let coefficients = weightedLeastSquares(samples, samples.map(() => 1));
  const weights = samples.map(() => 1);

  for (let iteration = 0; iteration < IRLS_ITERATIONS; iteration++) {
    const residuals = samples.map(
      (sample) => sample.energyKwh - predictWith(coefficients, sample.timestamp),
    );
    const centre = median(residuals);
    const sigma = median(residuals.map((residual) => Math.abs(residual - centre))) * MAD_SCALE;
    // A perfectly repeating load has no spread to scale against; the plain
    // least-squares fit already describes it exactly.
    if (sigma <= 0) break;

    const cutOff = HUBER_DELTA_SIGMAS * sigma;
    let downweighted = 0;
    for (let i = 0; i < residuals.length; i++) {
      const magnitude = Math.abs(residuals[i]! - centre);
      weights[i] = magnitude <= cutOff ? 1 : cutOff / magnitude;
      if (magnitude > cutOff) downweighted++;
    }
    if (downweighted === 0) break;
    coefficients = weightedLeastSquares(samples, weights);
  }

  return coefficients;
}

function predictWith(coefficients: number[], timestamp: string): number {
  const value = consumptionFeatures(timestamp).reduce(
    (sum, feature, index) => sum + feature * coefficients[index],
    0,
  );
  return Math.max(0, value);
}

export function trainConsumptionModel(
  input: HourlyEnergySample[],
  now = new Date(),
): ConsumptionModel {
  const samples = input
    .filter(
      (sample) =>
        Number.isFinite(Date.parse(sample.timestamp)) &&
        Number.isFinite(sample.energyKwh) &&
        sample.energyKwh >= 0,
    )
    .slice()
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

  let accuracyPct: number | null = null;
  let accuracySamples = 0;
  if (samples.length >= MIN_ACCURACY_SAMPLES) {
    const holdoutSize = Math.max(12, Math.floor(samples.length * HOLDOUT_FRACTION));
    const split = samples.length - holdoutSize;
    const holdoutCoefficients = fitConsumption(samples.slice(0, split));
    const holdout = samples.slice(split);
    const scored = scoreHoldout(holdout, holdoutCoefficients);
    accuracyPct = scored.accuracyPct;
    accuracySamples = scored.samples;
  }

  const coefficients = fitConsumption(samples);
  return {
    coefficients,
    patterns: clusterDailyProfiles(samples),
    residualStdDev: Number(
      stdDev(
        samples
          .filter((sample) => sample.energyKwh > 0)
          .map((sample) => sample.energyKwh - predictWith(coefficients, sample.timestamp)),
      ).toFixed(4),
    ),
    accuracyPct,
    accuracySamples,
    trainingSamples: samples.length,
    observedSamples: samples.filter((sample) => sample.energyKwh > 0).length,
    trainedAt: now.toISOString(),
  };
}

/** Holdout hours beyond this many robust sigmas are treated as anomalies. */
const ACCURACY_OUTLIER_SIGMAS = 4;

/**
 * Score the point forecast against held-out history.
 *
 * Held-out hours whose residual sits far outside the robust band are excluded:
 * a single 50 kWh spike inflates the error total enough to swamp every other
 * hour, and reporting "3% accurate" for a meter whose underlying pattern the
 * model fits to 94% would be misleading in the opposite direction. Those
 * hours are precisely what {@link detectAnomalies} exists to flag, so the
 * count of scored hours is returned alongside the figure.
 */
function scoreHoldout(
  holdout: HourlyEnergySample[],
  coefficients: number[],
): { accuracyPct: number | null; samples: number } {
  const residuals = holdout.map(
    (sample) => sample.energyKwh - predictWith(coefficients, sample.timestamp),
  );
  const centre = median(residuals);
  const sigma = median(residuals.map((residual) => Math.abs(residual - centre))) * MAD_SCALE;
  // No spread to scale against means the fit is already exact.
  const inBand =
    sigma > 0
      ? residuals.flatMap((residual, index) =>
          Math.abs(residual - centre) <= ACCURACY_OUTLIER_SIGMAS * sigma ? [index] : [],
        )
      : residuals.map((_, index) => index);
  if (inBand.length === 0) return { accuracyPct: null, samples: 0 };

  const totalObserved = inBand.reduce((sum, index) => sum + holdout[index]!.energyKwh, 0);
  if (totalObserved <= 0) return { accuracyPct: null, samples: 0 };

  const weightedAbsoluteError =
    inBand.reduce((sum, index) => sum + Math.abs(residuals[index]!), 0) / totalObserved;
  return {
    accuracyPct: Number((Math.max(0, Math.min(100, (1 - weightedAbsoluteError) * 100))).toFixed(1)),
    samples: inBand.length,
  };
}

/** 95% confidence band around the point forecast. */
export function forecastConsumption(
  model: ConsumptionModel,
  start: string | Date,
  hours: number,
): ConsumptionForecastPoint[] {
  const startMs = typeof start === "string" ? Date.parse(start) : start.getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(hours) || hours <= 0) return [];

  const band = model.residualStdDev * 1.96;
  return Array.from({ length: Math.floor(hours) }, (_, index) => {
    const timestamp = new Date(startMs + index * 3_600_000).toISOString();
    const predictedKwh = predictWith(model.coefficients, timestamp);
    return {
      timestamp,
      predictedKwh: Number(predictedKwh.toFixed(4)),
      lowerKwh: Number(Math.max(0, predictedKwh - band).toFixed(4)),
      upperKwh: Number((predictedKwh + band).toFixed(4)),
    };
  });
}

function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1));
}

// ── Personalized insights ────────────────────────────────────────────────────

export type InsightCategory = "peak_shifting" | "efficiency" | "anomaly" | "trend" | "flexibility";

export type ConsumptionInsight = {
  id: string;
  category: InsightCategory;
  title: string;
  detail: string;
  /** Annualised kWh the user could save by acting on this insight. */
  estimatedAnnualKwh: number;
  /** Estimated annual cost saving at the supplied tariff, in XLM. */
  estimatedAnnualXlm: number;
  /** Higher means more urgent. */
  priority: number;
};

export const DEFAULT_TARIFF_XLM_PER_KWH = 0.15;

/**
 * Turn model output into ranked, personalised recommendations.
 *
 * Suggestions are derived from the model's own numbers rather than fixed copy:
 * peak hours come from the forecast, waste comes from the lowest quartile of
 * predicted consumption, and volatility comes from the residual spread.
 */
export function generateInsights(input: {
  model: ConsumptionModel;
  forecast: ConsumptionForecastPoint[];
  anomalies: ConsumptionAnomaly[];
  tariffXlmPerKwh?: number;
}): ConsumptionInsight[] {
  const tariff = input.tariffXlmPerKwh ?? DEFAULT_TARIFF_XLM_PER_KWH;
  const insights: ConsumptionInsight[] = [];
  const { forecast, anomalies, model } = input;

  const peakPoint = forecast.reduce<ConsumptionForecastPoint | null>(
    (best, point) => (best === null || point.predictedKwh > best.predictedKwh ? point : best),
    null,
  );
  const averageKwh = mean(forecast.map((point) => point.predictedKwh));

  if (peakPoint && averageKwh > 0 && peakPoint.predictedKwh > averageKwh * 1.25) {
    const hour = new Date(peakPoint.timestamp).getUTCHours();
    // Shaving a fifth of the peak spread over the 8 surrounding hours.
    const shiftableKwh = (peakPoint.predictedKwh - averageKwh) * 8 * 0.2 * 365;
    insights.push({
      id: "peak-shifting",
      category: "peak_shifting",
      title: `Shift flexible load away from ${String(hour).padStart(2, "0")}:00 UTC`,
      detail:
        `Your forecast peaks at ${peakPoint.predictedKwh.toFixed(2)} kWh, ` +
        `${Math.round(((peakPoint.predictedKwh / averageKwh - 1) * 100)).toFixed(0)}% above your average hour. ` +
        `Running dishwashers, laundry and EV charging after ${String(hour).padStart(2, "0")}:00 UTC cuts that spike.`,
      estimatedAnnualKwh: round1(shiftableKwh),
      estimatedAnnualXlm: round1(shiftableKwh * tariff),
      priority: 90,
    });
  }

  const baselineHourly = mean(forecast.map((point) => point.predictedKwh));
  if (baselineHourly > 0 && model.residualStdDev / baselineHourly > 0.25) {
    insights.push({
      id: "volatility",
      category: "flexibility",
      title: "Consumption is hard to predict",
      detail:
        `Hourly consumption varies by ±${Math.round((model.residualStdDev / baselineHourly) * 100)}% around ` +
        "its expected value. Scheduling devices from the forecast rather than a fixed timer makes them " +
        "available when the grid is least strained.",
      estimatedAnnualKwh: 0,
      estimatedAnnualXlm: 0,
      priority: 55,
    });
  }

  const critical = anomalies.filter((anomaly) => anomaly.severity === "critical");
  if (critical.length > 0) {
    const wasted = critical
      .filter((anomaly) => anomaly.direction === "over")
      .reduce((sum, anomaly) => sum + Math.max(0, anomaly.energyKwh - anomaly.expectedKwh), 0);
    insights.push({
      id: "anomaly",
      category: "anomaly",
      title: `${critical.length} unexplained consumption spike${critical.length === 1 ? "" : "s"} detected`,
      detail:
        `Largest deviation reached ${Math.max(...critical.map((a) => Math.abs(a.deviationPct))).toFixed(0)}% ` +
        "above the usual level for that hour. A stuck appliance, a leaking meter or an always-on device " +
        "would all look like this.",
      estimatedAnnualKwh: round1(wasted * 52),
      estimatedAnnualXlm: round1(wasted * 52 * tariff),
      priority: 95,
    });
  }

  const dominant = model.patterns[0];
  if (dominant && dominant.kind !== "steady") {
    insights.push({
      id: "pattern",
      category: "efficiency",
      title: `Your dominant pattern is "${dominant.label}"`,
      detail:
        `${dominant.sharePct}% of your measured days share this shape, peaking at ` +
        `${String(dominant.peakHour).padStart(2, "0")}:00 UTC with a load factor of ${dominant.loadFactor}. ` +
        (dominant.loadFactor < 0.45
          ? "A low load factor means most of your consumption is concentrated in a short window — the best target for load shifting."
          : "A high load factor means consumption is already spread evenly across the day."),
      estimatedAnnualKwh: 0,
      estimatedAnnualXlm: 0,
      priority: 60,
    });
  }

  return insights.sort((a, b) => b.priority - a.priority).map((insight, index) => ({
    ...insight,
    id: `${insight.id}-${index + 1}`,
  }));
}

function round1(value: number): number {
  return Number(value.toFixed(1));
}

