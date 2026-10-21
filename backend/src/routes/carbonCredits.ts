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
 *   POST /api/carbon-credits/:id/retire-record      — retire + record in registry (#934)
 *   GET  /api/carbon-credits/registry[/:serial]     — retirement registry
 *   POST /api/carbon-credits/registry/:serial/verify — third-party verification (admin)
 *   GET  /api/carbon-credits/report/:ownerId/:year  — annual sustainability report
 *   POST /api/carbon-credits/issue-from-generation  — auto-issue credits from solar generation
 *   POST /api/carbon-credits/:id/verify             — certify a credit (admin)
 *   POST /api/carbon-credits/:id/bid                — place a bid on the order book
 *   POST /api/carbon-credits/:id/ask                — place an ask on the order book
 *   GET  /api/carbon-credits/orderbook/:creditId    — order book for a credit
 *   GET  /api/carbon-credits/index-price/:creditId  — index price for a credit
 */
import { Router, Request, Response } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireAdminKey } from "../middleware/adminAuth.js";
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
  retireAndRecord,
  getRetirementRegistry,
  getRetirement,
  verifyRetirement,
  annualSustainabilityReport,
  issueFromGeneration,
  verifyCredit,
  placeBid,
  placeAsk,
  getOrderBook,
  getIndexPrice,
} from "../lib/carbonCredits.js";

function errorStatus(err: any): number {
  switch (err?.code) {
    case "NOT_FOUND":
      return 404;
    case "CONFLICT":
      return 409;
    case "FORBIDDEN":
      return 403;
    case "UNAUTHORIZED":
      return 401;
    default:
      return 400;
  }
}

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

carbonCreditsRouter.post(
  "/issue-from-generation",
  asyncHandler(async (req: Request, res: Response) => {
    const { ownerId, kwhProduced, meterId, vintage, generationId } = req.body as {
      ownerId?: string;
      kwhProduced?: number;
      meterId?: string;
      vintage?: string;
      generationId?: string;
    };
    if (!ownerId || typeof ownerId !== "string") {
      return res.status(400).json({ error: "ownerId is required" });
    }
    const kwh = Number(kwhProduced);
    if (!Number.isFinite(kwh) || kwh <= 0) {
      return res.status(400).json({ error: "kwhProduced must be a positive number" });
    }
    try {
      const credit = issueFromGeneration({ ownerId, kwhProduced: kwh, meterId, vintage, generationId });
      res.status(201).json(credit);
    } catch (err: any) {
      res.status(errorStatus(err)).json({ error: err.message });
    }
  }),
);

carbonCreditsRouter.get(
  "/registry",
  asyncHandler(async (req: Request, res: Response) => {
    const ownerId = typeof req.query.ownerId === "string" ? req.query.ownerId : undefined;
    res.json({ retirements: getRetirementRegistry(ownerId) });
  }),
);

carbonCreditsRouter.get(
  "/registry/:serial",
  asyncHandler(async (req: Request, res: Response) => {
    const record = getRetirement(Number(req.params.serial));
    if (!record) return res.status(404).json({ error: "Retirement not found" });
    res.json(record);
  }),
);

carbonCreditsRouter.post(
  "/registry/:serial/verify",
  requireAdminKey,
  asyncHandler(async (req: Request, res: Response) => {
    const { verifier } = req.body as { verifier?: string };
    if (!verifier) return res.status(400).json({ error: "verifier is required" });
    try {
      res.json(verifyRetirement(Number(req.params.serial), verifier));
    } catch (err: any) {
      res.status(err.code === "NOT_FOUND" ? 404 : err.code === "CONFLICT" ? 409 : 400).json({ error: err.message });
    }
  }),
);

carbonCreditsRouter.get(
  "/report/:ownerId/:year",
  asyncHandler(async (req: Request, res: Response) => {
    const year = Number(req.params.year);
    if (!Number.isInteger(year) || year < 2000 || year > 3000) return res.status(400).json({ error: "invalid year" });
    res.json(annualSustainabilityReport(req.params.ownerId, year));
  }),
);

carbonCreditsRouter.post(
  "/:id/retire-record",
  asyncHandler(async (req: Request, res: Response) => {
    const { actor, beneficiary } = req.body as { actor?: string; beneficiary?: string };
    if (!actor) return res.status(400).json({ error: "actor is required" });
    try {
      res.status(201).json(retireAndRecord(req.params.id, actor, beneficiary));
    } catch (err: any) {
      res.status(err.code === "NOT_FOUND" ? 404 : err.code === "CONFLICT" ? 409 : 400).json({ error: err.message });
    }
  }),
);

carbonCreditsRouter.post(
  "/:id/verify",
  requireAdminKey,
  asyncHandler(async (req: Request, res: Response) => {
    const { verifier, certificationId } = req.body as { verifier?: string; certificationId?: string };
    if (!verifier) return res.status(400).json({ error: "verifier is required" });
    try {
      res.json(verifyCredit(req.params.id, verifier, certificationId));
    } catch (err: any) {
      res.status(errorStatus(err)).json({ error: err.message });
    }
  }),
);

carbonCreditsRouter.post(
  "/:id/bid",
  asyncHandler(async (req: Request, res: Response) => {
    const { bidderId, pricePerCredit, quantity } = req.body as {
      bidderId?: string;
      pricePerCredit?: number;
      quantity?: number;
    };
    if (!bidderId) return res.status(400).json({ error: "bidderId is required" });
    const price = Number(pricePerCredit);
    const qty = Number(quantity);
    if (!Number.isFinite(price) || price <= 0) {
      return res.status(400).json({ error: "pricePerCredit must be a positive number" });
    }
    if (!Number.isFinite(qty) || qty <= 0) {
      return res.status(400).json({ error: "quantity must be a positive number" });
    }
    try {
      res.status(201).json(placeBid(req.params.id, bidderId, price, qty));
    } catch (err: any) {
      res.status(errorStatus(err)).json({ error: err.message });
    }
  }),
);

carbonCreditsRouter.post(
  "/:id/ask",
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
      res.status(201).json(placeAsk(req.params.id, sellerId, price, qty));
    } catch (err: any) {
      res.status(errorStatus(err)).json({ error: err.message });
    }
  }),
);

carbonCreditsRouter.get(
  "/orderbook/:creditId",
  asyncHandler(async (req: Request, res: Response) => {
    try {
      res.json(getOrderBook(req.params.creditId));
    } catch (err: any) {
      res.status(errorStatus(err)).json({ error: err.message });
    }
  }),
);

carbonCreditsRouter.get(
  "/index-price/:creditId",
  asyncHandler(async (req: Request, res: Response) => {
    try {
      res.json(getIndexPrice(req.params.creditId));
    } catch (err: any) {
      res.status(errorStatus(err)).json({ error: err.message });
    }
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
