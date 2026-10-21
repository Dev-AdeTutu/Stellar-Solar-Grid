import path from "node:path";
import { mkdirSync } from "node:fs";
import Database from "better-sqlite3";
import { registerDatabase } from "./databaseLifecycle.js";

const DB_PATH = process.env.TRADING_SIMULATOR_DB_PATH ?? path.resolve(process.cwd(), "data", "trading-simulator.sqlite");
const STARTING_CREDITS = Number(process.env.SIMULATOR_STARTING_CREDITS ?? 1_000);
export const SIMULATOR_FEE_RATE = Number(process.env.SIMULATOR_TRADE_FEE_RATE ?? 0.005);
const FALLBACK_PRICE = Number(process.env.MARKET_PRICE_FALLBACK_EUR_KWH ?? 0.18);
const MARKET_URL = process.env.ENERGY_MARKET_DATA_URL ?? "https://api.energy-charts.info/price";
const MARKET_ZONE = process.env.ENERGY_MARKET_BIDDING_ZONE ?? "DE-LU";

export type MarketPrice = { timestamp: string; pricePerKwh: number; source: string };
export type SimulatorAccount = { userId: string; cash: number; energyKwh: number; marketValue: number; totalValue: number; pnl: number };
export type SimulatorTrade = { id: number; userId: string; side: "buy" | "sell"; quantityKwh: number; pricePerKwh: number; fee: number; executedAt: string };

export type DerivativeKind = "future" | "call" | "put";
export type DerivativePosition = {
  id: number;
  userId: string;
  kind: DerivativeKind;
  side: "long" | "short";
  quantityKwh: number;
  strikePerKwh: number;
  premium: number;
  margin: number;
  openedAt: string;
  expiresAt: string;
  status: "open" | "settled" | "liquidated";
  settlementPricePerKwh: number | null;
  settlementValue: number | null;
  settledAt: string | null;
};
export type DerivativeQuote = {
  kind: DerivativeKind;
  side: "long" | "short";
  quantityKwh: number;
  strikePerKwh: number;
  spotPerKwh: number;
  premium: number;
  margin: number;
  expiresAt: string;
};

export const DERIVATIVE_MARGIN_RATE = Number(process.env.DERIVATIVE_MARGIN_RATE ?? 0.2);
export const DERIVATIVE_MAINTENANCE_RATE = Number(process.env.DERIVATIVE_MAINTENANCE_RATE ?? 0.1);
const DERIVATIVE_DEFAULT_DAYS = Number(process.env.DERIVATIVE_DEFAULT_DAYS ?? 30);
const DERIVATIVE_VOLATILITY = Number(process.env.DERIVATIVE_VOLATILITY ?? 0.35);
const DERIVATIVE_RISK_FREE_RATE = Number(process.env.DERIVATIVE_RISK_FREE_RATE ?? 0.03);
======

<<<<<<< SEARCH
      CREATE TABLE IF NOT EXISTS simulator_market_prices (
        timestamp TEXT PRIMARY KEY,
        price_per_kwh REAL NOT NULL,
        source TEXT NOT NULL
      );
    `);
=======
      CREATE TABLE IF NOT EXISTS simulator_market_prices (
        timestamp TEXT PRIMARY KEY,
        price_per_kwh REAL NOT NULL,
        source TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS simulator_derivatives (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('future', 'call', 'put')),
        side TEXT NOT NULL CHECK (side IN ('long', 'short')),
        quantity_kwh REAL NOT NULL,
        strike_per_kwh REAL NOT NULL,
        premium REAL NOT NULL,
        margin REAL NOT NULL,
        opened_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'settled', 'liquidated')),
        settlement_price_per_kwh REAL,
        settlement_value REAL,
        settled_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_simulator_derivatives_user ON simulator_derivatives (user_id, id DESC);
      CREATE INDEX IF NOT EXISTS idx_simulator_derivatives_status ON simulator_derivatives (status, expires_at);
    `);
======

