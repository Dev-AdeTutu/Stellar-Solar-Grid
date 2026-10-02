/**
 * Energy trading strategy backtesting (#940).
 *
 *   GET  /api/backtest/prices?from=&to=   historical daily prices
 *   POST /api/backtest/run                { strategy, from?, to?, initialCapital?, feeRate? }
 *   POST /api/backtest/share              { strategy } → { token }
 *   GET  /api/backtest/share/:token       → { strategy }
 */
import { Router } from "express";
import {
  decodeStrategy,
  encodeStrategy,
  getPriceHistory,
  getPriceRange,
  runBacktest,
  validateStrategy,
} from "../lib/backtesting.js";

export const backtestRouter = Router();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const optDate = (v: unknown) => (typeof v === "string" && DATE_RE.test(v) ? v : undefined);

backtestRouter.get("/prices", (req, res) => {
  const prices = getPriceRange(optDate(req.query.from), optDate(req.query.to));
  res.json({ prices });
});

backtestRouter.post("/run", (req, res) => {
  const body = req.body ?? {};
  const strategy = validateStrategy(body.strategy);
  if (typeof strategy === "string") return res.status(400).json({ error: strategy });

  const history = getPriceHistory();
  const lastDate = history[history.length - 1]?.date;
  const defaultFrom = lastDate
    ? new Date(Date.parse(lastDate) - 365 * 86_400_000).toISOString().slice(0, 10)
    : undefined;
  const from = optDate(body.from) ?? defaultFrom ?? "";
  const to = optDate(body.to) ?? lastDate ?? "";
  if (from > to) return res.status(400).json({ error: "from must be before to" });

  const initialCapital = body.initialCapital === undefined ? 1000 : Number(body.initialCapital);
  if (!(initialCapital > 0)) return res.status(400).json({ error: "initialCapital must be positive" });
  const feeRate = body.feeRate === undefined ? 0 : Number(body.feeRate);
  if (!(feeRate >= 0 && feeRate < 1)) return res.status(400).json({ error: "feeRate must be between 0 and 1" });

  const series = getPriceRange(from, to);
  if (series.length < 2) return res.status(400).json({ error: "Not enough price data in range" });

  res.json(runBacktest({ strategy, from, to, initialCapital, feeRate }, series));
});

backtestRouter.post("/share", (req, res) => {
  const strategy = validateStrategy(req.body?.strategy);
  if (typeof strategy === "string") return res.status(400).json({ error: strategy });
  res.json({ token: encodeStrategy(strategy) });
});

backtestRouter.get("/share/:token", (req, res) => {
  const strategy = decodeStrategy(req.params.token);
  if (typeof strategy === "string") return res.status(400).json({ error: strategy });
  res.json({ strategy });
});
