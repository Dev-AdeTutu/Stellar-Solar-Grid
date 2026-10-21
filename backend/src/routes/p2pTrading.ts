/**
 * Peer-to-peer energy trading API (#879).
 *
 *   GET  /api/p2p/stats                         — trading volume stats
 *   GET  /api/p2p/offers                        — open offers (filter: ?direction=sell|buy)
 *   POST /api/p2p/offers                        — create a sell or buy offer
 *   GET  /api/p2p/offers/:id                    — get a single offer
 *   DELETE /api/p2p/offers/:id                  — cancel an offer
 *   GET  /api/p2p/user/:userId/offers           — user's own offers
 *   GET  /api/p2p/user/:userId/matches          — user's trade matches
 *   POST /api/p2p/match                         — run matching algorithm (admin)
 *   GET  /api/p2p/matches/:id                   — get a match
 *   POST /api/p2p/matches/:id/settle            — settle a match
 *   POST /api/p2p/matches/:id/dispute           — raise a dispute
 */
import { Router, Request, Response } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireAdminKey } from "../middleware/adminAuth.js";
import {
  createOffer,
  cancelOffer,
  getOpenOffers,
  getOffer,
  getUserOffers,
  getUserMatches,
  runMatchingAlgorithm,
  settleMatch,
  raiseDispute,
  getMatch,
  getTradingStats,
} from "../lib/p2pTrading.js";

export const p2pTradingRouter = Router();

p2pTradingRouter.get(
  "/stats",
  asyncHandler(async (_req: Request, res: Response) => {
    res.json(getTradingStats());
  }),
);

p2pTradingRouter.get(
  "/offers",
  asyncHandler(async (req: Request, res: Response) => {
    const dir = req.query.direction as "sell" | "buy" | undefined;
    if (dir && dir !== "sell" && dir !== "buy") {
      return res.status(400).json({ error: "direction must be sell or buy" });
    }
    res.json({ offers: getOpenOffers(dir) });
  }),
);

p2pTradingRouter.post(
  "/offers",
  asyncHandler(async (req: Request, res: Response) => {
    const { userId, direction, energyKwh, pricePerKwh, minKwh, ttlMs, meterId, location } =
      req.body as {
        userId?: string;
        direction?: string;
        energyKwh?: number;
        pricePerKwh?: number;
        minKwh?: number;
        ttlMs?: number;
        meterId?: string;
        location?: string;
      };

    if (!userId) return res.status(400).json({ error: "userId is required" });
    if (direction !== "sell" && direction !== "buy") {
      return res.status(400).json({ error: "direction must be sell or buy" });
    }
    const kwh = Number(energyKwh);
    const price = Number(pricePerKwh);
    if (!Number.isFinite(kwh) || kwh <= 0) {
      return res.status(400).json({ error: "energyKwh must be a positive number" });
    }
    if (!Number.isFinite(price) || price <= 0) {
      return res.status(400).json({ error: "pricePerKwh must be a positive number" });
    }

    const offer = createOffer({ userId, direction, energyKwh: kwh, pricePerKwh: price, minKwh, ttlMs, meterId, location });
    res.status(201).json(offer);
  }),
);

p2pTradingRouter.get(
  "/offers/:id",
  asyncHandler(async (req: Request, res: Response) => {
    const offer = getOffer(req.params.id);
    if (!offer) return res.status(404).json({ error: "Offer not found" });
    res.json(offer);
  }),
);

p2pTradingRouter.delete(
  "/offers/:id",
  asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.body as { userId?: string };
    if (!userId) return res.status(400).json({ error: "userId is required" });
    try {
      const offer = cancelOffer(req.params.id, userId);
      res.json(offer);
    } catch (err: any) {
      const status = err.code === "NOT_FOUND" ? 404 : err.code === "FORBIDDEN" ? 403 : 409;
      res.status(status).json({ error: err.message });
    }
  }),
);

p2pTradingRouter.get(
  "/user/:userId/offers",
  asyncHandler(async (req: Request, res: Response) => {
    res.json({ offers: getUserOffers(req.params.userId) });
  }),
);

p2pTradingRouter.get(
  "/user/:userId/matches",
  asyncHandler(async (req: Request, res: Response) => {
    res.json({ matches: getUserMatches(req.params.userId) });
  }),
);

p2pTradingRouter.post(
  "/match",
  requireAdminKey,
  asyncHandler(async (_req: Request, res: Response) => {
    const newMatches = runMatchingAlgorithm();
    res.json({ matched: newMatches.length, matches: newMatches });
  }),
);

p2pTradingRouter.get(
  "/matches/:id",
  asyncHandler(async (req: Request, res: Response) => {
    const match = getMatch(req.params.id);
    if (!match) return res.status(404).json({ error: "Match not found" });
    res.json(match);
  }),
);

p2pTradingRouter.post(
  "/matches/:id/settle",
  asyncHandler(async (req: Request, res: Response) => {
    try {
      const match = settleMatch(req.params.id);
      res.json(match);
    } catch (err: any) {
      const status = err.code === "NOT_FOUND" ? 404 : 409;
      res.status(status).json({ error: err.message });
    }
  }),
);

p2pTradingRouter.post(
  "/matches/:id/dispute",
  asyncHandler(async (req: Request, res: Response) => {
    const { reason } = req.body as { reason?: string };
    if (!reason) return res.status(400).json({ error: "reason is required" });
    try {
      const match = raiseDispute(req.params.id, reason);
      res.json(match);
    } catch (err: any) {
      const status = err.code === "NOT_FOUND" ? 404 : 409;
      res.status(status).json({ error: err.message });
    }
  }),
);
