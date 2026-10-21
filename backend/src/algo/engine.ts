/**
 * Off-chain execution + backtesting framework for marketplace trading
 * algorithms (see contracts/ALGO_MARKETPLACE.md). Strategies are pure
 * functions of a market tick, so the same code runs live and in backtests.
 */

export type Tick = { ts: string; price: number; supplyKwh: number; demandKwh: number };
export type Signal = { side: "buy" | "sell" | "hold"; kwh: number };
export type Position = { kwh: number; cash: number };
export type Strategy = (tick: Tick, history: Tick[], pos: Position) => Signal;

export const strategies: Record<string, Strategy> = {
  /** Buy when price is below its moving average, sell above. */
  "mean-reversion": (t, h) => {
    const w = h.slice(-24);
    if (w.length < 5) return { side: "hold", kwh: 0 };
    const avg = w.reduce((s, x) => s + x.price, 0) / w.length;
    if (t.price < avg * 0.95) return { side: "buy", kwh: 1 };
    if (t.price > avg * 1.05) return { side: "sell", kwh: 1 };
    return { side: "hold", kwh: 0 };
  },
  /** Sell surplus when supply exceeds demand, buy into shortfalls. */
  "peak-shaver": (t, _h, pos) => {
    const gap = t.supplyKwh - t.demandKwh;
    if (gap > 0) return { side: "buy", kwh: Math.min(gap, 5) };
    if (gap < 0 && pos.kwh > 0) return { side: "sell", kwh: Math.min(-gap, pos.kwh) };
    return { side: "hold", kwh: 0 };
  },
};

export type Trade = { ts: string; side: "buy" | "sell"; kwh: number; price: number };

export type Metrics = {
  trades: number;
  pnl: number;
  returnPct: number;
  winRate: number;
  maxDrawdown: number;
};

/** Apply one signal to a position; returns the executed trade, if any. */
export function execute(sig: Signal, tick: Tick, pos: Position): Trade | null {
  if (sig.side === "hold" || sig.kwh <= 0) return null;
  const kwh = sig.side === "buy" ? Math.min(sig.kwh, pos.cash / tick.price) : Math.min(sig.kwh, pos.kwh);
  if (kwh <= 0) return null;
  const sign = sig.side === "buy" ? 1 : -1;
  pos.kwh += sign * kwh;
  pos.cash -= sign * kwh * tick.price;
  return { ts: tick.ts, side: sig.side, kwh, price: tick.price };
}

export function backtest(strategy: Strategy, ticks: Tick[], startingCash = 1_000) {
  const pos: Position = { kwh: 0, cash: startingCash };
  const trades: Trade[] = [];
  let peak = startingCash;
  let maxDrawdown = 0;
  let wins = 0;
  let sells = 0;
  let costBasis = 0;

  ticks.forEach((tick, i) => {
    const t = execute(strategy(tick, ticks.slice(0, i), pos), tick, pos);
    if (t) {
      trades.push(t);
      if (t.side === "buy") costBasis = t.price;
      else {
        sells += 1;
        if (t.price > costBasis) wins += 1;
      }
    }
    const equity = pos.cash + pos.kwh * tick.price;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
  });

  const last = ticks[ticks.length - 1]?.price ?? 0;
  const pnl = pos.cash + pos.kwh * last - startingCash;
  const metrics: Metrics = {
    trades: trades.length,
    pnl,
    returnPct: (pnl / startingCash) * 100,
    winRate: sells ? wins / sells : 0,
    maxDrawdown,
  };
  return { trades, metrics, position: pos };
}

/** Live runner: feeds each tick to every subscribed strategy and reports trades. */
export class AlgoRunner {
  private history: Tick[] = [];
  private positions = new Map<string, Position>();

  constructor(private onTrade: (algoKey: string, subscriber: string, trade: Trade) => void) {}

  subscribe(algoKey: string, subscriber: string, cash: number) {
    this.positions.set(`${algoKey}:${subscriber}`, { kwh: 0, cash });
  }

  onTick(tick: Tick) {
    for (const [key, pos] of this.positions) {
      const [algoKey, subscriber] = key.split(":");
      const strategy = strategies[algoKey];
      if (!strategy) continue;
      const trade = execute(strategy(tick, this.history, pos), tick, pos);
      if (trade) this.onTrade(algoKey, subscriber, trade);
    }
    this.history.push(tick);
    if (this.history.length > 1_000) this.history.shift();
  }
}
