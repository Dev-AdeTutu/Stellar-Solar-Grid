/**
 * Energy consumption pattern analysis (#928).
 *
 * Covers the model's pattern recognition, anomaly detection and forecasting,
 * the persistence layer (flagged anomalies + weekly reports) and the HTTP API.
 */
import { createServer, type Server } from "node:http";
import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";

// Static imports are hoisted above plain statements, so the DB paths must be
// assigned inside vi.hoisted() or the libs would fall back to their default
// (real) on-disk paths. File-backed rather than ":memory:" because SqlitePool
// keeps a separate primary handle and pooled connections, and each ":memory:"
// connection would otherwise be a different database.
const { tmpDir } = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR ?? "/tmp"}/consumption-analytics-${process.pid}-${Date.now()}`;
  process.env.USAGE_EVENTS_DB_PATH = `${dir}/usage-events.sqlite`;
  process.env.CONSUMPTION_ANALYTICS_DB_PATH = `${dir}/consumption-analytics.sqlite`;
  return { tmpDir: dir };
});

// usageEvents.ts imports adminInvoke from stellar.ts, which builds a
// StellarService (and a Keypair) at module load. Nothing here submits
// on-chain, so stub it out.
vi.mock("../src/lib/stellar.js", () => ({
  adminInvoke: vi.fn(),
  contractQuery: vi.fn(),
  stellarService: { query: vi.fn(), invoke: vi.fn() },
}));

const {
  buildDailyProfiles,
  clusterDailyProfiles,
  detectAnomalies,
  forecastConsumption,
  generateInsights,
  trainConsumptionModel,
} = await import("../src/lib/consumptionPatternsModel.js");
const analytics = await import("../src/lib/consumptionAnalytics.js");
const { db } = await import("../src/lib/usageEvents.js");
const { consumptionAnalyticsRouter } = await import("../src/routes/consumptionAnalytics.js");

const METER_ID = "METER-PATTERN-1";
/** A weekday household: quiet base, small morning bump, large evening peak. */
const START = Date.UTC(2026, 0, 5);

const bump = (hour: number, centre: number, width: number): number =>
  Math.exp(-(((hour - centre) / width) ** 2));

const weekdayKwh = (hour: number): number =>
  0.35 + 0.55 * bump(hour, 7, 2) + 1.9 * bump(hour, 19, 3) + 0.04 * Math.sin((2 * Math.PI * hour) / 24);

const weekendKwh = (hour: number): number => 0.9 + 0.5 * bump(hour, 13, 4);

/** `days` of history ending just before `endMs`. */
function cleanSamples(endMs: number, days = 42) {
  return Array.from({ length: days * 24 }, (_, index) => {
    const at = new Date(endMs - (days * 24 - index) * 3_600_000);
    const weekday = at.getUTCDay();
    return {
      timestamp: at.toISOString(),
      energyKwh: weekday === 0 || weekday === 6 ? weekendKwh(at.getUTCHours()) : weekdayKwh(at.getUTCHours()),
    };
  });
}

function seedUsage(meterId: string, samples: Array<{ timestamp: string; energyKwh: number }>) {
  const insert = db().prepare(`
    INSERT INTO usage_events (meter_id, units, cost, received_at, status, attempt_count, submitted_at)
    VALUES (?, ?, '0', ?, 'submitted', 1, ?)
  `);
  for (const sample of samples) {
    // usage_events stores milli-kWh.
    insert.run(meterId, Math.round(sample.energyKwh * 1000), sample.timestamp, sample.timestamp);
  }
}

describe("consumption pattern model", () => {
  it("separates weekday and weekend consumption shapes into distinct patterns", () => {
    const end = START + 42 * 86_400_000;
    const patterns = clusterDailyProfiles(cleanSamples(end), { maxClusters: 2 });
    expect(patterns.length).toBe(2);

    const shares = patterns.map((pattern) => pattern.days).sort((a, b) => b - a);
    // 42 days from a Monday: 30 weekdays and 12 weekend days.
    expect(shares).toEqual([30, 12]);
    expect(shares.reduce((sum, days) => sum + days, 0)).toBe(42);

    const weekday = patterns.find((pattern) => pattern.days === 30)!;
    const weekend = patterns.find((pattern) => pattern.days === 12)!;
    expect(weekday.peakHour).toBe(19);
    expect(weekday.kind).toBe("evening_peak");
    expect(weekend.peakHour).toBe(13);
    expect(weekend.kind).toBe("daytime_workload");
    expect(weekday.loadFactor).toBeLessThan(weekend.loadFactor);
    expect(weekend.sharePct).toBeCloseTo((12 / 42) * 100, 1);
    for (const pattern of patterns) {
      expect(pattern.centroid).toHaveLength(24);
      expect(pattern.sharePct).toBeGreaterThan(0);
    }
  });

  it("returns no patterns when there are not enough full days to compare", () => {
    const samples = [
      { timestamp: "2026-01-05T00:00:00.000Z", energyKwh: 1 },
      { timestamp: "2026-01-05T01:00:00.000Z", energyKwh: 1 },
    ];
    expect(buildDailyProfiles(samples)).toEqual([]);
    expect(clusterDailyProfiles(samples)).toEqual([]);
  });

  it("flags a spike but not ordinary hour-to-hour variation", () => {
    const base = cleanSamples(START + 35 * 86_400_000);
    const withSpike = [
      ...base,
      { timestamp: new Date(START + 35 * 86_400_000 + 3_600_000).toISOString(), energyKwh: 48 },
    ];

    const clean = detectAnomalies(base);
    expect(clean.sufficientData).toBe(true);
    expect(clean.anomalies).toEqual([]);

    const report = detectAnomalies(withSpike);
    const spike = report.anomalies.find((anomaly) => anomaly.energyKwh === 48);
    expect(spike).toBeDefined();
    expect(spike!.direction).toBe("over");
    expect(spike!.severity).toBe("critical");
    expect(spike!.score).toBeGreaterThan(8);
    expect(spike!.deviationPct).toBeGreaterThan(0);
    expect(spike!.description).toMatch(/above the usual level/);
  });

  it("reports insufficient data instead of claiming a clean meter", () => {
    const report = detectAnomalies(cleanSamples(START, 1));
    expect(report.evaluatedSamples).toBe(24);
    expect(report.sufficientData).toBe(false);
  });

  it("forecasts above 80% accuracy with a confidence band around each point", () => {
    const samples = cleanSamples(START + 35 * 86_400_000);
    const model = trainConsumptionModel(samples, new Date(START + 35 * 86_400_000));

    expect(model.accuracyPct).not.toBeNull();
    expect(model.accuracyPct!).toBeGreaterThan(80);
    expect(model.patterns.length).toBeGreaterThan(0);

    const forecast = forecastConsumption(model, new Date(START + 35 * 86_400_000), 24);
    expect(forecast).toHaveLength(24);
    for (const point of forecast) {
      expect(point.predictedKwh).toBeGreaterThan(0);
      expect(point.lowerKwh).toBeLessThanOrEqual(point.predictedKwh);
      expect(point.upperKwh).toBeGreaterThanOrEqual(point.predictedKwh);
    }
    // The forecast must reproduce the evening peak the history shows.
    const peak = forecast.reduce((best, point) => (point.predictedKwh > best.predictedKwh ? point : best));
    expect(peak.timestamp.slice(11, 13)).toMatch(/1[89]|2[01]/);
  });

  it("returns no accuracy figure when there is too little history to measure it", () => {
    const model = trainConsumptionModel([{ timestamp: "2026-01-05T00:00:00.000Z", energyKwh: 0.5 }]);
    expect(model.accuracyPct).toBeNull();
  });

  it("ranks peak-shifting ahead of other insights", () => {
    const end = START + 35 * 86_400_000;
    const model = trainConsumptionModel(cleanSamples(end), new Date(end));
    const forecast = forecastConsumption(model, new Date(end), 48);
    const insights = generateInsights({
      model,
      forecast,
      anomalies: [
        {
          timestamp: "2026-01-09T19:00:00.000Z",
          hour: 19,
          weekday: 5,
          energyKwh: 44,
          expectedKwh: 2.8,
          deviationPct: 1471.4,
          score: 22,
          severity: "critical",
          direction: "over",
          description: "Consumption 1471% above the usual level for this hour",
        },
      ],
    });

    expect(insights.length).toBeGreaterThan(0);
    expect(insights[0].id.startsWith("anomaly")).toBe(true);
    expect(insights.some((insight) => insight.category === "peak_shifting")).toBe(true);
    expect(insights.some((insight) => insight.category === "efficiency")).toBe(true);
    // Priorities must be non-increasing.
    const priorities = insights.map((insight) => insight.priority);
    expect([...priorities].sort((a, b) => b - a)).toEqual(priorities);
    for (const insight of insights) {
      expect(insight.estimatedAnnualKwh).toBeGreaterThanOrEqual(0);
      expect(insight.estimatedAnnualXlm).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("consumption analytics persistence", () => {
  // Anchored to the wall clock because the HTTP routes call these functions
  // with `now = new Date()` — history seeded in the past would fall outside
  // the default window and every endpoint would correctly report no data.
  const end = Date.now();

  beforeAll(() => {
    const samples = cleanSamples(end);
    samples.push({ timestamp: new Date(end - 7_200_000).toISOString(), energyKwh: 52 });
    seedUsage(METER_ID, samples);
    analytics.clearConsumptionModelsForTests();
  });

  it("analyses a meter's usage and beats 80% forecast accuracy", () => {
    const analysis = analytics.analyzeConsumption(METER_ID, { days: 90 });
    expect(analysis.meterId).toBe(METER_ID);
    expect(analysis.observedHours).toBeGreaterThan(0);
    expect(analysis.totalKwh).toBeGreaterThan(0);
    expect(analysis.accuracyPct).toBeGreaterThan(80);
    expect(analysis.sufficientData).toBe(true);
    expect(analysis.patterns.length).toBeGreaterThan(0);
    expect(analysis.forecast).toHaveLength(168);
    expect(analysis.insights.length).toBeGreaterThan(0);
  });

  it("flags an anomaly once and acknowledges it on request", () => {
    const analysis = analytics.analyzeConsumption(METER_ID, { days: 90 });
    expect(analysis.anomalySummary.total).toBeGreaterThanOrEqual(1);
    expect(analysis.anomalySummary.critical).toBeGreaterThanOrEqual(1);

    // Re-running the scan must not duplicate an already-flagged anomaly.
    const first = analytics.listFlaggedAnomalies(METER_ID);
    expect(first.length).toBe(analysis.anomalySummary.total);
    analytics.analyzeConsumption(METER_ID, { days: 90 });
    expect(analytics.listFlaggedAnomalies(METER_ID).length).toBe(first.length);

    const acked = analytics.acknowledgeAnomaly(first[0].id);
    expect(acked?.acknowledged).toBe(true);
    expect(analytics.listFlaggedAnomalies(METER_ID).length).toBe(first.length - 1);
    expect(analytics.listFlaggedAnomalies(METER_ID, { includeAcknowledged: true }).length).toBe(
      first.length,
    );
    expect(analytics.acknowledgeAnomaly("missing")).toBeUndefined();
  });

  it("builds a weekly insights report that is regenerated in place", () => {
    const report = analytics.generateWeeklyInsightsReport(METER_ID);
    expect(report.meterId).toBe(METER_ID);
    expect(report.weekEnd > report.weekStart).toBe(true);
    expect(report.totalKwh).toBeGreaterThan(0);
    expect(report.insights.length).toBeGreaterThan(0);

    analytics.generateWeeklyInsightsReport(METER_ID);
    const reports = analytics.listWeeklyReports(METER_ID);
    expect(reports.length).toBe(1);
    expect(reports[0].insights.length).toBeGreaterThan(0);
  });

  it("returns actual and forecast series for trend visualisation", () => {
    const { actual, forecast } = analytics.getTrendSeries(METER_ID, { forecastHours: 48 });
    expect(actual.length).toBeGreaterThan(0);
    expect(forecast).toHaveLength(48);
  });

  it("returns an empty result for a meter with no recorded usage", () => {
    const empty = analytics.analyzeConsumption("METER-UNKNOWN", { days: 90 });
    expect(empty.observedHours).toBe(0);
    expect(empty.accuracyPct).toBeNull();
    expect(empty.patterns).toEqual([]);
    expect(empty.forecast.every((point) => point.predictedKwh === 0)).toBe(true);
  });
});

describe("consumption analytics API", () => {
  let server: Server;
  let baseUrl = "";

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use("/api/analytics/patterns", consumptionAnalyticsRouter);
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("serves the full analysis", async () => {
    const res = await fetch(`${baseUrl}/api/analytics/patterns/${METER_ID}?days=90`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.meterId).toBe(METER_ID);
    expect(body.patterns.length).toBeGreaterThan(0);
    expect(body.forecast).toHaveLength(168);
    expect(body.accuracyPct).toBeGreaterThan(80);
  });

  it("serves trends, patterns, anomalies and weekly reports", async () => {
    const trends = await fetch(`${baseUrl}/api/analytics/patterns/${METER_ID}/trends?forecastHours=48`);
    expect(trends.status).toBe(200);
    const trendBody = await trends.json();
    expect(trendBody.actual.length).toBeGreaterThan(0);
    expect(trendBody.forecast).toHaveLength(48);

    const patterns = await fetch(`${baseUrl}/api/analytics/patterns/${METER_ID}/patterns`);
    expect(patterns.status).toBe(200);
    expect((await patterns.json()).patterns.length).toBeGreaterThan(0);

    const anomalies = await fetch(`${baseUrl}/api/analytics/patterns/${METER_ID}/anomalies`);
    expect(anomalies.status).toBe(200);
    expect((await anomalies.json()).count).toBeGreaterThan(0);

    const weekly = await fetch(`${baseUrl}/api/analytics/patterns/${METER_ID}/weekly`);
    expect(weekly.status).toBe(200);
    expect((await weekly.json()).count).toBeGreaterThan(0);
  });

  it("generates a weekly report on demand", async () => {
    const res = await fetch(`${baseUrl}/api/analytics/patterns/${METER_ID}/weekly`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).insights.length).toBeGreaterThan(0);
  });

  it("acknowledges a flagged anomaly", async () => {
    const list = await (
      await fetch(`${baseUrl}/api/analytics/patterns/${METER_ID}/anomalies`)
    ).json();
    const anomalyId = encodeURIComponent(list.anomalies[0].id);
    const res = await fetch(`${baseUrl}/api/analytics/patterns/anomalies/${anomalyId}/ack`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect((await res.json()).acknowledged).toBe(true);
  });

  it("rejects out-of-range query parameters", async () => {
    const res = await fetch(`${baseUrl}/api/analytics/patterns/${METER_ID}?days=0`);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("VALIDATION_ERROR");

    const severity = await fetch(
      `${baseUrl}/api/analytics/patterns/${METER_ID}/anomalies?severity=nope`,
    );
    expect(severity.status).toBe(400);
  });

  it("404s when acknowledging an unknown anomaly", async () => {
    const res = await fetch(`${baseUrl}/api/analytics/patterns/anomalies/missing/ack`, {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });
});
