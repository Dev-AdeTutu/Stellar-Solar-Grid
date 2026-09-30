import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";

const mocks = vi.hoisted(() => ({
  getWeather: vi.fn(),
  recordObservation: vi.fn(),
  getObservations: vi.fn(() => new Map()),
  weatherProductionFactor: vi.fn(() => 0.8),
  getMeterEnergyModel: vi.fn(),
  getSolarEnergyModel: vi.fn(),
  predictHourly: vi.fn(() => 1.25),
  getDevice: vi.fn(),
  listPerformance: vi.fn(() => []),
}));

vi.mock("../src/lib/weather.js", () => ({
  WeatherUnavailableError: class WeatherUnavailableError extends Error {
    constructor(message: string, public status = 503) { super(message); }
  },
  deriveAlerts: vi.fn(),
  forecastProduction: vi.fn(),
  getObservations: mocks.getObservations,
  getWeather: mocks.getWeather,
  getWeatherUsage: vi.fn(),
  pearson: vi.fn(),
  recordObservation: mocks.recordObservation,
  weatherProductionFactor: mocks.weatherProductionFactor,
}));

vi.mock("../src/lib/energyForecast.js", () => ({
  getMeterEnergyModel: mocks.getMeterEnergyModel,
  getSolarEnergyModel: mocks.getSolarEnergyModel,
  predictHourly: mocks.predictHourly,
}));

vi.mock("../src/lib/deviceRegistry.js", () => ({
  getDevice: mocks.getDevice,
  listPerformance: mocks.listPerformance,
}));

const { weatherRouter } = await import("../src/routes/weather.js");
let server: Server;
let baseUrl = "";

function weatherReport() {
  const start = Date.UTC(2026, 8, 29, 12);
  return {
    location: { lat: 1, lon: 2, timezone: "UTC" },
    current: {
      time: new Date(start).toISOString(), temperatureC: 20, cloudCoverPct: 10, humidityPct: 50,
      windSpeedMs: 1, uvIndex: 5, conditionId: 800, condition: "Clear", description: "clear",
      sunrise: null, sunset: null,
    },
    hourly: Array.from({ length: 48 }, (_, index) => ({
      time: new Date(start + index * 3_600_000).toISOString(), temperatureC: 20, cloudCoverPct: 10,
      humidityPct: 50, windSpeedMs: 1, precipitationProbability: 0, rainMm: 0, uvIndex: 5,
      conditionId: 800, condition: "Clear",
    })),
    daily: [],
    providerAlerts: [],
    fetchedAt: new Date(start).toISOString(),
    cached: false,
    stale: false,
  };
}

beforeAll(async () => {
  const app = express();
  app.use("/api/weather", weatherRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server failed to bind");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

beforeEach(() => {
  mocks.getWeather.mockResolvedValue(weatherReport());
  mocks.getMeterEnergyModel.mockReturnValue({
    coefficients: [], trainingSamples: 2000, observedSamples: 400, accuracyPct: 91, trainedAt: "2026-09-29T00:00:00.000Z",
  });
});

describe("energy forecast HTTP API", () => {
  it("returns 48 weather-integrated hourly consumption values and model accuracy", async () => {
    const response = await fetch(`${baseUrl}/api/weather/energy-forecast?meterId=METER1&lat=1&lon=2`);
    const body = await response.json() as {
      horizonHours: number;
      forecast: Array<{ consumptionKwh: number | null }>;
      models: { consumption: { accuracyPct: number | null } };
    };

    expect(response.status).toBe(200);
    expect(body.horizonHours).toBe(48);
    expect(body.forecast).toHaveLength(48);
    expect(body.forecast[0].consumptionKwh).toBe(1.25);
    expect(body.models.consumption.accuracyPct).toBe(91);
  });

  it("requires a meter or solar device identifier", async () => {
    const response = await fetch(`${baseUrl}/api/weather/energy-forecast?lat=1&lon=2`);
    expect(response.status).toBe(400);
  });
});