<<<<<<< SEARCH
export function getSimulatorLeaderboard(pricePerKwh: number, limit = 20): SimulatorAccount[] {
  const users = db().prepare("SELECT user_id FROM simulator_accounts ORDER BY created_at ASC LIMIT 1000").all() as Array<{ user_id: string }>;
  return users
    .map(({ user_id }) => getSimulatorAccount(user_id, pricePerKwh))
    .sort((left, right) => right.totalValue - left.totalValue)
    .slice(0, Math.min(100, Math.max(1, Math.trunc(limit))));
}
=======
export function getSimulatorLeaderboard(pricePerKwh: number, limit = 20): SimulatorAccount[] {
  const users = db().prepare("SELECT user_id FROM simulator_accounts ORDER BY created_at ASC LIMIT 1000").all() as Array<{ user_id: string }>;
  return users
    .map(({ user_id }) => getSimulatorAccount(user_id, pricePerKwh))
    .sort((left, right) => right.totalValue - left.totalValue)
    .slice(0, Math.min(100, Math.max(1, Math.trunc(limit))));
}

function normalCdf(value: number): number {
  // Abramowitz & Stegun approximation of the standard normal CDF.
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * erf);
}

function yearsUntil(expiresAt: Date, now: Date): number {
  return Math.max(0, (expiresAt.getTime() - now.getTime()) / (365 * 24 * 60 * 60_000));
}

/** Black-Scholes price per kWh for a European call or put on energy credits. */
export function priceOption(input: {
  kind: "call" | "put";
  spotPerKwh: number;
  strikePerKwh: number;
  expiresAt: Date;
  now?: Date;
  volatility?: number;
  riskFreeRate?: number;
}): number {
  const now = input.now ?? new Date();
  const spot = Math.max(0, input.spotPerKwh);
  const strike = Math.max(0, input.strikePerKwh);
  const sigma = Math.max(1e-6, input.volatility ?? DERIVATIVE_VOLATILITY);
  const rate = input.riskFreeRate ?? DERIVATIVE_RISK_FREE_RATE;
  const t = yearsUntil(input.expiresAt, now);
  if (t <= 0) {
    return input.kind === "call" ? Math.max(0, spot - strike) : Math.max(0, strike - spot);
  }
  const d1 = (Math.log(spot / strike) + (rate + (sigma * sigma) / 2) * t) / (sigma * Math.sqrt(t));
  const d2 = d1 - sigma * Math.sqrt(t);
  const discount = Math.exp(-rate * t);
  if (input.kind === "call") return spot * normalCdf(d1) - strike * discount * normalCdf(d2);
  return strike * discount * normalCdf(-d2) - spot * normalCdf(-d1);
}

/** Fair value per kWh of a futures contract, discounted from the expiry date. */
export function priceFuture(input: {
  spotPerKwh: number;
  expiresAt: Date;
  now?: Date;
  riskFreeRate?: number;
}): number {
  const now = input.now ?? new Date();
  const rate = input.riskFreeRate ?? DERIVATIVE_RISK_FREE_RATE;
  const t = yearsUntil(input.expiresAt, now);
  return Math.max(0, input.spotPerKwh) * Math.exp(rate * t);
}

/** Initial margin required per kWh for a derivative position. */
export function computeDerivativeMargin(input: {
  kind: DerivativeKind;
  spotPerKwh: number;
  strikePerKwh: number;
  expiresAt: Date;
  now?: Date;
}): number {
  const now = input.now ?? new Date();
  const t = yearsUntil(input.expiresAt, now);
  const volatilityBuffer = Math.max(0, input.spotPerKwh) * DERIVATIVE_VOLATILITY * Math.sqrt(Math.max(t, 1 / 365));
  const base = input.kind === "future" ? Math.max(0, input.spotPerKwh) : Math.max(0, input.strikePerKwh);
  return Math.max(base * DERIVATIVE_MARGIN_RATE, volatilityBuffer) + 1e-9;
}

