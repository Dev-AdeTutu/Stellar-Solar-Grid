/**
 * #1159: a bot that is not allowed to execute must never trade, however large the profit.
 *
 * The issue describes an undocumented override that turns a dry run into live execution above a
 * 10x profit threshold. The code has no dry-run mode and no such override: execution is gated by
 * `enabled && autoExecute` and by the risk limits. These tests pin that, across profits both side
 * of 10x, so an override cannot be added unnoticed.
 */
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { initArbitrageBot, executeTrade, getUserConfig, updateUserConfig } = await import("../src/lib/arbitrageBot.js");

const USER = "user-1";
const MAX_TRADE = 100; // default maxTradeAmount
const NO_RISK_CAP = 1e12; // lifts the per-trade limit, so only the auto-execute gate is under test

let db: Database.Database;

function addOpportunity(id: string, estimatedProfit: number) {
  db.prepare(
    `INSERT INTO arbitrage_opportunities
       (id, buy_market, sell_market, asset, buy_price, sell_price, spread_percent, estimated_profit, volume, detected_at, expires_at)
     VALUES (?, 'a', 'b', 'XLM', 1, 1.5, 50, ?, 10, ?, ?)`,
  ).run(id, estimatedProfit, Date.now(), Date.now() + 60_000);
}

const tradeCount = () => (db.prepare("SELECT COUNT(*) AS n FROM arbitrage_trades").get() as { n: number }).n;
const executedFlag = (id: string) =>
  (db.prepare("SELECT executed FROM arbitrage_opportunities WHERE id = ?").get(id) as { executed: number }).executed;

beforeEach(() => {
  db = new Database(":memory:");
  initArbitrageBot(db);
  // The simulated venue succeeds when random() > 0.1, and ids embed random(): vary it, always above 0.1.
  let n = 0;
  vi.spyOn(Math, "random").mockImplementation(() => 0.5 + (n++ % 40) / 100);
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

describe("a bot that is not allowed to auto-execute never trades", () => {
  // Profit as a multiple of the per-trade limit: well under, at, just over and far over 10x.
  const multiples = [0.5, 1, 9, 10, 11, 100, 10_000];

  it.each(multiples)("autoExecute off: profit of %sx the trade limit executes nothing", async (multiple) => {
    updateUserConfig(USER, { enabled: true, autoExecute: false, maxTradeAmount: NO_RISK_CAP });
    addOpportunity("opp", MAX_TRADE * multiple);

    const result = await executeTrade(USER, "opp");

    expect(result).toEqual({ success: false, trades: [] });
    expect(tradeCount()).toBe(0);
    expect(executedFlag("opp")).toBe(0);
  });

  it.each(multiples)("bot disabled: profit of %sx the trade limit executes nothing", async (multiple) => {
    updateUserConfig(USER, { enabled: false, autoExecute: true, maxTradeAmount: NO_RISK_CAP });
    addOpportunity("opp", MAX_TRADE * multiple);

    const result = await executeTrade(USER, "opp");

    expect(result).toEqual({ success: false, trades: [] });
    expect(tradeCount()).toBe(0);
  });

  it("a brand new user (all defaults) cannot execute", async () => {
    addOpportunity("opp", 1_000_000);

    expect(await executeTrade("someone-new", "opp")).toEqual({ success: false, trades: [] });
    expect(tradeCount()).toBe(0);
    expect(getUserConfig("someone-new")).toMatchObject({ enabled: false, autoExecute: false });
  });

  it("does not execute for one user because another has auto-execute on", async () => {
    updateUserConfig("other", { enabled: true, autoExecute: true });
    updateUserConfig(USER, { enabled: true, autoExecute: false });
    addOpportunity("opp", 5);

    expect(await executeTrade(USER, "opp")).toEqual({ success: false, trades: [] });
    expect(tradeCount()).toBe(0);
  });
});

describe("a profit far above the limit is blocked, not promoted", () => {
  it("auto-execute on: a profit over the per-trade limit is refused by the risk limits", async () => {
    updateUserConfig(USER, { enabled: true, autoExecute: true });
    addOpportunity("huge", MAX_TRADE * 11);

    const result = await executeTrade(USER, "huge");

    expect(result).toEqual({ success: false, trades: [] });
    expect(tradeCount()).toBe(0);
  });
});

describe("the same setup does trade when it is allowed to (so the tests above can fail)", () => {
  it("auto-execute on and within limits: both legs are recorded", async () => {
    updateUserConfig(USER, { enabled: true, autoExecute: true });
    addOpportunity("ok", 5);

    const result = await executeTrade(USER, "ok");

    expect(result.success).toBe(true);
    expect(result.trades.map((t) => t.type)).toEqual(["buy", "sell"]);
    expect(tradeCount()).toBe(2);
    expect(executedFlag("ok")).toBe(1);
  });
});
