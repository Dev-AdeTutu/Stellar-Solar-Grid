/**
 * Energy consumption gamification (#996).
 *
 * Achievements, leaderboards and activity already live under /api/social;
 * these thin routes expose the exact shapes the gamification feature calls
 * for — a catalogue (optionally resolved against one address) and
 * leaderboards that can be grouped by region — without duplicating logic.
 * Monthly challenges with prizes are served separately by /api/competitions.
 */
import { Router } from "express";
import * as StellarSdk from "@stellar/stellar-sdk";
import {
  ACHIEVEMENTS, getLeaderboard, getProfile, getRegionLeaderboard, getUserAchievements, type Board,
} from "../lib/social.js";

export const achievementsRouter = Router();
export const leaderboardsRouter = Router();

const isAddress = (a: string) => StellarSdk.StrKey.isValidEd25519PublicKey(a);

/**
 * GET /api/achievements?address=
 * Without `address`, returns the achievement catalogue. With a valid
 * `address`, returns each achievement annotated with unlockedAt (or null).
 */
achievementsRouter.get("/", (req, res) => {
  const address = typeof req.query.address === "string" ? req.query.address : undefined;
  if (address === undefined) {
    return res.json({ achievements: ACHIEVEMENTS.map(({ id, name, description }) => ({ id, name, description })) });
  }
  if (!isAddress(address)) return res.status(400).json({ error: "address must be a valid Stellar public key" });
  if (!getProfile(address)) return res.status(404).json({ error: "Profile not found" });
  res.json({ achievements: getUserAchievements(address) });
});

/**
 * GET /api/leaderboards?board=green|trader&region=&limit=
 * Without `region`, returns the global leaderboard for `board` (default green).
 * With `region`, returns the top savers in that region only.
 */
leaderboardsRouter.get("/", (req, res) => {
  const board = (req.query.board as Board | undefined) ?? "green";
  if (board !== "green" && board !== "trader") return res.status(400).json({ error: "board must be green or trader" });
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const region = typeof req.query.region === "string" ? req.query.region.trim().toUpperCase() : undefined;
  if (region) {
    if (board !== "green") return res.status(400).json({ error: "region filtering is only available for the green board" });
    const byRegion = getRegionLeaderboard(limit);
    return res.json({ board, region, entries: byRegion[region] ?? [] });
  }
  res.json(getLeaderboard(board, limit));
});
