// Simple test runner: exit 0 on pass, 1 on fail
import assert from "node:assert/strict";
import { AlgoRunner, backtest, execute, strategies, type Tick } from "../src/algo/engine.js";

const ticks: Tick[] = Array.from({ length: 48 }, (_, i) => ({
  ts: `t${i}`,
  price: 10 + 3 * Math.sin(i / 3),
  supplyKwh: 5 + (i % 6),
  demandKwh: 7,
}));

try {
  // Execution never overspends cash or oversells inventory
  const pos = { kwh: 0, cash: 5 };
  assert.equal(execute({ side: "sell", kwh: 1 }, ticks[0], pos), null);
  const t = execute({ side: "buy", kwh: 10 }, { ...ticks[0], price: 1 }, pos)!;
  assert.equal(t.kwh, 5);
  assert.equal(pos.cash, 0);

  for (const name of Object.keys(strategies)) {
    const { metrics, position } = backtest(strategies[name], ticks);
    assert.ok(metrics.trades > 0, `${name} trades`);
    assert.ok(position.cash >= 0 && position.kwh >= 0, `${name} solvent`);
    assert.ok(metrics.maxDrawdown >= 0 && metrics.maxDrawdown <= 1);
  }

  const seen: string[] = [];
  const runner = new AlgoRunner((algo, sub) => seen.push(`${algo}:${sub}`));
  runner.subscribe("peak-shaver", "GUSER", 100);
  ticks.forEach((tk) => runner.onTick(tk));
  assert.ok(seen.length > 0 && seen.every((s) => s === "peak-shaver:GUSER"));
  console.log("algoEngine tests passed");
} catch (e) {
  console.error(e);
  process.exitCode = 1;
}
