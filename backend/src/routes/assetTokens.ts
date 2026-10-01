/**
 * Energy asset tokenization (#936).
 *
 *   GET  /api/asset-tokens                          — list assets
 *   GET  /api/asset-tokens/:id                      — asset, token price, valuation history
 *   GET  /api/asset-tokens/:id/holders/:holder      — balance + pending dividend
 *   POST /api/asset-tokens/:id/claim                — { holder } claim dividends
 *   GET  /api/asset-tokens/market/listings          — secondary market (?assetId=)
 *   POST /api/asset-tokens/:id/listings             — { seller, amount, pricePerToken }
 *   POST /api/asset-tokens/listings/:listingId/buy  — { buyer, amount }
 *   DELETE /api/asset-tokens/listings/:listingId    — { seller }
 * Admin (X-Admin-Key):
 *   POST /api/asset-tokens                          — { name, owner, totalSupply, valuation }
 *   POST /api/asset-tokens/:id/revenue              — { amount } distribute to holders
 *   POST /api/asset-tokens/:id/valuation            — { value, force? } quarterly update
 *   GET  /api/asset-tokens/valuations/due           — assets due for quarterly valuation
 */
import { Router } from "express";
import { requireAdminKey } from "../middleware/adminAuth.js";
import {
  assetsDueForValuation,
  buyListing,
  cancelListing,
  claimDividend,
  createListing,
  distributeRevenue,
  getAsset,
  listAssets,
  listListings,
  pendingDividend,
  tokenPrice,
  tokenizeAsset,
  updateValuation,
} from "../lib/assetTokens.js";

export const assetTokensRouter = Router();

const STELLAR_ADDRESS_RE = /^G[A-Z2-7]{55}$/;
const addr = (v: unknown): v is string => typeof v === "string" && STELLAR_ADDRESS_RE.test(v);

/** Run a lib call, mapping thrown validation errors to 400. */
function guard<T>(res: import("express").Response, fn: () => T, status = 200): void {
  try {
    res.status(status).json(fn());
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
}

assetTokensRouter.get("/", (_req, res) => {
  res.json({ assets: listAssets().map((a) => ({ ...a, tokenPrice: tokenPrice(a) })) });
});

assetTokensRouter.get("/market/listings", (req, res) => {
  const assetId = typeof req.query.assetId === "string" ? req.query.assetId : undefined;
  res.json({ listings: listListings(assetId) });
});

assetTokensRouter.get("/valuations/due", requireAdminKey, (_req, res) => {
  res.json({ assets: assetsDueForValuation() });
});

assetTokensRouter.post("/", requireAdminKey, (req, res) => {
  const { name, owner, totalSupply, valuation } = req.body ?? {};
  if (typeof name !== "string" || !name.trim() || !addr(owner)) {
    return res.status(400).json({ error: "name and a valid owner address are required" });
  }
  guard(res, () => tokenizeAsset(name.trim(), owner, totalSupply, valuation), 201);
});

assetTokensRouter.get("/:id", (req, res) => {
  const a = getAsset(req.params.id);
  if (!a) return res.status(404).json({ error: "Asset not found" });
  res.json({ ...a, tokenPrice: tokenPrice(a) });
});

assetTokensRouter.get("/:id/holders/:holder", (req, res) => {
  const a = getAsset(req.params.id);
  if (!a) return res.status(404).json({ error: "Asset not found" });
  res.json({
    holder: req.params.holder,
    balance: a.balances[req.params.holder] ?? 0,
    pendingDividend: pendingDividend(a.id, req.params.holder),
  });
});

assetTokensRouter.post("/:id/revenue", requireAdminKey, (req, res) => {
  guard(res, () => ({ dividendPerToken: distributeRevenue(req.params.id, req.body?.amount) }), 201);
});

assetTokensRouter.post("/:id/valuation", requireAdminKey, (req, res) => {
  guard(res, () => updateValuation(req.params.id, req.body?.value, req.body?.force === true));
});

assetTokensRouter.post("/:id/claim", (req, res) => {
  if (!addr(req.body?.holder)) return res.status(400).json({ error: "Invalid holder" });
  guard(res, () => ({ claimed: claimDividend(req.params.id, req.body.holder) }));
});

assetTokensRouter.post("/:id/listings", (req, res) => {
  const { seller, amount, pricePerToken } = req.body ?? {};
  if (!addr(seller)) return res.status(400).json({ error: "Invalid seller" });
  guard(res, () => createListing(req.params.id, seller, amount, pricePerToken), 201);
});

assetTokensRouter.post("/listings/:listingId/buy", (req, res) => {
  const { buyer, amount } = req.body ?? {};
  if (!addr(buyer)) return res.status(400).json({ error: "Invalid buyer" });
  guard(res, () => ({ totalPrice: buyListing(req.params.listingId, buyer, amount) }));
});

assetTokensRouter.delete("/listings/:listingId", (req, res) => {
  if (!cancelListing(req.params.listingId, req.body?.seller)) {
    return res.status(404).json({ error: "Listing not found" });
  }
  res.status(204).end();
});
