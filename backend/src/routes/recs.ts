/**
 * Renewable Energy Credit (REC) marketplace API (#927).
 *
 *   GET  /api/recs/market                — price discovery snapshot + totals
 *   GET  /api/recs                        — all credits
 *   POST /api/recs/issue                  — issue a credit for metered generation
 *   GET  /api/recs/:recId                 — one credit
 *   POST /api/recs/:recId/verify          — compliance authority attests
 *   POST /api/recs/:recId/reject          — compliance authority rejects
 *   GET  /api/recs/:recId/orders          — order book (?side=sell|buy)
 *   POST /api/recs/:recId/list            — post a sell order
 *   POST /api/recs/:recId/bid             — post a buy order
 *   GET  /api/recs/:recId/trades          — settled trades
 *   POST /api/recs/orders/:orderId/cancel — cancel an open order
 *   POST /api/recs/orders/:orderId/execute— match a bid and settle
 *   GET  /api/recs/producer/:producerId   — a producer's credits
 *   GET  /api/recs/holder/:holderId       — a holder's unit balances
 */
import { Router, Request, Response } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireAdminKey } from "../middleware/adminAuth.js";
import {
  DEFAULT_REC_FEE_BPS,
  cancelOrder,
  executeTrade,
  getHoldings,
  getMarketSummary,
  getRec,
  listAllRecs,
  listRecOrders,
  listRecsByProducer,
  listTrades,
  placeBid,
  issueRec,
  listRecs,
  rejectRec,
  verifyRec,
  type RecSide,
} from "../lib/recs.js";

export const recsRouter = Router();

const RecId = z.string().min(1).max(128);
const OrderId = z.string().min(1).max(128);
const PartyId = z.string().min(1).max(128);

const IssueBody = z.object({
  producerId: z.string().min(1),
  meterId: z.string().min(1),
  kwhGenerated: z.number().positive(),
  vintage: z.number().int().min(1900).max(2200).optional(),
  registryRef: z.string().min(1),
});

const VerifyBody = z.object({ complianceRef: z.string().min(1) });
const RejectBody = z.object({ actorId: z.string().min(1) });

const OrderBody = z.object({
  ownerId: z.string().min(1),
  units: z.number().int().positive(),
  priceMicro: z.number().positive(),
});

const ExecuteBody = z.object({
  buyerId: z.string().min(1),
  feeBps: z.number().int().min(0).max(1000).optional(),
});

const OrdersQuery = z.object({ side: z.enum(["sell", "buy"]).default("sell") });

function validationError(res: Response, error: z.ZodError) {
  return res.status(400).json({ error: "Invalid request", code: "VALIDATION_ERROR", details: error.flatten() });
}

/** Map a domain `code` to the matching HTTP status. */
function domainError(res: Response, err: unknown) {
  const code = (err as { code?: string }).code;
  const message = err instanceof Error ? err.message : "Request failed";
  if (code === "NOT_FOUND") return res.status(404).json({ error: message });
  if (code === "FORBIDDEN") return res.status(403).json({ error: message });
  if (code === "CONFLICT") return res.status(409).json({ error: message });
  return res.status(400).json({ error: message, code });
}

recsRouter.get(
  "/market",
  asyncHandler(async (_req: Request, res: Response) => {
    res.json(getMarketSummary());
  }),
);

recsRouter.get(
  "/",
  asyncHandler(async (_req: Request, res: Response) => {
    const credits = listAllRecs();
    res.json({ recs: credits, count: credits.length });
  }),
);

recsRouter.post(
  "/issue",
  requireAdminKey,
  asyncHandler(async (req: Request, res: Response) => {
    const body = IssueBody.safeParse(req.body);
    if (!body.success) return validationError(res, body.error);
    try {
      res.status(201).json(issueRec(body.data));
    } catch (err) {
      return domainError(res, err);
    }
  }),
);

recsRouter.get(
  "/producer/:producerId",
  asyncHandler(async (req: Request, res: Response) => {
    const producer = PartyId.safeParse(req.params.producerId);
    if (!producer.success) return res.status(400).json({ error: "producerId is required" });
    res.json({ recs: listRecsByProducer(producer.data) });
  }),
);

recsRouter.get(
  "/holder/:holderId",
  asyncHandler(async (req: Request, res: Response) => {
    const holder = PartyId.safeParse(req.params.holderId);
    if (!holder.success) return res.status(400).json({ error: "holderId is required" });
    res.json({ holdings: getHoldings(holder.data) });
  }),
);