export function quoteDerivative(input: {
  kind: DerivativeKind;
  side: "long" | "short";
  quantityKwh: number;
  strikePerKwh?: number;
  spotPerKwh: number;
  now?: Date;
  expiresAt?: Date;
}): DerivativeQuote {
  const now = input.now ?? new Date();
  const quantity = Math.round(input.quantityKwh * 1_000) / 1_000;
  if (quantity <= 0) throw new Error("Derivative quantity must be at least 0.001 kWh");
  const expiresAt = input.expiresAt ?? new Date(now.getTime() + DERIVATIVE_DEFAULT_DAYS * 24 * 60 * 60_000);
  if (expiresAt.getTime() <= now.getTime()) throw new Error("Derivative expiry must be in the future");
  const strike = input.strikePerKwh ?? input.spotPerKwh;
  if (!Number.isFinite(strike) || strike < 0) throw new Error("Derivative strike must be non-negative");
  let unitPremium = 0;
  if (input.kind === "future") {
    unitPremium = priceFuture({ spotPerKwh: input.spotPerKwh, expiresAt, now }) - strike;
  } else {
    unitPremium = priceOption({ kind: input.kind, spotPerKwh: input.spotPerKwh, strikePerKwh: strike, expiresAt, now });
  }
  const premium = Math.max(0, unitPremium) * quantity;
  const margin = computeDerivativeMargin({ kind: input.kind, spotPerKwh: input.spotPerKwh, strikePerKwh: strike, expiresAt, now }) * quantity;
  return {
    kind: input.kind,
    side: input.side,
    quantityKwh: quantity,
    strikePerKwh: strike,
    spotPerKwh: input.spotPerKwh,
    premium: Math.round(premium * 1e6) / 1e6,
    margin: Math.round(margin * 1e6) / 1e6,
    expiresAt: expiresAt.toISOString(),
  };
}

function mapDerivativeRow(row: Record<string, any>): DerivativePosition {
  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind,
    side: row.side,
    quantityKwh: row.quantity_kwh,
    strikePerKwh: row.strike_per_kwh,
    premium: row.premium,
    margin: row.margin,
    openedAt: row.opened_at,
    expiresAt: row.expires_at,
    status: row.status,
    settlementPricePerKwh: row.settlement_price_per_kwh,
    settlementValue: row.settlement_value,
    settledAt: row.settled_at,
  };
}

export function openDerivativePosition(input: {
  userId: string;
  kind: DerivativeKind;
  side: "long" | "short";
  quantityKwh: number;
  strikePerKwh?: number;
  market: MarketPrice;
  expiresAt?: Date;
  now?: Date;
}): { account: SimulatorAccount; position: DerivativePosition } {
  ensureAccount(input.userId);
  const now = input.now ?? new Date();
  const quote = quoteDerivative({
    kind: input.kind,
    side: input.side,
    quantityKwh: input.quantityKwh,
    strikePerKwh: input.strikePerKwh,
    spotPerKwh: input.market.pricePerKwh,
    now,
    expiresAt: input.expiresAt,
  });
  const fee = quote.premium * SIMULATOR_FEE_RATE;
  const required = quote.premium + quote.margin + fee;
  const openedAt = now.toISOString();
  const transaction = db().transaction(() => {
    const account = db().prepare("SELECT cash FROM simulator_accounts WHERE user_id = ?").get(input.userId) as { cash: number };
    if (required > account.cash) throw new Error("Insufficient virtual credits for derivative margin");
    db().prepare("UPDATE simulator_accounts SET cash = cash - ? WHERE user_id = ?").run(required, input.userId);
    const result = db().prepare(
      "INSERT INTO simulator_derivatives (user_id, kind, side, quantity_kwh, strike_per_kwh, premium, margin, opened_at, expires_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')",
    ).run(input.userId, quote.kind, quote.side, quote.quantityKwh, quote.strikePerKwh, quote.premium, quote.margin, openedAt, quote.expiresAt);
    return Number(result.lastInsertRowid);
  });
  const id = transaction();
  const position = db().prepare("SELECT * FROM simulator_derivatives WHERE id = ?").get(id) as Record<string, any>;
  return { account: getSimulatorAccount(input.userId, input.market.pricePerKwh), position: mapDerivativeRow(position) };
}

export function listDerivativePositions(userId: string, limit = 50): DerivativePosition[] {
  ensureAccount(userId);
  const rows = db().prepare(
    "SELECT * FROM simulator_derivatives WHERE user_id = ? ORDER BY id DESC LIMIT ?",
  ).all(userId, Math.min(100, Math.max(1, Math.trunc(limit)))) as Array<Record<string, any>>;
  return rows.map(mapDerivativeRow);
}

