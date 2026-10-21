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
const { metersRouter } = await import("../src/routes/meters.js");
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

function dailyWeatherReport() {
  const start = Date.UTC(2026, 8, 29, 12);
  return {
    ...weatherReport(),
    daily: Array.from({ length: 7 }, (_, index) => ({
      date: new Date(start + index * 86_400_000).toISOString().slice(0, 10),
      temperatureMinC: 14 + index,
      temperatureMaxC: 24 + index,
      temperatureAvgC: 19 + index,
      cloudCoverPct: 10 + index * 5,
      precipitationProbability: 5,
      rainMm: 0,
      uvIndex: 5,
      sunrise: null,
      sunset: null,
      conditionId: 800,
      condition: "Clear",
    })),
  };
}

function syntheticUsageSeries() {
  // Usage is a deterministic function of temperature and sunlight so the
  // forecast model can be checked against a known ground truth.
  return Array.from({ length: 30 * 24 }, (_, index) => {
    const hour = index % 24;
    const temperatureC = 18 + 8 * Math.sin((hour / 24) * Math.PI * 2);
    const sunlight = Math.max(0, Math.sin(((hour - 6) / 12) * Math.PI));
    return {
      timestamp: new Date(Date.UTC(2026, 7, 1) + index * 3_600_000).toISOString(),
      consumptionKwh: 0.4 + 0.05 * temperatureC + 0.3 * sunlight,
      temperatureC,
      sunlight,
    };
  });
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/weather", weatherRouter);
  app.use("/api/meters", metersRouter);
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
  vi.clearAllMocks();
  mocks.getWeather.mockResolvedValue(dailyWeatherReport());
  mocks.getObservations.mockReturnValue(new Map());
  mocks.weatherProductionFactor.mockReturnValue(0.8);
  mocks.predictHourly.mockReturnValue(1.25);
  mocks.listPerformance.mockReturnValue([]);
  mocks.getMeterEnergyModel.mockReturnValue({
    coefficients: [], trainingSamples: 2000, observedSamples: 400, accuracyPct: 91, trainedAt: "2026-09-29T00:00:00.000Z",
  });
  mocks.getSolarEnergyModel.mockReturnValue({
    coefficients: [], trainingSamples: 1500, observedSamples: 300, accuracyPct: 88, trainedAt: "2026-09-29T00:00:00.000Z",
  });
  mocks.getDevice.mockReturnValue({
    id: "SOLAR1",
    type: "solar",
    meterId: "METER1",
    capacityKw: 5,
    creditBalance: 250,
    currency: "USD",
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

describe("GET /api/meters/:meterId/forecast", () => {
  it("returns seven daily points with confidence bands and weather inputs", async () => {
    const response = await fetch(`${baseUrl}/api/meters/METER1/forecast?lat=1&lon=2`);
    const body = await response.json() as {
      meterId: string;
      horizonDays: number;
      forecast: Array<{
        date: string;
        predictedKwh: number;
        lowerKwh: number;
        upperKwh: number;
        weather: { temperatureC: number; cloudCoverPct: number; sunlightHours: number };
      }>;
      models: { consumption: { accuracyPct: number | null } };
    };

    expect(response.status).toBe(200);
    expect(body.meterId).toBe("METER1");
    expect(body.horizonDays).toBe(7);
    expect(body.forecast).toHaveLength(7);
    expect(body.models.consumption.accuracyPct).toBe(91);

    for (const point of body.forecast) {
      expect(point.lowerKwh).toBeLessThanOrEqual(point.predictedKwh);
      expect(point.predictedKwh).toBeLessThanOrEqual(point.upperKwh);
      expect(point.weather.temperatureC).toBeTypeOf("number");
      expect(point.weather.cloudCoverPct).toBeTypeOf("number");
      expect(point.weather.sunlightHours).toBeGreaterThanOrEqual(0);
    }

    const dates = body.forecast.map((point) => point.date);
    expect(new Set(dates).size).toBe(7);
  });

  it("predicts solar generation from the sunlight forecast when a solar device is linked", async () => {
    const response = await fetch(`${baseUrl}/api/meters/METER1/forecast?lat=1&lon=2`);
    const body = await response.json() as {
      forecast: Array<{ predictedSolarKwh: number | null; weather: { sunlightHours: number } }>;
      solar: { deviceId: string; predictedKwh: number } | null;
    };

    expect(response.status).toBe(200);
    expect(body.solar?.deviceId).toBe("SOLAR1");
    expect(body.solar?.predictedKwh).toBeGreaterThan(0);
    for (const point of body.forecast) {
      expect(point.predictedSolarKwh).not.toBeNull();
      expect(point.predictedSolarKwh as number).toBeGreaterThanOrEqual(0);
    }
    expect(mocks.weatherProductionFactor).toHaveBeenCalled();
  });

  it("raises a credit alert when the meter balance is predicted to run out", async () => {
    mocks.getDevice.mockReturnValue({
      id: "METER1",
      type: "meter",
      meterId: "METER1",
      creditBalance: 0.5,
      currency: "USD",
    });

    const response = await fetch(`${baseUrl}/api/meters/METER1/forecast?lat=1&lon=2`);
    const body = await response.json() as {
      creditAlert: { severity: string; message: string; daysUntilEmpty: number } | null;
    };

    expect(response.status).toBe(200);
    expect(body.creditAlert).not.toBeNull();
    expect(body.creditAlert?.severity).toBe("warning");
    expect(body.creditAlert?.message).toMatch(/credit/i);
    expect(body.creditAlert?.daysUntilEmpty).toBeLessThanOrEqual(7);
  });

  it("omits the credit alert when the balance covers the forecast horizon", async () => {
    mocks.getDevice.mockReturnValue({
      id: "METER1",
      type: "meter",
      meterId: "METER1",
      creditBalance: 100_000,
      currency: "USD",
    });

    const response = await fetch(`${baseUrl}/api/meters/METER1/forecast?lat=1&lon=2`);
    const body = await response.json() as { creditAlert: unknown };
    expect(response.status).toBe(200);
    expect(body.creditAlert).toBeNull();
  });

  it("404s for an unknown meter", async () => {
    mocks.getDevice.mockReturnValue(undefined);
    const response = await fetch(`${baseUrl}/api/meters/UNKNOWN/forecast?lat=1&lon=2`);
    expect(response.status).toBe(404);
  });

  it("503s when the weather provider is unavailable", async () => {
    mocks.getWeather.mockRejectedValue(new Error("provider down"));
    const response = await fetch(`${baseUrl}/api/meters/METER1/forecast?lat=1&lon=2`);
    expect(response.status).toBe(503);
  });

  it("keeps forecast accuracy within tolerance of a synthetic temperature/sunlight series", async () => {
    const series = syntheticUsageSeries();
    const observations = new Map(
      series.map((sample) => [sample.timestamp, { consumptionKwh: sample.consumptionKwh, temperatureC: sample.temperatureC, sunlight: sample.sunlight }]),
    );
    mocks.getObservations.mockReturnValue(observations);

    const response = await fetch(`${baseUrl}/api/meters/METER1/forecast?lat=1&lon=2`);
    const body = await response.json() as {
      forecast: Array<{ predictedKwh: number; weather: { temperatureC: number; sunlightHours: number } }>;
      accuracy: { mapePct: number | null; samples: number };
    };

    expect(response.status).toBe(200);
    expect(body.accuracy.samples).toBeGreaterThan(0);
    expect(body.accuracy.mapePct).not.toBeNull();
    expect(body.accuracy.mapePct as number).toBeLessThan(15);

    for (const point of body.forecast) {
      const expected = 0.4 + 0.05 * point.weather.temperatureC + 0.3 * point.weather.sunlightHours;
      expect(Math.abs(point.predictedKwh - expected) / expected).toBeLessThan(0.15);
    }
  });
});