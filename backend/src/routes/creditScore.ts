/**
 * Automated credit scoring for payment plans (#1003).
 *
 *   GET  /api/users/:address/credit-score          — computed score + any active admin override
 *   POST /api/users/:address/credit-score/override — admin: pin a manual score/limit (with reason + optional expiry)
 *   DELETE /api/users/:address/credit-score/override — admin: clear a manual override
 *
 * See lib/creditScoring.ts for the scoring formula and lib/creditOverrides.ts
 * for the override store.
 */
import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireAdminKey } from "../middleware/adminAuth.js";
import { validateRequest, CreditScoreAddressParamsSchema, CreditScoreOverrideSchema } from "../lib/validation.js";
import { buildCreditScoreResult, creditTier, recommendPaymentPlan } from "../lib/creditScoring.js";
import {
  clearCreditOverride,
  getActiveCreditOverride,
  setCreditOverride,
} from "../lib/creditOverrides.js";
import { logger } from "../lib/logger.js";
import {
  computeReputationScore,
  getReputationRecord,
  linkDid,
} from "../lib/reputationScoring.js";

export const creditScoreRouter = Router();

/**
 * GET /api/users/:address/credit-score
 *
 * Response (200):
 * ```json
 * {
 *   "address": "G...",
 *   "score": 742,
 *   "tier": "Good",
 *   "factors": { "totalPayments": 12, "onTimeCount": 10, "lateCount": 2, "defaultCount": 0, ... },
 *   "recommendedPaymentPlan": "Weekly",
 *   "creditLimitStroops": 3710000000,
 *   "override": null
 * }
 * ```
 * If an active (non-expired) admin override exists, `score`,
 * `recommendedPaymentPlan` and `creditLimitStroops` reflect the override
 * instead of the computed formula, and `override` describes it. The
 * computed values are always available under `computed` for comparison.
 */
creditScoreRouter.get(
  "/:address/credit-score",
  validateRequest({ params: CreditScoreAddressParamsSchema }),
  asyncHandler(async (req, res) => {
    const { address } = req.params as { address: string };
    const computed = buildCreditScoreResult(address);
    const override = getActiveCreditOverride(address);

    if (!override) {
      return res.json({ ...computed, computed, override: null });
    }

    const score = override.score ?? computed.score;
    const creditLimitStroops = override.credit_limit_stroops ?? computed.creditLimitStroops;
    return res.json({
      address,
      score,
      tier: creditTier(score),
      factors: computed.factors,
      recommendedPaymentPlan: recommendPaymentPlan(score),
      creditLimitStroops,
      computed,
      override: {
        score: override.score,
        creditLimitStroops: override.credit_limit_stroops,
        reason: override.reason,
        setBy: override.set_by,
        createdAt: override.created_at,
        expiresAt: override.expires_at,
      },
    });
  }),
);

/**
 * POST /api/users/:address/credit-score/override — admin only.
 *
 * Body:
 * ```json
 * { "score": 900, "credit_limit_stroops": 40000000000, "reason": "VIP customer", "expires_at": "2026-12-31T00:00:00Z" }
 * ```
 * At least one of `score` / `credit_limit_stroops` is required. While
 * active, the override takes precedence over the computed score returned
 * by GET /api/users/:address/credit-score.
 */
creditScoreRouter.post(
  "/:address/credit-score/override",
  requireAdminKey,
  validateRequest({ params: CreditScoreAddressParamsSchema, body: CreditScoreOverrideSchema }),
  asyncHandler(async (req, res) => {
    const { address } = req.params as { address: string };
    const { score, credit_limit_stroops, reason, expires_at } = req.body as {
      score?: number;
      credit_limit_stroops?: number;
      reason: string;
      expires_at?: string;
    };
    const override = setCreditOverride({
      address,
      score: score ?? null,
      creditLimitStroops: credit_limit_stroops ?? null,
      reason,
      setBy: req.header("X-Admin-Key") ? "admin" : null,
      expiresAt: expires_at ?? null,
    });
    logger.info({ address, score, credit_limit_stroops }, "Credit score override set");
    return res.status(201).json({ override });
  }),
);

/** DELETE /api/users/:address/credit-score/override — admin only. */
creditScoreRouter.delete(
  "/:address/credit-score/override",
  requireAdminKey,
  validateRequest({ params: CreditScoreAddressParamsSchema }),
  asyncHandler(async (req, res) => {
    const { address } = req.params as { address: string };
    const cleared = clearCreditOverride(address);
    if (!cleared) return res.status(404).json({ error: "No override found for this address" });
    logger.info({ address }, "Credit score override cleared");
    return res.status(204).send();
  }),
);

/**
 * GET /api/users/:address/reputation-score
 *
 * Reputation-based credit scoring (#1070). Returns the 0-100 on-chain
 * reputation score derived from payment history (timeliness, amounts,
 * defaults), the linked DID (if any), and portability metadata so the
 * score can be verified and reused across platforms.
 *
 * Response (200):
 * ```json
 * {
 *   "address": "G...",
 *   "score": 82,
 *   "tier": "Good",
 *   "did": "did:stellar:G...",
 *   "portable": true,
 *   "privacyPreserving": true,
 *   "factors": { "timeliness": 0.9, "amounts": 0.7, "defaults": 1, ... },
 *   "attestation": "0x..."
 * }
 * ```
 */
creditScoreRouter.get(
  "/:address/reputation-score",
  validateRequest({ params: CreditScoreAddressParamsSchema }),
  asyncHandler(async (req, res) => {
    const { address } = req.params as { address: string };
    const record = getReputationRecord(address);
    const result = computeReputationScore(address);
    return res.json({
      address,
      score: result.score,
      tier: result.tier,
      did: record?.did ?? null,
      portable: true,
      privacyPreserving: true,
      factors: result.factors,
      attestation: result.attestation,
    });
  }),
);

/**
 * POST /api/users/:address/reputation-score/did — link a DID to an address.
 *
 * Body:
 * ```json
 * { "did": "did:stellar:G..." }
 * ```
 * The DID is stored alongside the on-chain reputation record so the score
 * can be resolved and verified by other platforms.
 */
creditScoreRouter.post(
  "/:address/reputation-score/did",
  validateRequest({ params: CreditScoreAddressParamsSchema }),
  asyncHandler(async (req, res) => {
    const { address } = req.params as { address: string };
    const { did } = req.body as { did?: string };
    if (!did || typeof did !== "string" || !did.startsWith("did:")) {
      return res.status(400).json({ error: "A valid DID (did:...) is required" });
    }
    const record = linkDid(address, did);
    logger.info({ address, did }, "DID linked to reputation record");
    return res.status(201).json({ address, did: record.did });
  }),
);
