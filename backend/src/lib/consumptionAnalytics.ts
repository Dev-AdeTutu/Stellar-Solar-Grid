/**
 * Energy consumption pattern analysis (#928).
 *
 * Ties the pure model in `consumptionPatternsModel.ts` to platform data:
 *  - pulls the hourly usage history for a meter,
 *  - caches the trained model per meter so a dashboard poll does not retrain,
 *  - records anomalies that were actually flagged, so a device owner can be
 *    told about the same spike exactly once,
 *  - produces the weekly insights report.
 *
 * Anomalies and weekly reports are persisted (SQLite, `SqlitePool`) because
 * they are history: the weekly report must be reproducible and an alert must
 * not fire twice.
 */

import path from "node:path";
import type Database from "better-sqlite3";
import { registerDatabase } from "./databaseLifecycle.js";
import { getHourlyUsage, getMeterUsageStats } from "./usageEvents.js";
import { logger } from "./logger.js";
import { SqlitePool, type SqlitePoolStatus } from "./sqlitePool.js";
import {
  DEFAULT_TARIFF_XLM_PER_KWH,
  clusterDailyProfiles,
  detectAnomalies,
  forecastConsumption,
  generateInsights,
  trainConsumptionModel,
  type AnomalyReport,
  type ConsumptionAnomaly,
  type ConsumptionInsight,
  type ConsumptionModel,
  type ConsumptionPattern,
  type HourlyEnergySample,
} from "./consumptionPatternsModel.js";

/** Days of history used to train the per-meter model. */
export const PATTERN_TRAINING_WINDOW_DAYS = 90;
/** How long a trained model stays warm before it is retrained. */
export const PATTERN_MODEL_TTL_MS = Number(process.env.CONSUMPTION_MODEL_TTL_MS ?? 6 * 60 * 60 * 1000);
/** Forecast horizon returned by the analytics endpoints. */
export const DEFAULT_FORECAST_HOURS = 168;

const DB_PATH = process.env.CONSUMPTION_ANALYTICS_DB_PATH ?? path.resolve(process.cwd(), "data", "consumption-analytics.sqlite");

const pool = new SqlitePool({
  filename: DB_PATH,
  min: Number(process.env.CONSUMPTION_ANALYTICS_POOL_MIN ?? 2),
  max: Number(process.env.CONSUMPTION_ANALYTICS_POOL_MAX ?? 10),
  idleTimeout: Number(process.env.SQLITE_POOL_IDLE_TIMEOUT_MS ?? 30_000),
  acquireTimeout: Number(process.env.SQLITE_POOL_ACQUIRE_TIMEOUT_MS ?? 10_000),
  onOpen: applyConsumptionAnalyticsSchema,
});

