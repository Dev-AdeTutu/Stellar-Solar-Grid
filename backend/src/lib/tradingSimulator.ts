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