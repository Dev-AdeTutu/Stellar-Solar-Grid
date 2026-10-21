/**
 * Energy forecasting dashboard endpoints (#1082). See frontend/FORECASTING.md.
 *
 *   GET  /api/forecast-dashboard/:meterId?lat=&lon=  — 7-day generation + consumption forecast with 95% CI
 *   GET  /api/forecast-dashboard/:meterId/compare    — forecast vs actual with accuracy metrics
 *   POST /api/forecast-dashboard/:meterId/actuals    — record a daily actual { date, generationKwh, consumptionKwh }
 */
import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { logger } from "../lib/logger.js";
import { getWeather, type DailyForecast } from "../lib/weather.js";
import { buildForecast, compareForecastToActual, recordActual } from "../lib/forecastDashboard.js";

export const forecastDashboardRouter = Router();

forecastDashboardRouter.get(
  "/:meterId",
  asyncHandler(async (req, res) => {
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);
    let weather: DailyForecast[] = [];
    if (Number.isFinite(lat) && Number.isFinite(lon) && req.query.lat !== undefined && req.query.lon !== undefined) {
      try {
        weather = (await getWeather(lat, lon)).daily;
      } catch (err) {
        logger.warn({ err, meterId: req.params.meterId }, "forecast-dashboard: weather unavailable, using baseline");
      }
    }
    const days = buildForecast(req.params.meterId, weather);
    res.json({ meterId: req.params.meterId, generatedAt: new Date().toISOString(), confidence: 0.95, days, comparison: compareForecastToActual(req.params.meterId) });
  }),
);

forecastDashboardRouter.get("/:meterId/compare", (req, res) => res.json(compareForecastToActual(req.params.meterId)));

forecastDashboardRouter.post("/:meterId/actuals", (req, res) => {
  const { date, generationKwh, consumptionKwh } = req.body ?? {};
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "date must be YYYY-MM-DD" });
  const g = Number(generationKwh);
  const c = Number(consumptionKwh);
  if (!Number.isFinite(g) || g < 0 || !Number.isFinite(c) || c < 0) return res.status(400).json({ error: "generationKwh and consumptionKwh must be non-negative numbers" });
  res.status(201).json(recordActual(req.params.meterId, { date, generationKwh: g, consumptionKwh: c }));
});
