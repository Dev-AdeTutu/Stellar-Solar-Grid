import { Router, Request, Response, NextFunction } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "http";
import * as keys from "../lib/apiKeys.js";
import { requireAdminKey } from "../middleware/adminAuth.js";

export const tradingRouter = Router();

interface Order { id: string; owner: string; side: "buy" | "sell"; kwh: number; price: number; createdAt: number }
const orders: Order[] = [];
let wss: WebSocketServer | null = null;

function broadcast(event: string, data: unknown) {
  if (!wss) return;
  const msg = JSON.stringify({ event, data });
  wss.clients.forEach((c) => c.readyState === WebSocket.OPEN && c.send(msg));
}

function requireApiKey(req: Request, res: Response, next: NextFunction) {
  const raw = String(req.headers["x-api-key"] ?? "");
  const r = keys.checkAndCount(raw);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  res.locals.owner = r.key.owner;
  next();
}

// Per-key burst limit suited to bots (default 20 req/s).
const botLimiter = rateLimit({
  windowMs: 1000,
  limit: Number(process.env.BOT_RATE_LIMIT_PER_SEC ?? 20),
  keyGenerator: (req) => String(req.headers["x-api-key"] ?? req.ip),
  standardHeaders: true,
  legacyHeaders: false,
});

// ── Key management ────────────────────────────────────────────────────────────
tradingRouter.post("/keys", requireAdminKey, (req, res) => {
  const p = z.object({ owner: z.string().min(1), dailyQuota: z.number().int().positive().optional() }).safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: p.error.issues });
  res.status(201).json(keys.createKey(p.data.owner, p.data.dailyQuota));
});

tradingRouter.post("/keys/rotate", (req, res) => {
  const out = keys.rotateKey(String(req.headers["x-api-key"] ?? ""));
  if (!out) return res.status(401).json({ error: "Invalid API key" });
  res.json({ ...out, note: "Previous key remains valid for 24h" });
});

tradingRouter.delete("/keys", (req, res) => {
  res.status(keys.revokeKey(String(req.headers["x-api-key"] ?? "")) ? 204 : 404).end();
});

tradingRouter.get("/usage", requireAdminKey, (_req, res) => res.json(keys.usageStats()));

// ── Trading ───────────────────────────────────────────────────────────────────
const orderSchema = z.object({ side: z.enum(["buy", "sell"]), kwh: z.number().positive(), price: z.number().positive() });

tradingRouter.get("/orderbook", botLimiter, requireApiKey, (_req, res) => {
  res.json({
    bids: orders.filter((o) => o.side === "buy").sort((a, b) => b.price - a.price),
    asks: orders.filter((o) => o.side === "sell").sort((a, b) => a.price - b.price),
  });
});

tradingRouter.post("/orders", botLimiter, requireApiKey, (req, res) => {
  const p = orderSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: p.error.issues });
  const order: Order = { id: crypto.randomUUID(), owner: res.locals.owner, createdAt: Date.now(), ...p.data };
  orders.push(order);
  broadcast("order.created", order);
  res.status(201).json(order);
});

tradingRouter.delete("/orders/:id", botLimiter, requireApiKey, (req, res) => {
  const i = orders.findIndex((o) => o.id === req.params.id && o.owner === res.locals.owner);
  if (i < 0) return res.status(404).json({ error: "Order not found" });
  const [o] = orders.splice(i, 1);
  broadcast("order.cancelled", o);
  res.status(204).end();
});

// ── Derivatives ───────────────────────────────────────────────────────────────
interface DerivativePosition {
  id: string;
  owner: string;
  kind: "future" | "call" | "put";
  side: "long" | "short";
  quantity: number;
  strike: number;
  margin: number;
  status: "open" | "settled" | "liquidated";
  createdAt: number;
  expiry: number;
  settlementPrice?: number;
  payout?: number;
}
const derivatives: DerivativePosition[] = [];

const derivativeSchema = z.object({
  kind: z.enum(["future", "call", "put"]),
  side: z.enum(["long", "short"]),
  quantity: z.number().positive(),
  strike: z.number().positive(),
  margin: z.number().nonnegative(),
  expiry: z.number().int().positive(),
});

tradingRouter.get("/derivatives", botLimiter, requireApiKey, (_req, res) => {
  res.json(derivatives.filter((d) => d.owner === res.locals.owner));
});

tradingRouter.post("/derivatives", botLimiter, requireApiKey, (req, res) => {
  const p = derivativeSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: p.error.issues });
  const position: DerivativePosition = {
    id: crypto.randomUUID(),
    owner: res.locals.owner,
    status: "open",
    createdAt: Date.now(),
    ...p.data,
  };
  derivatives.push(position);
  broadcast("derivative.created", position);
  res.status(201).json(position);
});

tradingRouter.post("/derivatives/:id/settle", botLimiter, requireApiKey, (req, res) => {
  const p = z.object({ settlementPrice: z.number().positive() }).safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: p.error.issues });
  const position = derivatives.find((d) => d.id === req.params.id && d.owner === res.locals.owner);
  if (!position) return res.status(404).json({ error: "Position not found" });
  if (position.status !== "open") return res.status(409).json({ error: "Position already closed" });
  const price = p.data.settlementPrice;
  let payout = 0;
  if (position.kind === "future") {
    payout = (price - position.strike) * position.quantity * (position.side === "long" ? 1 : -1);
  } else if (position.kind === "call") {
    payout = Math.max(price - position.strike, 0) * position.quantity * (position.side === "long" ? 1 : -1);
  } else {
    payout = Math.max(position.strike - price, 0) * position.quantity * (position.side === "long" ? 1 : -1);
  }
  position.status = "settled";
  position.settlementPrice = price;
  position.payout = payout;
  broadcast("derivative.settled", position);
  res.json(position);
});

tradingRouter.get("/derivatives/margin", botLimiter, requireApiKey, (_req, res) => {
  const open = derivatives.filter((d) => d.owner === res.locals.owner && d.status === "open");
  const required = open.reduce((sum, d) => sum + d.strike * d.quantity * 0.1, 0);
  const posted = open.reduce((sum, d) => sum + d.margin, 0);
  res.json({ required, posted, shortfall: Math.max(required - posted, 0), positions: open.length });
});

/** Attach WebSocket feed at /api/trading/ws (auth via ?apiKey=). */
export function attachTradingWebSocket(server: Server) {
  wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "", "http://localhost");
    if (url.pathname !== "/api/trading/ws") return;
    if (!keys.checkAndCount(url.searchParams.get("apiKey") ?? "").ok) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return socket.destroy();
    }
    wss!.handleUpgrade(req, socket, head, (ws) => wss!.emit("connection", ws, req));
  });
}
