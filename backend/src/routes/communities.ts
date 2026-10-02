import { Router, type NextFunction, type Request, type Response } from "express";
import { sessionAddress } from "../lib/walletAuth.js";
import {
  CommunityError,
  MAX_COMMUNITY_DISCOUNT_PERCENT,
  allocateEnergy,
  castDiscountVote,
  contributeEnergy,
  createCommunity,
  createDiscountProposal,
  finalizeDiscountProposal,
  getCommunityDashboard,
  joinCommunity,
  leaveCommunity,
  listCommunities,
} from "../lib/communities.js";

export const communitiesRouter = Router();

type OwnerRequest = Request & { ownerAddress?: string };

function bearer(req: Request) {
  const authorization = req.headers.authorization;
  return authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
}

function requireSession(req: OwnerRequest, res: Response, next: NextFunction) {
  const address = sessionAddress(bearer(req));
  if (!address) return res.status(401).json({ error: "Wallet session required", code: "UNAUTHORIZED" });
  req.ownerAddress = address;
  next();
}

function handleCommunityError(error: unknown, res: Response) {
  if (error instanceof CommunityError) return res.status(error.status).json({ error: error.message });
  throw error;
}

function viewer(req: Request) {
  const authenticated = sessionAddress(bearer(req));
  const requested = typeof req.query.viewerAddress === "string" ? req.query.viewerAddress : undefined;
  return authenticated ?? requested;
}

communitiesRouter.get("/", (req, res) => {
  res.json({ communities: listCommunities(viewer(req)) });
});

communitiesRouter.post("/", requireSession, (req: OwnerRequest, res) => {
  const { name, description } = req.body ?? {};
  if (typeof name !== "string" || name.trim().length < 2 || name.trim().length > 100) {
    return res.status(400).json({ error: "name must contain 2–100 characters" });
  }
  if (description !== undefined && (typeof description !== "string" || description.length > 500)) {
    return res.status(400).json({ error: "description must be at most 500 characters" });
  }
  try {
    res.status(201).json(createCommunity({
      name,
      description: description ?? "",
      ownerAddress: req.ownerAddress!,
    }));
  } catch (error) {
    handleCommunityError(error, res);
  }
});

communitiesRouter.get("/:id", (req, res) => {
  const dashboard = getCommunityDashboard(req.params.id, viewer(req));
  if (!dashboard) return res.status(404).json({ error: "Community not found" });
  res.json(dashboard);
});

communitiesRouter.post("/:id/join", requireSession, (req: OwnerRequest, res) => {
  try {
    res.status(201).json(joinCommunity(req.params.id, req.ownerAddress!));
  } catch (error) {
    handleCommunityError(error, res);
  }
});

communitiesRouter.delete("/:id/membership", requireSession, (req: OwnerRequest, res) => {
  try {
    if (!leaveCommunity(req.params.id, req.ownerAddress!)) return res.status(404).json({ error: "Membership not found" });
    res.status(204).end();
  } catch (error) {
    handleCommunityError(error, res);
  }
});

communitiesRouter.post("/:id/energy/contributions", requireSession, (req: OwnerRequest, res) => {
  const kwh = req.body?.kwh;
  if (typeof kwh !== "number" || !Number.isFinite(kwh)) return res.status(400).json({ error: "kwh must be a number" });
  try {
    res.status(201).json(contributeEnergy(req.params.id, req.ownerAddress!, kwh));
  } catch (error) {
    handleCommunityError(error, res);
  }
});

communitiesRouter.post("/:id/energy/allocations", requireSession, (req: OwnerRequest, res) => {
  const kwh = req.body?.kwh;
  if (typeof kwh !== "number" || !Number.isFinite(kwh)) return res.status(400).json({ error: "kwh must be a number" });
  try {
    res.status(201).json(allocateEnergy(req.params.id, req.ownerAddress!, kwh));
  } catch (error) {
    handleCommunityError(error, res);
  }
});

communitiesRouter.post("/:id/governance/proposals", requireSession, (req: OwnerRequest, res) => {
  const { title, description, discountPercent } = req.body ?? {};
  if (typeof title !== "string" || title.trim().length < 3 || title.length > 100) {
    return res.status(400).json({ error: "title must contain 3–100 characters" });
  }
  if (description !== undefined && (typeof description !== "string" || description.length > 500)) {
    return res.status(400).json({ error: "description must be at most 500 characters" });
  }
  if (typeof discountPercent !== "number" || !Number.isFinite(discountPercent) || discountPercent < 0 || discountPercent > MAX_COMMUNITY_DISCOUNT_PERCENT) {
    return res.status(400).json({ error: `discountPercent must be between 0 and ${MAX_COMMUNITY_DISCOUNT_PERCENT}` });
  }
  try {
    const proposalId = createDiscountProposal({
      communityId: req.params.id,
      proposerAddress: req.ownerAddress!,
      title,
      description: description ?? "",
      discountPercent,
    });
    res.status(201).json(getCommunityDashboard(req.params.id, req.ownerAddress)?.proposals.find((p) => p.id === proposalId));
  } catch (error) {
    handleCommunityError(error, res);
  }
});

communitiesRouter.post("/:id/governance/proposals/:proposalId/votes", requireSession, (req: OwnerRequest, res) => {
  const choice = req.body?.choice;
  if (choice !== "yes" && choice !== "no") return res.status(400).json({ error: "choice must be yes or no" });
  try {
    const tally = castDiscountVote(req.params.id, req.params.proposalId, req.ownerAddress!, choice);
    res.json({ ...tally, dashboard: getCommunityDashboard(req.params.id, req.ownerAddress) });
  } catch (error) {
    handleCommunityError(error, res);
  }
});

communitiesRouter.post("/:id/governance/proposals/:proposalId/finalize", requireSession, (req: OwnerRequest, res) => {
  try {
    const status = finalizeDiscountProposal(req.params.id, req.params.proposalId, req.ownerAddress!);
    res.json({ status, dashboard: getCommunityDashboard(req.params.id, req.ownerAddress) });
  } catch (error) {
    handleCommunityError(error, res);
  }
});