/**
 * Energy data privacy controls (#939). All routes need a wallet session.
 *
 *   GET    /api/privacy/settings            current privacy settings
 *   PUT    /api/privacy/settings            update sharing level / anonymization / opt-ins
 *   GET    /api/privacy/grants              active third-party grants
 *   POST   /api/privacy/grants              grant a third party scoped access
 *   DELETE /api/privacy/grants/:id          revoke a grant
 *   GET    /api/privacy/dashboard           settings, grants and data-usage summary
 *   GET    /api/privacy/export?meterId=     export all data (plus owned meters' usage)
 *   DELETE /api/privacy/data?meterId=       delete all data (plus owned meters' usage)
 */
import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import { sessionAddress } from "../lib/walletAuth.js";
import { ownsMeter } from "../lib/meterOwnership.js";
import { deleteUsageHistory, getUsageHistory, type UsageHistoryRecord } from "../lib/usageHistory.js";
import {
  addGrant,
  anonymize,
  deleteOwnerData,
  exportOwnerData,
  getDashboard,
  getSettings,
  listGrants,
  recordDataUsage,
  revokeGrant,
  updateSettings,
} from "../lib/privacy.js";

type OwnerRequest = Request & { ownerAddress?: string };

const Scope = z.enum(["usage", "billing", "meter", "location"]);
const SettingsPatch = z
  .object({
    sharingLevel: z.enum(["none", "aggregate", "full"]),
    anonymize: z.boolean(),
    allowAnalytics: z.boolean(),
    allowResearch: z.boolean(),
  })
  .partial()
  .strict();
const GrantBody = z.object({
  thirdParty: z.string().trim().min(1).max(100),
  scopes: z.array(Scope).min(1),
  expiresAt: z.string().datetime().optional(),
});

function requireSession(req: OwnerRequest, res: Response, next: NextFunction) {
  const auth = req.headers.authorization;
  const address = sessionAddress(auth?.startsWith("Bearer ") ? auth.slice(7) : undefined);
  if (!address) return res.status(401).json({ error: "Wallet session required", code: "UNAUTHORIZED" });
  req.ownerAddress = address;
  next();
}

/** Owned meter IDs from `?meterId=` (repeatable); rejects meters the caller does not own. */
async function ownedMeters(req: OwnerRequest, res: Response): Promise<string[] | undefined> {
  const raw = req.query.meterId;
  const ids = (Array.isArray(raw) ? raw : raw ? [raw] : []).map(String);
  for (const id of ids) {
    if (!(await ownsMeter(id, req.ownerAddress!))) {
      res.status(403).json({ error: `Not the owner of meter ${id}` });
      return undefined;
    }
  }
  return ids;
}

function allUsage(meterId: string): UsageHistoryRecord[] {
  const out: UsageHistoryRecord[] = [];
  for (let page = 1; ; page++) {
    const res = getUsageHistory(meterId, { limit: 100, page });
    out.push(...res.history);
    if (page >= res.pages) return out;
  }
}

export const privacyRouter = Router();
privacyRouter.use(requireSession);

privacyRouter.get("/settings", (req: OwnerRequest, res) => {
  res.json(getSettings(req.ownerAddress!));
});

privacyRouter.put("/settings", (req: OwnerRequest, res) => {
  const parsed = SettingsPatch.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid settings" });
  res.json(updateSettings(req.ownerAddress!, parsed.data));
});

privacyRouter.get("/grants", (req: OwnerRequest, res) => {
  res.json({ grants: listGrants(req.ownerAddress!) });
});

privacyRouter.post("/grants", (req: OwnerRequest, res) => {
  const parsed = GrantBody.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid grant" });
  const { thirdParty, scopes, expiresAt } = parsed.data;
  res.status(201).json(addGrant(req.ownerAddress!, thirdParty, scopes, expiresAt));
});

privacyRouter.delete("/grants/:id", (req: OwnerRequest, res) => {
  if (!revokeGrant(req.ownerAddress!, req.params.id)) return res.status(404).json({ error: "Grant not found" });
  res.status(204).end();
});

privacyRouter.get("/dashboard", (req: OwnerRequest, res) => {
  res.json(getDashboard(req.ownerAddress!));
});

privacyRouter.get(
  "/export",
  asyncHandler(async (req: OwnerRequest, res: Response) => {
    const meters = await ownedMeters(req, res);
    if (!meters) return;
    const owner = req.ownerAddress!;
    recordDataUsage(owner, owner, "export", ["usage", "meter"]);
    const data = { ...exportOwnerData(owner), meters: meters.map((id) => ({ meterId: id, usage: allUsage(id) })) };
    res.setHeader("Content-Disposition", 'attachment; filename="solargrid-data-export.json"');
    res.json(req.query.anonymize === "true" ? anonymize(data) : data);
  }),
);

privacyRouter.delete(
  "/data",
  asyncHandler(async (req: OwnerRequest, res: Response) => {
    const meters = await ownedMeters(req, res);
    if (!meters) return;
    const deletedUsageRecords = meters.reduce((n, id) => n + deleteUsageHistory(id), 0);
    deleteOwnerData(req.ownerAddress!);
    res.json({ deleted: true, deletedUsageRecords });
  }),
);
