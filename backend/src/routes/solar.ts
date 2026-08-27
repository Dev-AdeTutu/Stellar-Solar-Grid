import { Router, Request, Response } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { logger } from "../lib/logger.js";

export const solarRouter = Router();

// ── Constants ──────────────────────────────────────────────────────────────

/** Average panel efficiency loss per year (degradation rate) */
const DEGRADATION_RATE = 0.005;

/** System losses: inverter, wiring, temperature, soiling (typical 14%) */
const SYSTEM_LOSS = 0.86;

/** Days per period */
const PERIOD_DAYS: Record<string, number> = {
  daily: 1,
  weekly: 7,
  monthly: 30,
  yearly: 365,
};

// ── Types ──────────────────────────────────────────────────────────────────

interface ForecastPeriod {
  period: string;
  days: number;
  estimatedKwh: number;
  estimatedRevenue: number;
}

interface ForecastResponse {
  panelCapacityKw: number;
  peakSunHours: number;
  efficiency: number;
  panelAgeYears: number;
  effectiveDegradation: number;
  dailyKwh: number;
  forecast: ForecastPeriod[];
  assumptions: {
    systemLoss: number;
    degradationRatePerYear: number;
    ratePerKwh: number;
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Core solar production formula:
 *   kWh/day = capacity(kW) × peakSunHours × efficiency × systemLoss × degradationFactor
 */
function calcDailyKwh(
  capacityKw: number,
  peakSunHours: number,
  efficiency: number,
  panelAgeYears: number,
): number {
  const degradationFactor = Math.pow(1 - DEGRADATION_RATE, panelAgeYears);
  return capacityKw * peakSunHours * efficiency * SYSTEM_LOSS * degradationFactor;
}

function parsePositiveFloat(val: unknown, name: string, max?: number): number {
  const n = Number(val);
  if (!Number.isFinite(n) || n <= 0) {
    throw Object.assign(new Error(`${name} must be a positive number`), { code: "VALIDATION_ERROR" });
  }
  if (max !== undefined && n > max) {
    throw Object.assign(new Error(`${name} must be ≤ ${max}`), { code: "VALIDATION_ERROR" });
  }
  return n;
}

function parseNonNegativeFloat(val: unknown, name: string): number {
  const n = Number(val);
  if (!Number.isFinite(n) || n < 0) {
    throw Object.assign(new Error(`${name} must be a non-negative number`), { code: "VALIDATION_ERROR" });
  }
  return n;
}

// ── Routes ─────────────────────────────────────────────────────────────────

/**
 * GET /api/solar/forecast
 *
 * Estimates solar energy production and revenue for a given panel setup.
 *
 * Query params:
 *   capacityKw      — total panel capacity in kilowatts (required, e.g. 5)
 *   peakSunHours    — average daily peak sun hours for the location (required, e.g. 5.5)
 *   efficiency      — panel efficiency 0–1 (optional, default 0.20)
 *   panelAgeYears   — age of panels in years for degradation calc (optional, default 0)
 *   ratePerKwh      — local electricity rate in XLM/kWh (optional, default 0.12)
 *
 * Example:
 *   GET /api/solar/forecast?capacityKw=10&peakSunHours=5.5&efficiency=0.20&ratePerKwh=0.15
 */
solarRouter.get(
  "/forecast",
  asyncHandler(async (req: Request, res: Response) => {
    const {
      capacityKw: rawCap,
      peakSunHours: rawPsh,
      efficiency: rawEff = "0.20",
      panelAgeYears: rawAge = "0",
      ratePerKwh: rawRate = "0.12",
    } = req.query;

    // Validate inputs
    const capacityKw = parsePositiveFloat(rawCap, "capacityKw", 10_000);
    const peakSunHours = parsePositiveFloat(rawPsh, "peakSunHours", 24);
    const efficiency = parsePositiveFloat(rawEff, "efficiency", 1);
    const panelAgeYears = parseNonNegativeFloat(rawAge, "panelAgeYears");
    const ratePerKwh = parseNonNegativeFloat(rawRate, "ratePerKwh");

    const degradationFactor = Math.pow(1 - DEGRADATION_RATE, panelAgeYears);
    const effectiveDegradation = Number(((1 - degradationFactor) * 100).toFixed(2));

    const dailyKwh = calcDailyKwh(capacityKw, peakSunHours, efficiency, panelAgeYears);

    const forecast: ForecastPeriod[] = Object.entries(PERIOD_DAYS).map(
      ([period, days]) => {
        const estimatedKwh = Number((dailyKwh * days).toFixed(3));
        const estimatedRevenue = Number((estimatedKwh * ratePerKwh).toFixed(4));
        return { period, days, estimatedKwh, estimatedRevenue };
      },
    );

    const response: ForecastResponse = {
      panelCapacityKw: capacityKw,
      peakSunHours,
      efficiency,
      panelAgeYears,
      effectiveDegradation,
      dailyKwh: Number(dailyKwh.toFixed(3)),
      forecast,
      assumptions: {
        systemLoss: SYSTEM_LOSS,
        degradationRatePerYear: DEGRADATION_RATE,
        ratePerKwh,
      },
    };

    logger.info(
      { capacityKw, peakSunHours, efficiency, dailyKwh: response.dailyKwh },
      "Solar forecast computed",
    );

    res.json(response);
  }),
);

/**
 * GET /api/solar/irradiance-zones
 *
 * Returns reference peak sun hour values for common climate zones.
 * Useful for the frontend dropdown so users don't need to look this up.
 */
solarRouter.get("/irradiance-zones", (_req: Request, res: Response) => {
  res.json({
    zones: [
      { name: "Equatorial (e.g. Kenya, Nigeria, Ghana)", peakSunHours: 6.0 },
      { name: "Tropical wet/dry (e.g. India, Brazil)", peakSunHours: 5.5 },
      { name: "Sub-Saharan savanna", peakSunHours: 6.5 },
      { name: "Mediterranean (e.g. Spain, South Africa)", peakSunHours: 5.2 },
      { name: "Temperate (e.g. Central Europe, UK)", peakSunHours: 3.5 },
      { name: "Desert (e.g. Sahara, Arizona, Middle East)", peakSunHours: 7.5 },
      { name: "Northern / cloudy (e.g. Scandinavia, Canada)", peakSunHours: 2.5 },
    ],
  });
});