recsRouter.post(
  "/orders/:orderId/cancel",
  asyncHandler(async (req: Request, res: Response) => {
    const order = OrderId.safeParse(req.params.orderId);
    if (!order.success) return res.status(400).json({ error: "orderId is required" });
    const body = z.object({ requesterId: z.string().min(1) }).safeParse(req.body);
    if (!body.success) return validationError(res, body.error);
    try {
      res.json(cancelOrder(order.data, body.data.requesterId));
    } catch (err) {
      return domainError(res, err);
    }
  }),
);

recsRouter.post(
  "/orders/:orderId/execute",
  asyncHandler(async (req: Request, res: Response) => {
    const order = OrderId.safeParse(req.params.orderId);
    if (!order.success) return res.status(400).json({ error: "orderId is required" });
    const body = ExecuteBody.safeParse(req.body);
    if (!body.success) return validationError(res, body.error);
    try {
      const executed = executeTrade(body.data.buyerId, order.data, body.data.feeBps ?? DEFAULT_REC_FEE_BPS);
      res.json({ trades: executed, count: executed.length });
    } catch (err) {
      return domainError(res, err);
    }
  }),
);

recsRouter.get(
  "/:recId",
  asyncHandler(async (req: Request, res: Response) => {
    const rec = RecId.safeParse(req.params.recId);
    if (!rec.success) return res.status(400).json({ error: "recId is required" });
    const found = getRec(rec.data);
    if (!found) return res.status(404).json({ error: "REC not found" });
    res.json(found);
  }),
);

recsRouter.post(
  "/:recId/verify",
  asyncHandler(async (req: Request, res: Response) => {
    const rec = RecId.safeParse(req.params.recId);
    if (!rec.success) return res.status(400).json({ error: "recId is required" });
    const body = VerifyBody.safeParse(req.body);
    if (!body.success) return validationError(res, body.error);
    try {
      res.json(verifyRec(rec.data, body.data.complianceRef));
    } catch (err) {
      return domainError(res, err);
    }
  }),
);

recsRouter.post(
  "/:recId/reject",
  asyncHandler(async (req: Request, res: Response) => {
    const rec = RecId.safeParse(req.params.recId);
    if (!rec.success) return res.status(400).json({ error: "recId is required" });
    const body = RejectBody.safeParse(req.body);
    if (!body.success) return validationError(res, body.error);
    try {
      res.json(rejectRec(rec.data));
    } catch (err) {
      return domainError(res, err);
    }
  }),
);

recsRouter.get(
  "/:recId/orders",
  asyncHandler(async (req: Request, res: Response) => {
    const rec = RecId.safeParse(req.params.recId);
    if (!rec.success) return res.status(400).json({ error: "recId is required" });
    const query = OrdersQuery.safeParse(req.query);
    if (!query.success) return validationError(res, query.error);
    if (!getRec(rec.data)) return res.status(404).json({ error: "REC not found" });
    const orders = listRecOrders(rec.data, query.data.side as RecSide);
    res.json({ side: query.data.side, orders, count: orders.length });
  }),
);

recsRouter.post(
  "/:recId/list",
  asyncHandler(async (req: Request, res: Response) => {
    const rec = RecId.safeParse(req.params.recId);
    if (!rec.success) return res.status(400).json({ error: "recId is required" });
    const body = OrderBody.safeParse(req.body);
    if (!body.success) return validationError(res, body.error);
    try {
      res.status(201).json(listRecs({ sellerId: body.data.ownerId, recId: rec.data, units: body.data.units, priceMicro: body.data.priceMicro }));
    } catch (err) {
      return domainError(res, err);
    }
  }),
);

recsRouter.post(
  "/:recId/bid",
  asyncHandler(async (req: Request, res: Response) => {
    const rec = RecId.safeParse(req.params.recId);
    if (!rec.success) return res.status(400).json({ error: "recId is required" });
    const body = OrderBody.safeParse(req.body);
    if (!body.success) return validationError(res, body.error);
    try {
      res.status(201).json(placeBid({ buyerId: body.data.ownerId, recId: rec.data, units: body.data.units, priceMicro: body.data.priceMicro }));
    } catch (err) {
      return domainError(res, err);
    }
  }),
);

recsRouter.get(
  "/:recId/trades",
  asyncHandler(async (req: Request, res: Response) => {
    const rec = RecId.safeParse(req.params.recId);
    if (!rec.success) return res.status(400).json({ error: "recId is required" });
    if (!getRec(rec.data)) return res.status(404).json({ error: "REC not found" });
    const recTrades = listTrades(rec.data);
    res.json({ trades: recTrades, count: recTrades.length });
  }),
);
