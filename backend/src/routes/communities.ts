import { Router, type NextFunction, type Request, type Response } from "express";
import { sessionAddress } from "../lib/walletAuth.js";
import {
  CommunityError,
  MAX_COMMUNITY_DISCOUNT_PERCENT,
  allocateEnergy,
  applyCommonsSanction,
  castDiscountVote,
  contributeEnergy,
  createCommunity,
  createDiscountProposal,
  createUsageRuleProposal,
  defineResourceBoundaries,
  finalizeDiscountProposal,
  getCommunityDashboard,
  getCommonsState,
  joinCommunity,
  leaveCommunity,
  listCommunities,
  openConflict,
  recordMonitoringReport,
  resolveConflict,
  voteOnUsageRule,
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

communitiesRouter.get("/:id/commons", (req, res) => {
  const commons = getCommonsState(req.params.id, viewer(req));
  if (!commons) return res.status(404).json({ error: "Community not found" });
  res.json(commons);
});

communitiesRouter.put("/:id/commons/boundaries", requireSession, (req: OwnerRequest, res) => {
  const { resourceName, unit, totalCapacityKwh, description } = req.body ?? {};
  if (typeof resourceName !== "string" || resourceName.trim().length < 2 || resourceName.trim().length > 100) {
    return res.status(400).json({ error: "resourceName must contain 2–100 characters" });
  }
  if (unit !== undefined && (typeof unit !== "string" || unit.length > 20)) {
    return res.status(400).json({ error: "unit must be at most 20 characters" });
  }
  if (typeof totalCapacityKwh !== "number" || !Number.isFinite(totalCapacityKwh) || totalCapacityKwh <= 0) {
    return res.status(400).json({ error: "totalCapacityKwh must be a positive number" });
  }
  if (description !== undefined && (typeof description !== "string" || description.length > 500)) {
    return res.status(400).json({ error: "description must be at most 500 characters" });
  }
  try {
    res.json(defineResourceBoundaries(req.params.id, req.ownerAddress!, {
      resourceName,
      unit: unit ?? "kWh",
      totalCapacityKwh,
      description: description ?? "",
    }));
  } catch (error) {
    handleCommunityError(error, res);
  }
});

communitiesRouter.post("/:id/commons/rules", requireSession, (req: OwnerRequest, res) => {
  const { title, description, maxAllocationKwh, minContributionKwh } = req.body ?? {};
  if (typeof title !== "string" || title.trim().length < 3 || title.length > 100) {
    return res.status(400).json({ error: "title must contain 3–100 characters" });
  }
  if (description !== undefined && (typeof description !== "string" || description.length > 500)) {
    return res.status(400).json({ error: "description must be at most 500 characters" });
  }
  if (maxAllocationKwh !== undefined && (typeof maxAllocationKwh !== "number" || !Number.isFinite(maxAllocationKwh) || maxAllocationKwh < 0)) {
    return res.status(400).json({ error: "maxAllocationKwh must be a non-negative number" });
  }
  if (minContributionKwh !== undefined && (typeof minContributionKwh !== "number" || !Number.isFinite(minContributionKwh) || minContributionKwh < 0)) {
    return res.status(400).json({ error: "minContributionKwh must be a non-negative number" });
  }
  try {
    res.status(201).json(createUsageRuleProposal({
      communityId: req.params.id,
      proposerAddress: req.ownerAddress!,
      title,
      description: description ?? "",
      maxAllocationKwh,
      minContributionKwh,
    }));
  } catch (error) {
    handleCommunityError(error, res);
  }
});

communitiesRouter.post("/:id/commons/rules/:ruleId/votes", requireSession, (req: OwnerRequest, res) => {
  const choice = req.body?.choice;
  if (choice !== "yes" && choice !== "no") return res.status(400).json({ error: "choice must be yes or no" });
  try {
    res.json(voteOnUsageRule(req.params.id, req.params.ruleId, req.ownerAddress!, choice));
  } catch (error) {
    handleCommunityError(error, res);
  }
});

communitiesRouter.post("/:id/commons/monitoring", requireSession, (req: OwnerRequest, res) => {
  const { subjectAddress, ruleId, description, severity } = req.body ?? {};
  if (typeof subjectAddress !== "string" || subjectAddress.trim().length === 0) {
    return res.status(400).json({ error: "subjectAddress is required" });
  }
  if (typeof description !== "string" || description.trim().length < 3 || description.length > 500) {
    return res.status(400).json({ error: "description must contain 3–500 characters" });
  }
  if (severity !== undefined && severity !== "low" && severity !== "medium" && severity !== "high") {
    return res.status(400).json({ error: "severity must be low, medium or high" });
  }
  if (ruleId !== undefined && typeof ruleId !== "string") {
    return res.status(400).json({ error: "ruleId must be a string" });
  }
  try {
    res.status(201).json(recordMonitoringReport(req.params.id, req.ownerAddress!, {
      subjectAddress,
      ruleId,
      description,
      severity: severity ?? "low",
    }));
  } catch (error) {
    handleCommunityError(error, res);
  }
});

communitiesRouter.post("/:id/commons/sanctions", requireSession, (req: OwnerRequest, res) => {
  const { subjectAddress, reportId, reason } = req.body ?? {};
  if (typeof subjectAddress !== "string" || subjectAddress.trim().length === 0) {
    return res.status(400).json({ error: "subjectAddress is required" });
  }
  if (reportId !== undefined && typeof reportId !== "string") {
    return res.status(400).json({ error: "reportId must be a string" });
  }
  if (reason !== undefined && (typeof reason !== "string" || reason.length > 500)) {
    return res.status(400).json({ error: "reason must be at most 500 characters" });
  }
  try {
    res.status(201).json(applyCommonsSanction(req.params.id, req.ownerAddress!, {
      subjectAddress,
      reportId,
      reason: reason ?? "",
    }));
  } catch (error) {
    handleCommunityError(error, res);
  }
});

communitiesRouter.post("/:id/commons/conflicts", requireSession, (req: OwnerRequest, res) => {
  const { counterpartyAddress, description } = req.body ?? {};
  if (typeof counterpartyAddress !== "string" || counterpartyAddress.trim().length === 0) {
    return res.status(400).json({ error: "counterpartyAddress is required" });
  }
  if (typeof description !== "string" || description.trim().length < 3 || description.length > 500) {
    return res.status(400).json({ error: "description must contain 3–500 characters" });
  }
  try {
    res.status(201).json(openConflict(req.params.id, req.ownerAddress!, { counterpartyAddress, description }));
  } catch (error) {
    handleCommunityError(error, res);
  }
});

communitiesRouter.post("/:id/commons/conflicts/:conflictId/resolve", requireSession, (req: OwnerRequest, res) => {
  const { resolution } = req.body ?? {};
  if (typeof resolution !== "string" || resolution.trim().length < 3 || resolution.length > 500) {
    return res.status(400).json({ error: "resolution must contain 3–500 characters" });
  }
  try {
    res.json(resolveConflict(req.params.id, req.params.conflictId, req.ownerAddress!, resolution));
  } catch (error) {
    handleCommunityError(error, res);
  }
});