function applyConsumptionAnalyticsSchema(database: Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS consumption_anomalies (
      id TEXT PRIMARY KEY,
      meter_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      hour INTEGER NOT NULL,
      weekday INTEGER NOT NULL,
      energy_kwh REAL NOT NULL,
      expected_kwh REAL NOT NULL,
      deviation_pct REAL NOT NULL,
      score REAL NOT NULL,
      severity TEXT NOT NULL,
      direction TEXT NOT NULL,
      description TEXT NOT NULL,
      acknowledged INTEGER NOT NULL DEFAULT 0,
      detected_at TEXT NOT NULL,
      UNIQUE (meter_id, timestamp)
    );

    CREATE INDEX IF NOT EXISTS idx_consumption_anomalies_meter_time
      ON consumption_anomalies (meter_id, timestamp DESC);

    CREATE INDEX IF NOT EXISTS idx_consumption_anomalies_severity
      ON consumption_anomalies (severity);

    CREATE TABLE IF NOT EXISTS consumption_weekly_reports (
      id TEXT PRIMARY KEY,
      meter_id TEXT NOT NULL,
      week_start TEXT NOT NULL,
      week_end TEXT NOT NULL,
      total_kwh REAL NOT NULL,
      predicted_kwh REAL NOT NULL,
      forecast_accuracy_pct REAL,
      anomaly_count INTEGER NOT NULL,
      top_pattern TEXT,
      insights TEXT NOT NULL,
      generated_at TEXT NOT NULL,
      UNIQUE (meter_id, week_start)
    );

    CREATE INDEX IF NOT EXISTS idx_consumption_weekly_reports_meter
      ON consumption_weekly_reports (meter_id, week_start DESC);

    CREATE TABLE IF NOT EXISTS appliance_usage (
      id TEXT PRIMARY KEY,
      meter_id TEXT NOT NULL,
      appliance_id TEXT NOT NULL,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      energy_kwh REAL NOT NULL,
      cost_stroops INTEGER NOT NULL,
      UNIQUE (meter_id, appliance_id, period_start, period_end)
    );

    CREATE INDEX IF NOT EXISTS idx_appliance_usage_meter_period
      ON appliance_usage (meter_id, period_start DESC);

    CREATE INDEX IF NOT EXISTS idx_appliance_usage_appliance
      ON appliance_usage (meter_id, appliance_id, period_start DESC);
  `);
}

registerDatabase("consumption-analytics", () => {
  pool.drain();
});
pool.warm();

// ── Model cache ──────────────────────────────────────────────────────────────

type CachedModel = { model: ConsumptionModel; trainedAtMs: number };
const models = new Map<string, CachedModel>();

function loadSamples(meterId: string, days: number, now: Date): HourlyEnergySample[] {
  return trimLeadingIdleHours(getHourlyUsage(meterId, days, now));
}

/**
 * Drop the zero-filled head of a densified window.
 *
 * `getHourlyUsage` fills every hour between the cutoff and now, including
 * hours before the meter ever reported. Those leading zeros are an artefact
 * of the query window, not consumption, and training on them teaches the
 * model that the site is idle half the time — which drags forecast accuracy
 * down to a fraction of its true value. Genuine zero-consumption hours
 * *within* the reported range are real data and are kept.
 */
function trimLeadingIdleHours(samples: HourlyEnergySample[]): HourlyEnergySample[] {
  const firstActive = samples.findIndex((sample) => sample.energyKwh > 0);
  return firstActive === -1 ? [] : samples.slice(firstActive);
}

/** Return the meter model, training it if the cached copy has gone stale. */
export function getConsumptionModel(
  meterId: string,
  options: { days?: number; now?: Date } = {},
): ConsumptionModel {
  const now = options.now ?? new Date();
  const days = options.days ?? PATTERN_TRAINING_WINDOW_DAYS;
  const cached = models.get(meterId);
  if (cached && now.getTime() - cached.trainedAtMs < PATTERN_MODEL_TTL_MS) {
    return cached.model;
  }
  const model = trainConsumptionModel(loadSamples(meterId, days, now), now);
  models.set(meterId, { model, trainedAtMs: now.getTime() });
  return model;
}

/** Force-retrain every meter the usage store knows about. */
export function retrainAllConsumptionModels(now = new Date()): { meters: number } {
  let meters = 0;
  for (const { meter_id: meterId } of getMeterUsageStats().slice(0, 500)) {
    try {
      getConsumptionModel(meterId, { now });
      meters++;
    } catch (err) {
      logger.warn({ err, meterId }, "Consumption model retraining failed");
    }
  }
  logger.info({ meters }, "Consumption pattern models retrained");
  return { meters };
}

export function clearConsumptionModelsForTests(): void {
  models.clear();
}

// ── Analysis ─────────────────────────────────────────────────────────────────

export type ConsumptionAnalysis = {
  meterId: string;
  generatedAt: string;
  windowDays: number;
  observedHours: number;
  totalKwh: number;
  averageHourlyKwh: number;
  peakHourlyKwh: number;
  peakHour: number | null;
  /** Held-out forecast accuracy; null when history is too short to measure. */
  accuracyPct: number | null;
  sufficientData: boolean;
  patterns: ConsumptionPattern[];
  anomalySummary: {
    total: number;
    critical: number;
    warning: number;
    info: number;
    sufficientData: boolean;
  };
  forecast: ReturnType<typeof forecastConsumption>;
  insights: ConsumptionInsight[];
};

export type AnalyzeOptions = {
  days?: number;
  forecastHours?: number;
  tariffXlmPerKwh?: number;
  now?: Date;
  /** Skip writing flagged anomalies — used when scanning is read-only. */
  persistAnomalies?: boolean;
};

/**
 * Run the full analysis for a meter: patterns, anomalies, forecast, insights.
 * Anomalies found in the scan are recorded so they can be acknowledged and
 * never re-alert on.
 */
export function analyzeConsumption(meterId: string, options: AnalyzeOptions = {}): ConsumptionAnalysis {
  const now = options.now ?? new Date();
  const days = options.days ?? PATTERN_TRAINING_WINDOW_DAYS;
  const forecastHours = options.forecastHours ?? DEFAULT_FORECAST_HOURS;
  const model = getConsumptionModel(meterId, { days, now });
  const samples = loadSamples(meterId, days, now);

  const report = detectAnomalies(samples);
  if (options.persistAnomalies !== false && report.anomalies.length > 0) {
    recordAnomalies(meterId, report.anomalies);
  }

  const start = new Date(now);
  start.setUTCMinutes(0, 0, 0);
  start.setUTCHours(start.getUTCHours() + 1);
  const forecast = forecastConsumption(model, start, forecastHours);
  const insights = generateInsights({
    model,
    forecast,
    anomalies: report.anomalies,
    tariffXlmPerKwh: options.tariffXlmPerKwh ?? DEFAULT_TARIFF_XLM_PER_KWH,
  });

  const totalKwh = samples.reduce((sum, sample) => sum + sample.energyKwh, 0);
  const peakSample = samples.reduce<HourlyEnergySample | null>(
    (best, sample) => (best === null || sample.energyKwh > best.energyKwh ? sample : best),
    null,
  );

  return {
    meterId,
    generatedAt: now.toISOString(),
    windowDays: days,
    observedHours: samples.length,
    totalKwh: Number(totalKwh.toFixed(2)),
    averageHourlyKwh: samples.length === 0 ? 0 : Number((totalKwh / samples.length).toFixed(4)),
    peakHourlyKwh: peakSample ? Number(peakSample.energyKwh.toFixed(4)) : 0,
    peakHour: peakSample ? new Date(peakSample.timestamp).getUTCHours() : null,
    accuracyPct: model.accuracyPct,
    sufficientData: report.sufficientData,
    patterns: model.patterns,
    anomalySummary: {
      total: report.anomalies.length,
      critical: report.anomalies.filter((a) => a.severity === "critical").length,
      warning: report.anomalies.filter((a) => a.severity === "warning").length,
      info: report.anomalies.filter((a) => a.severity === "info").length,
      sufficientData: report.sufficientData,
    },
    forecast,
    insights,
  };
}

/** Trend series for the visualisation endpoints: actuals plus forecast. */
export function getTrendSeries(
  meterId: string,
  options: { days?: number; forecastHours?: number; now?: Date } = {},
): { actual: Array<{ timestamp: string; energyKwh: number }>; forecast: ConsumptionAnalysis["forecast"] } {
  const now = options.now ?? new Date();
  const days = options.days ?? PATTERN_TRAINING_WINDOW_DAYS;
  const samples = loadSamples(meterId, days, now);
  return {
    actual: samples.map((sample) => ({ timestamp: sample.timestamp, energyKwh: sample.energyKwh })),
    forecast: analyzeConsumption(meterId, {
      ...options,
      days,
      now,
      persistAnomalies: false,
    }).forecast,
  };
}

// ── Anomaly persistence ──────────────────────────────────────────────────────

type AnomalyRow = {
  id: string;
  meter_id: string;
  timestamp: string;
  hour: number;
  weekday: number;
  energy_kwh: number;
  expected_kwh: number;
  deviation_pct: number;
  score: number;
  severity: string;
  direction: string;
  description: string;
  acknowledged: number;
  detected_at: string;
};

export type FlaggedAnomaly = ConsumptionAnomaly & {
  id: string;
  meterId: string;
  acknowledged: boolean;
  detectedAt: string;
};

/** Insert newly detected anomalies. Re-running the scan is idempotent. */
export function recordAnomalies(meterId: string, anomalies: ConsumptionAnomaly[]): number {
  if (anomalies.length === 0) return 0;
  const detectedAt = new Date().toISOString();
  return pool.withConnection((database) => {
    const statement = database.prepare(`
      INSERT OR IGNORE INTO consumption_anomalies
        (id, meter_id, timestamp, hour, weekday, energy_kwh, expected_kwh, deviation_pct,
         score, severity, direction, description, acknowledged, detected_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `);
    let inserted = 0;
    for (const anomaly of anomalies) {
      const result = statement.run(
        `${meterId}:${anomaly.timestamp}`,
        meterId,
        anomaly.timestamp,
        anomaly.hour,
        anomaly.weekday,
        anomaly.energyKwh,
        anomaly.expectedKwh,
        anomaly.deviationPct,
        anomaly.score,
        anomaly.severity,
        anomaly.direction,
        anomaly.description,
        detectedAt,
      );
      inserted += result.changes;
    }
    return inserted;
  });
}

function toFlaggedAnomaly(row: AnomalyRow): FlaggedAnomaly {
  return {
    id: row.id,
    meterId: row.meter_id,
    timestamp: row.timestamp,
    hour: row.hour,
    weekday: row.weekday,
    energyKwh: row.energy_kwh,
    expectedKwh: row.expected_kwh,
    deviationPct: row.deviation_pct,
    score: row.score,
    severity: row.severity as ConsumptionAnomaly["severity"],
    direction: row.direction as ConsumptionAnomaly["direction"],
    description: row.description,
    acknowledged: row.acknowledged === 1,
    detectedAt: row.detected_at,
  };
}

export function listFlaggedAnomalies(
  meterId: string,
  options: { limit?: number; severity?: string; includeAcknowledged?: boolean } = {},
): FlaggedAnomaly[] {
  const limit = Math.min(500, Math.max(1, Number(options.limit ?? 100)));
  const filters = ["meter_id = ?"];
  const params: Array<string | number> = [meterId];
  if (options.severity) {
    filters.push("severity = ?");
    params.push(options.severity);
  }
  if (options.includeAcknowledged !== true) filters.push("acknowledged = 0");

  return pool
    .primaryDb()
    .prepare(
      `SELECT * FROM consumption_anomalies WHERE ${filters.join(" AND ")}
       ORDER BY timestamp DESC LIMIT ?`,
    )
    .all(...params, limit)
    .map((row) => toFlaggedAnomaly(row as AnomalyRow));
}

export function acknowledgeAnomaly(anomalyId: string): FlaggedAnomaly | undefined {
  const result = pool
    .primaryDb()
    .prepare("UPDATE consumption_anomalies SET acknowledged = 1 WHERE id = ?")
    .run(anomalyId);
  if (result.changes === 0) return undefined;
  const row = pool
    .primaryDb()
    .prepare("SELECT * FROM consumption_anomalies WHERE id = ?")
    .get(anomalyId) as AnomalyRow | undefined;
  return row ? toFlaggedAnomaly(row) : undefined;
}

// ── Weekly insights report ───────────────────────────────────────────────────

export type WeeklyInsightsReport = {
  id: string;
  meterId: string;
  weekStart: string;
  weekEnd: string;
  totalKwh: number;
  predictedKwh: number;
  forecastAccuracyPct: number | null;
  anomalyCount: number;
  topPattern: string | null;
  insights: ConsumptionInsight[];
  generatedAt: string;
};

/** Monday 00:00 UTC of the week containing `now`. */
function weekStartOf(now: Date): Date {
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  const weekday = (start.getUTCDay() + 6) % 7;
  start.setUTCDate(start.getUTCDate() - weekday);
  return start;
}

export function generateWeeklyInsightsReport(
  meterId: string,
  options: { now?: Date; tariffXlmPerKwh?: number } = {},
): WeeklyInsightsReport {
  const now = options.now ?? new Date();
  const weekStart = weekStartOf(now);
  const weekEnd = new Date(weekStart.getTime() + 7 * 86_400_000);
  const samples = loadSamples(meterId, PATTERN_TRAINING_WINDOW_DAYS, now).filter(
    (sample) => Date.parse(sample.timestamp) >= weekStart.getTime(),
  );

  const analysis = analyzeConsumption(meterId, {
    now,
    tariffXlmPerKwh: options.tariffXlmPerKwh,
    persistAnomalies: false,
  });

  const predictedKwh = analysis.forecast
    .filter((point) => {
      const at = Date.parse(point.timestamp);
      return at >= weekStart.getTime() && at < weekEnd.getTime();
    })
    .reduce((sum, point) => sum + point.predictedKwh, 0);

  const totalKwh = samples.reduce((sum, sample) => sum + sample.energyKwh, 0);
  const report: WeeklyInsightsReport = {
    id: `${meterId}:${weekStart.toISOString().slice(0, 10)}`,
    meterId,
    weekStart: weekStart.toISOString(),
    weekEnd: weekEnd.toISOString(),
    totalKwh: Number(totalKwh.toFixed(2)),
    predictedKwh: Number(predictedKwh.toFixed(2)),
    forecastAccuracyPct: analysis.accuracyPct,
    anomalyCount: analysis.anomalySummary.total,
    topPattern: analysis.patterns[0]?.label ?? null,
    insights: analysis.insights,
    generatedAt: now.toISOString(),
  };

  pool.primaryDb()
    .prepare(`
      INSERT INTO consumption_weekly_reports
        (id, meter_id, week_start, week_end, total_kwh, predicted_kwh,
         forecast_accuracy_pct, anomaly_count, top_pattern, insights, generated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(meter_id, week_start) DO UPDATE SET
        week_end = excluded.week_end,
        total_kwh = excluded.total_kwh,
        predicted_kwh = excluded.predicted_kwh,
        forecast_accuracy_pct = excluded.forecast_accuracy_pct,
        anomaly_count = excluded.anomaly_count,
        top_pattern = excluded.top_pattern,
        insights = excluded.insights,
        generated_at = excluded.generated_at
    `)
    .run(
      report.id,
      report.meterId,
      report.weekStart,
      report.weekEnd,
      report.totalKwh,
      report.predictedKwh,
      report.forecastAccuracyPct,
      report.anomalyCount,
      report.topPattern,
      JSON.stringify(report.insights),
      report.generatedAt,
    );

  return report;
}

type WeeklyReportRow = {
  id: string;
  meter_id: string;
  week_start: string;
  week_end: string;
  total_kwh: number;
  predicted_kwh: number;
  forecast_accuracy_pct: number | null;
  anomaly_count: number;
  top_pattern: string | null;
  insights: string;
  generated_at: string;
};

export function listWeeklyReports(meterId: string, limit = 12): WeeklyInsightsReport[] {
  return pool
    .primaryDb()
    .prepare(
      `SELECT * FROM consumption_weekly_reports WHERE meter_id = ?
       ORDER BY week_start DESC LIMIT ?`,
    )
    .all(meterId, Math.min(52, Math.max(1, limit)))
    .map((row) => {
      const record = row as WeeklyReportRow;
      return {
        id: record.id,
        meterId: record.meter_id,
        weekStart: record.week_start,
        weekEnd: record.week_end,
        totalKwh: record.total_kwh,
        predictedKwh: record.predicted_kwh,
        forecastAccuracyPct: record.forecast_accuracy_pct,
        anomalyCount: record.anomaly_count,
        topPattern: record.top_pattern,
        insights: JSON.parse(record.insights) as ConsumptionInsight[],
        generatedAt: record.generated_at,
      };
    });
}

/** Generate a weekly report for every meter with recorded usage. */
export function generateAllWeeklyReports(now = new Date()): { reports: number } {
  let reports = 0;
  for (const { meter_id: meterId } of getMeterUsageStats().slice(0, 500)) {
    try {
      generateWeeklyInsightsReport(meterId, { now });
      reports++;
    } catch (err) {
      logger.warn({ err, meterId }, "Weekly consumption insights report failed");
    }
  }
  return { reports };
}

// ── Appliance disaggregation ─────────────────────────────────────────────────

/** Appliance categories the disaggregator can attribute load to. */
export type ApplianceCategory =
  | "refrigeration"
  | "hvac"
  | "water_heating"
  | "lighting"
  | "ev_charging"
  | "other";

export type ApplianceBreakdownEntry = {
  applianceId: string;
  name: string;
  category: ApplianceCategory;
  energyKwh: number;
  costStroops: number;
  sharePct: number;
  /** Change vs the previous equal-length period, null when no baseline. */
  trendPct: number | null;
  trendDirection: "up" | "down" | "flat";
  recommendation: string;
};

export type ApplianceBreakdown = {
  meterId: string;
  generatedAt: string;
  periodStart: string;
  periodEnd: string;
  windowDays: number;
  totalKwh: number;
  totalCostStroops: number;
  appliances: ApplianceBreakdownEntry[];
  sufficientData: boolean;
};

export type DisaggregateOptions = {
  days?: number;
  now?: Date;
  tariffXlmPerKwh?: number;
  /** Skip writing the computed breakdown to SQLite. */
  persist?: boolean;
};

/** Human-readable names per category, used for the default appliance label. */
const APPLIANCE_NAMES: Record<ApplianceCategory, string> = {
  refrigeration: "Refrigeration",
  hvac: "HVAC",
  water_heating: "Water heating",
  lighting: "Lighting",
  ev_charging: "EV charging",
  other: "Other loads",
};

const STROOPS_PER_XLM = 10_000_000;

function toStroops(energyKwh: number, tariffXlmPerKwh: number): number {
  return Math.round(energyKwh * tariffXlmPerKwh * STROOPS_PER_XLM);
}

/**
 * Classify a cluster of hourly samples into an appliance category from the
 * shape of its daily profile.
 *
 * The heuristics mirror how these loads actually behave on a meter:
 *  - a flat, always-on baseload with a low coefficient of variation is
 *    refrigeration (compressors cycling around a setpoint),
 *  - a strong morning/evening double peak is HVAC (thermostat schedules),
 *  - a concentrated early-morning block is water heating (timed tanks),
 *  - a sharp evening block is lighting,
 *  - a large, sustained overnight block is EV charging,
 *  - anything else falls through to "other".
 */
function classifyCluster(samples: HourlyEnergySample[]): ApplianceCategory {
  if (samples.length === 0) return "other";
  const mean = samples.reduce((sum, s) => sum + s.energyKwh, 0) / samples.length;
  if (mean <= 0) return "other";

  const variance = samples.reduce((sum, s) => sum + (s.energyKwh - mean) ** 2, 0) / samples.length;
  const coefficientOfVariation = Math.sqrt(variance) / mean;

  const byHour = new Array<number>(24).fill(0);
  for (const sample of samples) {
    byHour[new Date(sample.timestamp).getUTCHours()] += sample.energyKwh;
  }
  const total = byHour.reduce((sum, v) => sum + v, 0);
  if (total <= 0) return "other";
  const share = byHour.map((v) => v / total);

  const sumRange = (from: number, to: number) => {
    let acc = 0;
    for (let hour = from; hour <= to; hour++) acc += share[hour];
    return acc;
  };

  const morning = sumRange(6, 9);
  const evening = sumRange(17, 21);
  const overnight = sumRange(0, 5) + sumRange(22, 23);
  const earlyMorning = sumRange(4, 7);

  // Steady baseload: low variation and load spread across the whole day.
  if (coefficientOfVariation < 0.35 && overnight < 0.45) return "refrigeration";
  // Large sustained overnight block: EV charging.
  if (overnight >= 0.45 && morning < 0.2) return "ev_charging";
  // Double peak (morning + evening): HVAC.
  if (morning >= 0.2 && evening >= 0.2) return "hvac";
  // Concentrated early-morning block: water heating.
  if (earlyMorning >= 0.35) return "water_heating";
  // Sharp evening block: lighting.
  if (evening >= 0.35) return "lighting";
  return "other";
}

function recommendationFor(category: ApplianceCategory, trendPct: number | null): string {
  const rising = trendPct !== null && trendPct > 10;
  switch (category) {
    case "refrigeration":
      return rising
        ? "Refrigeration use is climbing — check door seals and condenser coils, and confirm the thermostat setpoint."
        : "Keep refrigerator coils clean and leave clearance around the unit to hold this steady baseload down.";
    case "hvac":
      return rising
        ? "HVAC load is up — review the schedule and filter condition, and consider a smart thermostat setback."
        : "Shift HVAC pre-cooling to off-peak hours and seal draughts to trim this load further.";
    case "water_heating":
      return rising
        ? "Water heating is trending up — insulate the tank and pipes, and lower the setpoint a few degrees."
        : "Schedule water heating for off-peak hours and insulate the tank to cut standby losses.";
    case "lighting":
      return rising
        ? "Lighting use increased — check for lights left on and replace remaining fixtures with LEDs."
        : "Add occupancy sensors and timers so lighting only runs when the space is in use.";
    case "ev_charging":
      return rising
        ? "EV charging is growing — move charging sessions to off-peak windows to cut cost."
        : "Keep EV charging in the off-peak window and cap the charge rate to avoid demand spikes.";
    default:
      return "Review always-on loads in this band and switch idle devices off at the plug.";
  }
}

type ApplianceUsageRow = {
  id: string;
  meter_id: string;
  appliance_id: string;
  name: string;
  category: string;
  period_start: string;
  period_end: string;
  energy_kwh: number;
  cost_stroops: number;
};

function persistApplianceUsage(
  meterId: string,
  periodStart: string,
  periodEnd: string,
  entries: Array<{ applianceId: string; name: string; category: ApplianceCategory; energyKwh: number; costStroops: number }>,
): void {
  if (entries.length === 0) return;
  pool.withConnection((database) => {
    const statement = database.prepare(`
      INSERT INTO appliance_usage
        (id, meter_id, appliance_id, name, category, period_start, period_end, energy_kwh, cost_stroops)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(meter_id, appliance_id, period_start, period_end) DO UPDATE SET
        name = excluded.name,
        category = excluded.category,
        energy_kwh = excluded.energy_kwh,
        cost_stroops = excluded.cost_stroops
    `);
    for (const entry of entries) {
      statement.run(
        `${meterId}:${entry.applianceId}:${periodStart}`,
        meterId,
        entry.applianceId,
        entry.name,
        entry.category,
        periodStart,
        periodEnd,
        entry.energyKwh,
        entry.costStroops,
      );
    }
  });
}

function loadStoredApplianceUsage(
  meterId: string,
  periodStart: string,
  periodEnd: string,
): Map<string, { energyKwh: number; costStroops: number; name: string; category: ApplianceCategory }> {
  const rows = pool
    .primaryDb()
    .prepare(
      `SELECT * FROM appliance_usage
       WHERE meter_id = ? AND period_start = ? AND period_end = ?`,
    )
    .all(meterId, periodStart, periodEnd) as ApplianceUsageRow[];
  const map = new Map<string, { energyKwh: number; costStroops: number; name: string; category: ApplianceCategory }>();
  for (const row of rows) {
    map.set(row.appliance_id, {
      energyKwh: row.energy_kwh,
      costStroops: row.cost_stroops,
      name: row.name,
      category: row.category as ApplianceCategory,
    });
  }
  return map;
}

/**
 * Disaggregate a meter's hourly usage into per-appliance consumption.
 *
 * The hourly series is clustered with the same daily-profile clustering used
 * for pattern detection; each cluster is then classified into an appliance
 * category from its daily shape. Results are persisted per period so trends
 * can be computed against the previous equal-length window.
 */
export function disaggregateAppliances(
  meterId: string,
  options: DisaggregateOptions = {},
): ApplianceBreakdown {
  const now = options.now ?? new Date();
  const days = options.days ?? 30;
  const tariff = options.tariffXlmPerKwh ?? DEFAULT_TARIFF_XLM_PER_KWH;

  const periodEnd = new Date(now);
  periodEnd.setUTCMinutes(0, 0, 0);
  const periodStart = new Date(periodEnd.getTime() - days * 86_400_000);
  const previousStart = new Date(periodStart.getTime() - days * 86_400_000);

  const samples = loadSamples(meterId, days, now);
  const previousSamples = loadSamples(meterId, days * 2, now).filter(
    (sample) => Date.parse(sample.timestamp) < periodStart.getTime(),
  );

  const clusters = clusterDailyProfiles(samples);
  const previousClusters = clusterDailyProfiles(previousSamples);

  const previousByCategory = new Map<ApplianceCategory, number>();
  for (const cluster of previousClusters) {
    const category = classifyCluster(cluster.samples);
    previousByCategory.set(category, (previousByCategory.get(category) ?? 0) + cluster.totalKwh);
  }

  const aggregated = new Map<ApplianceCategory, number>();
  for (const cluster of clusters) {
    const category = classifyCluster(cluster.samples);
    aggregated.set(category, (aggregated.get(category) ?? 0) + cluster.totalKwh);
  }

  const totalKwh = [...aggregated.values()].reduce((sum, v) => sum + v, 0);
  const periodStartIso = periodStart.toISOString();
  const periodEndIso = periodEnd.toISOString();

  const entries: ApplianceBreakdownEntry[] = [...aggregated.entries()]
    .filter(([, energyKwh]) => energyKwh > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([category, energyKwh]) => {
      const previousKwh = previousByCategory.get(category) ?? 0;
      const trendPct =
        previousKwh > 0 ? Number((((energyKwh - previousKwh) / previousKwh) * 100).toFixed(1)) : null;
      const trendDirection: ApplianceBreakdownEntry["trendDirection"] =
        trendPct === null || Math.abs(trendPct) < 5 ? "flat" : trendPct > 0 ? "up" : "down";
      return {
        applianceId: category,
        name: APPLIANCE_NAMES[category],
        category,
        energyKwh: Number(energyKwh.toFixed(3)),
        costStroops: toStroops(energyKwh, tariff),
        sharePct: totalKwh > 0 ? Number(((energyKwh / totalKwh) * 100).toFixed(1)) : 0,
        trendPct,
        trendDirection,
        recommendation: recommendationFor(category, trendPct),
      };
    });

  if (options.persist !== false && entries.length > 0) {
    persistApplianceUsage(meterId, periodStartIso, periodEndIso, entries);
  }

  return {
    meterId,
    generatedAt: now.toISOString(),
    periodStart: periodStartIso,
    periodEnd: periodEndIso,
    windowDays: days,
    totalKwh: Number(totalKwh.toFixed(3)),
    totalCostStroops: entries.reduce((sum, entry) => sum + entry.costStroops, 0),
    appliances: entries,
    sufficientData: samples.length >= 24,
  };
}

export type ApplianceTrendPoint = {
  periodStart: string;
  periodEnd: string;
  energyKwh: number;
  costStroops: number;
};

export type ApplianceTrend = {
  meterId: string;
  applianceId: string;
  name: string | null;
  category: ApplianceCategory | null;
  days: number;
  points: ApplianceTrendPoint[];
  totalKwh: number;
  averageKwh: number;
  trendPct: number | null;
  trendDirection: "up" | "down" | "flat";
};

/**
 * Stored usage history for a single appliance, oldest first, with the change
 * between the most recent period and the one before it.
 */
export function getApplianceTrends(meterId: string, applianceId: string, days = 30): ApplianceTrend {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const rows = pool
    .primaryDb()
    .prepare(
      `SELECT * FROM appliance_usage
       WHERE meter_id = ? AND appliance_id = ? AND period_start >= ?
       ORDER BY period_start ASC`,
    )
    .all(meterId, applianceId, since) as ApplianceUsageRow[];

  const points: ApplianceTrendPoint[] = rows.map((row) => ({
    periodStart: row.period_start,
    periodEnd: row.period_end,
    energyKwh: row.energy_kwh,
    costStroops: row.cost_stroops,
  }));

  const totalKwh = points.reduce((sum, point) => sum + point.energyKwh, 0);
  const latest = points.at(-1);
  const previous = points.at(-2);
  const trendPct =
    latest && previous && previous.energyKwh > 0
      ? Number((((latest.energyKwh - previous.energyKwh) / previous.energyKwh) * 100).toFixed(1))
      : null;
  const trendDirection: ApplianceTrend["trendDirection"] =
    trendPct === null || Math.abs(trendPct) < 5 ? "flat" : trendPct > 0 ? "up" : "down";

  return {
    meterId,
    applianceId,
    name: rows[0]?.name ?? null,
    category: (rows[0]?.category as ApplianceCategory | undefined) ?? null,
    days,
    points,
    totalKwh: Number(totalKwh.toFixed(3)),
    averageKwh: points.length === 0 ? 0 : Number((totalKwh / points.length).toFixed(3)),
    trendPct,
    trendDirection,
  };
}

/** Read back the stored breakdown for a period without recomputing it. */
export function getStoredApplianceBreakdown(
  meterId: string,
  periodStart: string,
  periodEnd: string,
): Array<{ applianceId: string; name: string; category: ApplianceCategory; energyKwh: number; costStroops: number }> {
  return [...loadStoredApplianceUsage(meterId, periodStart, periodEnd).entries()].map(([applianceId, value]) => ({
    applianceId,
    name: value.name,
    category: value.category,
    energyKwh: value.energyKwh,
    costStroops: value.costStroops,
  }));
}

export function getConsumptionAnalyticsPoolStatus(): SqlitePoolStatus {
  return pool.status();
}

export { clusterDailyProfiles };
export type { AnomalyReport, ConsumptionAnomaly, ConsumptionInsight, ConsumptionModel, ConsumptionPattern };
