/**
 * Carbon credit tracking API (#878).
 *
 *   GET  /api/carbon-credits/stats                  — platform totals
 *   POST /api/carbon-credits/issue                  — issue credits for kWh produced
 *   GET  /api/carbon-credits/:id                    — fetch a single credit + audit trail
 *   POST /api/carbon-credits/:id/retire             — retire (offset) a credit
 *   POST /api/carbon-credits/:id/list               — list a credit on the marketplace
 *   POST /api/carbon-credits/:id/purchase           — purchase a listed credit
 *   GET  /api/carbon-credits/marketplace            — open market listings
 *   GET  /api/carbon-credits/owner/:ownerId         — all credits for an owner
 */
import { Router, Request, Response } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import {
  issueCredit,
  retireCredit,
  listForSale,
  purchaseCredit,
  getCredit,
  listCreditsByOwner,
  getMarketListings,
  getCreditStats,
  calculateCredits,
} from "../lib/carbonCredits.js";

export const carbonCreditsRouter = Router();

carbonCreditsRouter.get(
  "/stats",
  asyncHandler(async (_req: Request, res: Response) => {
    res.json(getCreditStats());
  }),
);

carbonCreditsRouter.get(
  "/marketplace",
  asyncHandler(async (_req: Request, res: Response) => {
    res.json({ listings: getMarketListings() });
  }),
);

carbonCreditsRouter.get(
  "/owner/:ownerId",
  asyncHandler(async (req: Request, res: Response) => {
    res.json({ credits: listCreditsByOwner(req.params.ownerId) });
  }),
);

carbonCreditsRouter.post(
  "/issue",
  asyncHandler(async (req: Request, res: Response) => {
    const { ownerId, kwhProduced, meterId, vintage } = req.body as {
      ownerId?: string;
      kwhProduced?: number;
      meterId?: string;
      vintage?: string;
    };
    if (!ownerId || typeof ownerId !== "string") {
      return res.status(400).json({ error: "ownerId is required" });
    }
    const kwh = Number(kwhProduced);
    if (!Number.isFinite(kwh) || kwh <= 0) {
      return res.status(400).json({ error: "kwhProduced must be a positive number" });
    }
    const credit = issueCredit({ ownerId, kwhProduced: kwh, meterId, vintage });
    res.status(201).json(credit);
  }),
);

carbonCreditsRouter.get(
  "/:id",
  asyncHandler(async (req: Request, res: Response) => {
    const credit = getCredit(req.params.id);
    if (!credit) return res.status(404).json({ error: "Credit not found" });
    res.json(credit);
  }),
);

carbonCreditsRouter.post(
  "/:id/retire",
  asyncHandler(async (req: Request, res: Response) => {
    const { actor } = req.body as { actor?: string };
    if (!actor) return res.status(400).json({ error: "actor is required" });
    try {
      const credit = retireCredit(req.params.id, actor);
      res.json(credit);
    } catch (err: any) {
      const status = err.code === "NOT_FOUND" ? 404 : err.code === "CONFLICT" ? 409 : 400;
      res.status(status).json({ error: err.message });
    }
  }),
);

carbonCreditsRouter.post(
  "/:id/list",
  asyncHandler(async (req: Request, res: Response) => {
    const { sellerId, pricePerCredit, quantity } = req.body as {
      sellerId?: string;
      pricePerCredit?: number;
      quantity?: number;
    };
    if (!sellerId) return res.status(400).json({ error: "sellerId is required" });
    const price = Number(pricePerCredit);
    const qty = Number(quantity);
    if (!Number.isFinite(price) || price <= 0) {
      return res.status(400).json({ error: "pricePerCredit must be a positive number" });
    }
    if (!Number.isFinite(qty) || qty <= 0) {
      return res.status(400).json({ error: "quantity must be a positive number" });
    }
    try {
      const listing = listForSale(req.params.id, sellerId, price, qty);
      res.status(201).json(listing);
    } catch (err: any) {
      const status = err.code === "NOT_FOUND" ? 404 : err.code === "CONFLICT" ? 409 : err.code === "FORBIDDEN" ? 403 : 400;
      res.status(status).json({ error: err.message });
    }
  }),
);

carbonCreditsRouter.post(
  "/:id/purchase",
  asyncHandler(async (req: Request, res: Response) => {
    const { buyerId } = req.body as { buyerId?: string };
    if (!buyerId) return res.status(400).json({ error: "buyerId is required" });
    try {
      const credit = purchaseCredit(req.params.id, buyerId);
      res.json(credit);
    } catch (err: any) {
      const status = err.code === "NOT_FOUND" ? 404 : 400;
      res.status(status).json({ error: err.message });
    }
  }),
);

carbonCreditsRouter.get(
  "/estimate",
  asyncHandler(async (req: Request, res: Response) => {
    const kwh = Number(req.query.kwhProduced);
    if (!Number.isFinite(kwh) || kwh <= 0) {
      return res.status(400).json({ error: "kwhProduced must be a positive number" });
    }
    res.json({ kwhProduced: kwh, estimatedCredits: calculateCredits(kwh) });
  }),
);
