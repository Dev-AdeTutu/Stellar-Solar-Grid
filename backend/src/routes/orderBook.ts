/**
 * Energy market order book (#935).
 *
 *   GET /api/orderbook?tick=0.01&levels=20  aggregated bids/asks, cumulative depth, recent trades
 *   WS  /api/orderbook/ws                   pushes a snapshot whenever the book changes
 */
import { Router } from "express";
import type { Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { getOpenOffers, getRecentMatches } from "../lib/p2pTrading.js";

export const orderBookRouter = Router();

type Level = { price: number; kwh: number; cumulative: number };

function aggregate(prices: { pricePerKwh: number; energyKwh: number }[], tick: number, desc: boolean, max: number): Level[] {
  const byLevel = new Map<number, number>();
  for (const o of prices) {
    const p = Number((Math.round(o.pricePerKwh / tick) * tick).toFixed(8));
    byLevel.set(p, (byLevel.get(p) ?? 0) + o.energyKwh);
  }
  let cumulative = 0;
  return [...byLevel.entries()]
    .sort((a, b) => (desc ? b[0] - a[0] : a[0] - b[0]))
    .slice(0, max)
    .map(([price, kwh]) => ({ price, kwh, cumulative: (cumulative += kwh) }));
}

export function buildSnapshot(tick = 0.01, levels = 20) {
  const bids = aggregate(getOpenOffers("buy"), tick, true, levels);
  const asks = aggregate(getOpenOffers("sell"), tick, false, levels);
  const trades = getRecentMatches(30).map((m) => ({
    id: m.id,
    price: m.pricePerKwh,
    kwh: m.energyKwh,
    time: m.matchedAt,
  }));
  return { bids, asks, spread: bids[0] && asks[0] ? Number((asks[0].price - bids[0].price).toFixed(8)) : null, trades };
}

function parseParams(tickRaw: unknown, levelsRaw: unknown) {
  const tick = Number(tickRaw);
  const levels = Number(levelsRaw);
  return {
    tick: Number.isFinite(tick) && tick > 0 ? tick : 0.01,
    levels: Number.isInteger(levels) && levels > 0 ? Math.min(levels, 100) : 20,
  };
}

orderBookRouter.get("/", (req, res) => {
  const { tick, levels } = parseParams(req.query.tick, req.query.levels);
  res.json(buildSnapshot(tick, levels));
});

/** Attach the public WebSocket feed; snapshots are pushed only when the book changed. */
export function attachOrderBookWebSocket(server: Server) {
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "", "http://localhost");
    if (url.pathname !== "/api/orderbook/ws") return;
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });
  let last = "";
  setInterval(() => {
    if (wss.clients.size === 0) return;
    const msg = JSON.stringify(buildSnapshot());
    if (msg === last) return;
    last = msg;
    wss.clients.forEach((c) => c.readyState === WebSocket.OPEN && c.send(msg));
  }, 50).unref();
  wss.on("connection", (ws) => ws.send(JSON.stringify(buildSnapshot())));
}