function derivativePayoff(position: DerivativePosition, settlementPricePerKwh: number): number {
  const diff = settlementPricePerKwh - position.strikePerKwh;
  let unit: number;
  if (position.kind === "future") unit = diff;
  else if (position.kind === "call") unit = Math.max(0, diff);
  else unit = Math.max(0, -diff);
  const signed = position.side === "long" ? unit : -unit;
  return signed * position.quantityKwh;
}

/**
 * Settles a single open derivative position at the given price.
 * Returns the cash credited back to the account (margin + payoff, floored at 0).
 */
export function settleDerivativePosition(input: {
  positionId: number;
  settlementPricePerKwh: number;
  now?: Date;
  liquidated?: boolean;
}): { position: DerivativePosition; cashReturned: number } {
  const now = input.now ?? new Date();
  const transaction = db().transaction(() => {
    const row = db().prepare("SELECT * FROM simulator_derivatives WHERE id = ?").get(input.positionId) as Record<string, any> | undefined;
    if (!row) throw new Error("Derivative position not found");
    const position = mapDerivativeRow(row);
    if (position.status !== "open") throw new Error("Derivative position is already closed");
    const payoff = derivativePayoff(position, input.settlementPricePerKwh);
    const cashReturned = Math.max(0, position.margin + payoff);
    const status = input.liquidated ? "liquidated" : "settled";
    db().prepare(
      "UPDATE simulator_derivatives SET status = ?, settlement_price_per_kwh = ?, settlement_value = ?, settled_at = ? WHERE id = ?",
    ).run(status, input.settlementPricePerKwh, cashReturned, now.toISOString(), position.id);
    db().prepare("UPDATE simulator_accounts SET cash = cash + ? WHERE user_id = ?").run(cashReturned, position.userId);
    const updated = db().prepare("SELECT * FROM simulator_derivatives WHERE id = ?").get(position.id) as Record<string, any>;
    return { position: mapDerivativeRow(updated), cashReturned };
  });
  return transaction();
}

/**
 * Settlement job: expires open positions whose expiry has passed and settles them
 * at the supplied market price. Also liquidates positions whose margin is breached
 * by the maintenance requirement.
 */
export function runDerivativeSettlement(input: {
  market: MarketPrice;
  now?: Date;
}): { settled: DerivativePosition[]; liquidated: DerivativePosition[] } {
  const now = input.now ?? new Date();
  const openRows = db().prepare("SELECT * FROM simulator_derivatives WHERE status = 'open' ORDER BY id ASC").all() as Array<Record<string, any>>;
  const settled: DerivativePosition[] = [];
  const liquidated: DerivativePosition[] = [];
  for (const row of openRows) {
    const position = mapDerivativeRow(row);
    const expired = new Date(position.expiresAt).getTime() <= now.getTime();
    if (expired) {
      const result = settleDerivativePosition({ positionId: position.id, settlementPricePerKwh: input.market.pricePerKwh, now });
      settled.push(result.position);
      continue;
    }
    // Maintenance check: unrealised loss must not exceed the posted margin buffer.
    const unrealised = derivativePayoff(position, input.market.pricePerKwh);
    const maintenance = position.margin * DERIVATIVE_MAINTENANCE_RATE;
    if (unrealised < -position.margin + maintenance) {
      const result = settleDerivativePosition({ positionId: position.id, settlementPricePerKwh: input.market.pricePerKwh, now, liquidated: true });
      liquidated.push(result.position);
    }
  }
  return { settled, liquidated };
}

let database: Database.Database | undefined;
let quoteCache: { value: MarketPrice; expiresAt: number } | undefined;

function db(): Database.Database {
  if (!database) {
    mkdirSync(path.dirname(DB_PATH), { recursive: true });
    database = new Database(DB_PATH);
    database.pragma("journal_mode = WAL");
    database.exec(`
      CREATE TABLE IF NOT EXISTS simulator_accounts (
        user_id TEXT PRIMARY KEY,
        cash REAL NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS simulator_trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
        quantity_kwh REAL NOT NULL,
        price_per_kwh REAL NOT NULL,
        fee REAL NOT NULL,
        executed_at TEXT NOT NULL,
        market_timestamp TEXT NOT NULL,
        market_source TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_simulator_trades_user ON simulator_trades (user_id, id DESC);
      CREATE TABLE IF NOT EXISTS simulator_market_prices (
        timestamp TEXT PRIMARY KEY,
        price_per_kwh REAL NOT NULL,
        source TEXT NOT NULL
      );
    `);
  }
  return database;
}

