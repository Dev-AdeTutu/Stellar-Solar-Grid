import { Router } from "express";
import * as StellarSdk from "@stellar/stellar-sdk";
import {
  ACHIEVEMENTS, getActivityFeed, getLeaderboard, getProfile, getUserAchievements,
  publicProfile, upsertProfile, type Board,
} from "../lib/social.js";

export const socialRouter = Router();

const isAddress = (a: string) => StellarSdk.StrKey.isValidEd25519PublicKey(a);

/** GET /api/social/leaderboard/:board (green | trader)?limit= */
socialRouter.get("/leaderboard/:board", (req, res) => {
  const board = req.params.board as Board;
  if (board !== "green" && board !== "trader") return res.status(400).json({ error: "board must be green or trader" });
  res.json(getLeaderboard(board, Math.min(Number(req.query.limit) || 20, 100)));
});

/** GET /api/social/achievements — catalogue of all achievements. */
socialRouter.get("/achievements", (_req, res) => {
  res.json({ achievements: ACHIEVEMENTS.map(({ id, name, description }) => ({ id, name, description })) });
});

/** GET /api/social/activity?limit=&before= */
socialRouter.get("/activity", (req, res) => {
  const before = req.query.before ? Number(req.query.before) : undefined;
  res.json({ activity: getActivityFeed(Math.min(Number(req.query.limit) || 50, 200), before) });
});

/** GET /api/social/profiles/:address — respects the owner's privacy settings. */
socialRouter.get("/profiles/:address", (req, res) => {
  const profile = getProfile(req.params.address);
  if (!profile) return res.status(404).json({ error: "Profile not found" });
  res.json(publicProfile(profile));
});

/** GET /api/social/profiles/:address/achievements */
socialRouter.get("/profiles/:address/achievements", (req, res) => {
  const profile = getProfile(req.params.address);
  if (!profile) return res.status(404).json({ error: "Profile not found" });
  if (!profile.privacy.publicProfile) return res.status(403).json({ error: "Profile is private" });
  res.json({ achievements: getUserAchievements(profile.address) });
});

/**
 * PUT /api/social/profiles/:address
 * Body: { displayName?, bio?, avatarUrl?, meterIds?, privacy?: { showOnLeaderboard?, showActivity?, publicProfile? } }
 */
socialRouter.put("/profiles/:address", (req, res) => {
  const { address } = req.params;
  if (!isAddress(address)) return res.status(400).json({ error: "Invalid Stellar address" });
  const { displayName, bio, avatarUrl, meterIds, privacy } = req.body ?? {};
  if (displayName !== undefined && typeof displayName !== "string") return res.status(400).json({ error: "displayName must be a string" });
  if (bio !== undefined && typeof bio !== "string") return res.status(400).json({ error: "bio must be a string" });
  if (avatarUrl !== undefined && avatarUrl !== null && !/^https?:\/\//.test(String(avatarUrl)))
    return res.status(400).json({ error: "avatarUrl must be an http(s) URL" });
  if (meterIds !== undefined && (!Array.isArray(meterIds) || !meterIds.every((m) => typeof m === "string")))
    return res.status(400).json({ error: "meterIds must be an array of strings" });
  if (privacy !== undefined && (typeof privacy !== "object" ||
      !Object.values(privacy).every((v) => typeof v === "boolean")))
    return res.status(400).json({ error: "privacy values must be booleans" });
  res.json(upsertProfile(address, { displayName, bio, avatarUrl, meterIds, privacy }));
});
