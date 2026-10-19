import { describe, expect, it } from "vitest";
import { predictHourly, trainHourlyModel, type HourlyEnergySample } from "../src/lib/energyForecastModel.js";

describe("hourly energy forecast model", () => {
  it("learns repeatable hourly and weekly patterns and scores above 85% on held-out data", () => {
    const start = Date.UTC(2026, 0, 5);
    const samples: HourlyEnergySample[] = Array.from({ length: 24 * 35 }, (_, index) => {
      const timestamp = new Date(start + index * 3_600_000).toISOString();
      const date = new Date(timestamp);
      const hour = date.getUTCHours();
      const weekday = date.getUTCDay();
      return {
        timestamp,
        energyKwh: 2 + 0.8 * Math.sin((2 * Math.PI * hour) / 24) + 0.3 * Math.cos((2 * Math.PI * weekday) / 7),
      };
    });
    const model = trainHourlyModel(samples);
    const forecast = Array.from({ length: 48 }, (_, index) =>
      predictHourly(model, new Date(start + samples.length * 3_600_000 + index * 3_600_000).toISOString()),
    );

    expect(model.accuracyPct).toBeGreaterThan(85);
    expect(model.trainingSamples).toBe(samples.length);
    expect(model.observedSamples).toBe(samples.length);
    expect(forecast).toHaveLength(48);
    expect(forecast.every((value) => Number.isFinite(value) && value >= 0)).toBe(true);
  });

  it("reports unavailable accuracy when history is insufficient", () => {
    const model = trainHourlyModel([{ timestamp: "2026-01-01T00:00:00.000Z", energyKwh: 0.5 }]);
    expect(model.accuracyPct).toBeNull();
    expect(predictHourly(model, "2026-01-01T01:00:00.000Z")).toBe(0.5);
  });
});