registerDatabase("trading-simulator", () => {
  database?.close();
  database = undefined;
});

function rememberPrices(prices: MarketPrice[]): void {
  const insert = db().prepare("INSERT OR REPLACE INTO simulator_market_prices (timestamp, price_per_kwh, source) VALUES (?, ?, ?)");
  const save = db().transaction((rows: MarketPrice[]) => {
    for (const row of rows) insert.run(row.timestamp, row.pricePerKwh, row.source);
  });
  save(prices);
}

async function fetchMarketPrices(start: Date, end: Date): Promise<MarketPrice[]> {
  const url = new URL(MARKET_URL);
  url.searchParams.set("bzn", MARKET_ZONE);
  url.searchParams.set("start", String(Math.floor(start.getTime() / 1000)));
  url.searchParams.set("end", String(Math.floor(end.getTime() / 1000)));
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`Energy market feed returned HTTP ${response.status}`);
  const payload = await response.json() as { unix_seconds?: unknown; price?: unknown };
  if (!Array.isArray(payload.unix_seconds) || !Array.isArray(payload.price)) throw new Error("Energy market feed response is invalid");
  const rows: MarketPrice[] = [];
  for (let index = 0; index < Math.min(payload.unix_seconds.length, payload.price.length); index++) {
    const epochSeconds = Number(payload.unix_seconds[index]);
    const eurosPerMwh = Number(payload.price[index]);
    if (!Number.isFinite(epochSeconds) || !Number.isFinite(eurosPerMwh)) continue;
    rows.push({
      timestamp: new Date(epochSeconds * 1000).toISOString(),
      pricePerKwh: eurosPerMwh / 1_000,
      source: "energy-charts.info",
    });
  }
  if (!rows.length) throw new Error("Energy market feed returned no usable prices");
  rememberPrices(rows);
  return rows;
}

export async function getMarketQuote(now = new Date()): Promise<MarketPrice> {
  if (quoteCache && quoteCache.expiresAt > Date.now()) return quoteCache.value;
  try {
    const prices = await fetchMarketPrices(new Date(now.getTime() - 60 * 60_000), now);
    quoteCache = { value: prices[prices.length - 1], expiresAt: Date.now() + 30_000 };
  } catch {
    const cached = db().prepare("SELECT timestamp, price_per_kwh, source FROM simulator_market_prices ORDER BY timestamp DESC LIMIT 1").get() as {
      timestamp: string; price_per_kwh: number; source: string;
    } | undefined;
    quoteCache = {
      value: cached
        ? { timestamp: cached.timestamp, pricePerKwh: cached.price_per_kwh, source: cached.source }
        : { timestamp: now.toISOString(), pricePerKwh: FALLBACK_PRICE, source: "configured-fallback" },
      expiresAt: Date.now() + 30_000,
    };
  }
  return quoteCache.value;
}

export async function getMarketHistory(hours = 24, now = new Date()): Promise<{ prices: MarketPrice[]; current: MarketPrice }> {
  const rangeHours = Math.min(24 * 7, Math.max(1, Math.trunc(hours)));
  const end = now;
  const start = new Date(now.getTime() - rangeHours * 60 * 60_000);
  try {
    await fetchMarketPrices(start, end);
  } catch {
    // Stored prices remain available when the external feed is unavailable.
  }
  const prices = db().prepare(
    "SELECT timestamp, price_per_kwh, source FROM simulator_market_prices WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC",
  ).all(start.toISOString(), end.toISOString()).map((row: any) => ({
    timestamp: row.timestamp,
    pricePerKwh: row.price_per_kwh,
    source: row.source,
  })) as MarketPrice[];
  const current = await getMarketQuote(now);
  return { prices: prices.length ? prices : [current], current };
}

function ensureAccount(userId: string): void {
  db().prepare("INSERT OR IGNORE INTO simulator_accounts (user_id, cash, created_at) VALUES (?, ?, ?)")
    .run(userId, STARTING_CREDITS, new Date().toISOString());
}

