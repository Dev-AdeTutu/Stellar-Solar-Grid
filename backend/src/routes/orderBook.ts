/**
 * Energy market order book (#935).
 *
 *   GET /api/orderbook?tick=0.01&levels=20  aggregated bids/asks, cumulative depth, recent trades
 *   WS  /api/orderbook/ws                   pushes a snapshot whenever the book changes
 */
import { Router } from "express";
import type { Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { getOpenOffers, getRecentMatches, getOffer } from "../lib/p2pTrading.js";

export const orderBookRouter = Router();

type Level = { price: number; kwh: number; cumulative: number };

function aggregate(
  prices: { pricePerKwh: number; energyKwh: number; remainingKwh?: number }[],
  tick: number,
  desc: boolean,
  max: number,
): Level[] {
  const byLevel = new Map<number, number>();
  for (const o of prices) {
    const p = Number((Math.round(o.pricePerKwh / tick) * tick).toFixed(8));
    byLevel.set(p, (byLevel.get(p) ?? 0) + (o.remainingKwh ?? o.energyKwh));
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

/**
 * Per-offer row lock (SELECT ... FOR UPDATE equivalent, #1117). Fill requests for the
 * same offer are serialized so the remaining quantity is re-read only after the
 * previous fill commits, preventing over-fills from concurrent partial fills.
 */
const offerLocks = new Map<string, Promise<unknown>>();
export async function withOfferLock<T>(offerId: string, fn: () => T | Promise<T>): Promise<T> {
  const prev = offerLocks.get(offerId) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  const tail = run.catch(() => undefined);
  offerLocks.set(offerId, tail);
  tail.then(() => { if (offerLocks.get(offerId) === tail) offerLocks.delete(offerId); });
  return run;
}

export function fillOffer(offerId: string, kwh: number) {
  return withOfferLock(offerId, () => {
    const offer = getOffer(offerId);
    if (!offer) throw Object.assign(new Error("Offer not found"), { status: 404 });
    if (offer.status !== "open" || offer.remainingKwh <= 0)
      throw Object.assign(new Error("Offer is not open"), { status: 409 });
    if (kwh > offer.remainingKwh)
      throw Object.assign(new Error(`Only ${offer.remainingKwh} kWh remaining`), { status: 409 });
    offer.remainingKwh = Number((offer.remainingKwh - kwh).toFixed(4));
    if (offer.remainingKwh <= 0) { offer.remainingKwh = 0; offer.status = "matched"; }
    return { offerId, filledKwh: kwh, remainingKwh: offer.remainingKwh, status: offer.status };
  });
}

orderBookRouter.post("/:offerId/fill", async (req, res) => {
  const kwh = Number(req.body?.kwh);
  if (!Number.isFinite(kwh) || kwh <= 0) return res.status(400).json({ error: "kwh must be a positive number" });
  try {
    res.json(await fillOffer(req.params.offerId, kwh));
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: err.message });
  }
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