export function getSimulatorAccount(userId: string, pricePerKwh: number): SimulatorAccount {
  ensureAccount(userId);
  const account = db().prepare("SELECT cash FROM simulator_accounts WHERE user_id = ?").get(userId) as { cash: number };
  const holdings = db().prepare(
    "SELECT COALESCE(SUM(CASE WHEN side = 'buy' THEN quantity_kwh ELSE -quantity_kwh END), 0) AS energy FROM simulator_trades WHERE user_id = ?",
  ).get(userId) as { energy: number };
  const energyKwh = Math.max(0, holdings.energy);
  const marketValue = energyKwh * pricePerKwh;
  return {
    userId,
    cash: account.cash,
    energyKwh,
    marketValue,
    totalValue: account.cash + marketValue,
    pnl: account.cash + marketValue - STARTING_CREDITS,
  };
}

export function listSimulatorTrades(userId: string, limit = 50): SimulatorTrade[] {
  ensureAccount(userId);
  const rows = db().prepare(
    "SELECT id, user_id, side, quantity_kwh, price_per_kwh, fee, executed_at FROM simulator_trades WHERE user_id = ? ORDER BY id DESC LIMIT ?",
  ).all(userId, Math.min(100, Math.max(1, Math.trunc(limit)))) as Array<Record<string, any>>;
  return rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    side: row.side,
    quantityKwh: row.quantity_kwh,
    pricePerKwh: row.price_per_kwh,
    fee: row.fee,
    executedAt: row.executed_at,
  }));
}

export function executeSimulatorTrade(input: {
  userId: string;
  side: "buy" | "sell";
  quantityKwh: number;
  market: MarketPrice;
}): { account: SimulatorAccount; trade: SimulatorTrade } {
  ensureAccount(input.userId);
  const quantity = Math.round(input.quantityKwh * 1_000) / 1_000;
  if (quantity <= 0) throw new Error("Trade quantity must be at least 0.001 kWh");
  const gross = quantity * input.market.pricePerKwh;
  const fee = Math.abs(gross) * SIMULATOR_FEE_RATE;
  const executedAt = new Date().toISOString();
  const transaction = db().transaction(() => {
    const account = db().prepare("SELECT cash FROM simulator_accounts WHERE user_id = ?").get(input.userId) as { cash: number };
    const holdings = db().prepare(
      "SELECT COALESCE(SUM(CASE WHEN side = 'buy' THEN quantity_kwh ELSE -quantity_kwh END), 0) AS energy FROM simulator_trades WHERE user_id = ?",
    ).get(input.userId) as { energy: number };
    if (input.side === "buy" && gross + fee > account.cash) throw new Error("Insufficient virtual credits");
    if (input.side === "sell" && quantity > holdings.energy + 1e-9) throw new Error("Insufficient virtual energy holdings");
    const cashDelta = input.side === "buy" ? -(gross + fee) : gross - fee;
    if (account.cash + cashDelta < -1e-9) throw new Error("Insufficient virtual credits for this trade");
    db().prepare("UPDATE simulator_accounts SET cash = cash + ? WHERE user_id = ?").run(cashDelta, input.userId);
    const result = db().prepare(
      "INSERT INTO simulator_trades (user_id, side, quantity_kwh, price_per_kwh, fee, executed_at, market_timestamp, market_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(input.userId, input.side, quantity, input.market.pricePerKwh, fee, executedAt, input.market.timestamp, input.market.source);
    return Number(result.lastInsertRowid);
  });
  const id = transaction();
  const trade: SimulatorTrade = {
    id,
    userId: input.userId,
    side: input.side,
    quantityKwh: quantity,
    pricePerKwh: input.market.pricePerKwh,
    fee,
    executedAt,
  };
  return { account: getSimulatorAccount(input.userId, input.market.pricePerKwh), trade };
}

export function getSimulatorLeaderboard(pricePerKwh: number, limit = 20): SimulatorAccount[] {
  const users = db().prepare("SELECT user_id FROM simulator_accounts ORDER BY created_at ASC LIMIT 1000").all() as Array<{ user_id: string }>;
  return users
    .map(({ user_id }) => getSimulatorAccount(user_id, pricePerKwh))
    .sort((left, right) => right.totalValue - left.totalValue)
    .slice(0, Math.min(100, Math.max(1, Math.trunc(limit))));
}