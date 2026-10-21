import crypto from "node:crypto";
import path from "node:path";
import Database from "better-sqlite3";
import { registerDatabase } from "./databaseLifecycle.js";

const DB_PATH = process.env.COMMUNITIES_DB_PATH ?? path.resolve(process.cwd(), "data", "communities.sqlite");
export const MAX_COMMUNITY_DISCOUNT_PERCENT = 30;
const PROPOSAL_DURATION_DAYS = 7;

export type Community = {
  id: string;
  name: string;
  description: string;
  ownerAddress: string;
  discountPercent: number;
  pooledKwh: number;
  contributedKwh: number;
  allocatedKwh: number;
  memberCount: number;
  isMember: boolean;
  createdAt: string;
};

export type CommunityProposal = {
  id: string;
  communityId: string;
  proposerAddress: string;
  title: string;
  description: string;
  discountPercent: number;
  status: "open" | "passed" | "rejected";
  createdAt: string;
  endsAt: string;
  yesVotes: number;
  noVotes: number;
  eligibleVoters: number;
  myVote: "yes" | "no" | null;
};

export type CommonsBoundary = {
  communityId: string;
  maxPoolKwh: number;
  maxAllocationKwh: number;
  maxDailyAllocationKwh: number;
  updatedAt: string;
};

export type CommonsRule = {
  id: string;
  communityId: string;
  proposerAddress: string;
  title: string;
  description: string;
  ruleType: "boundary" | "usage" | "sanction" | "conflict";
  payload: Record<string, unknown>;
  status: "open" | "passed" | "rejected";
  createdAt: string;
  endsAt: string;
  yesVotes: number;
  noVotes: number;
  eligibleVoters: number;
  myVote: "yes" | "no" | null;
};

export type CommonsSanction = {
  id: string;
  communityId: string;
  memberAddress: string;
  level: number;
  reason: string;
  status: "active" | "expired" | "appealed" | "overturned";
  createdAt: string;
  expiresAt: string;
};

export type CommonsConflict = {
  id: string;
  communityId: string;
  complainantAddress: string;
  respondentAddress: string;
  description: string;
  status: "open" | "resolved" | "dismissed";
  resolution: string | null;
  arbiterAddress: string | null;
  createdAt: string;
  resolvedAt: string | null;
};

export const COMMONS_DEFAULT_BOUNDARY = {
  maxPoolKwh: 100_000,
  maxAllocationKwh: 1_000,
  maxDailyAllocationKwh: 2_000,
};

const SANCTION_LEVELS = [
  { level: 1, durationDays: 1, allocationMultiplier: 0.75 },
  { level: 2, durationDays: 7, allocationMultiplier: 0.5 },
  { level: 3, durationDays: 30, allocationMultiplier: 0.25 },
  { level: 4, durationDays: 90, allocationMultiplier: 0 },
];
=======

export class CommunityError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

let _db: Database.Database | undefined;

function db(): Database.Database {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma("foreign_keys = ON");
    _db.pragma("journal_mode = WAL");
    _db.exec(`
      CREATE TABLE IF NOT EXISTS communities (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        owner_address TEXT NOT NULL,
        discount_percent REAL NOT NULL DEFAULT 0,
        pooled_kwh REAL NOT NULL DEFAULT 0,
        contributed_kwh REAL NOT NULL DEFAULT 0,
        allocated_kwh REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS community_members (
        community_id TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
        member_address TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        joined_at TEXT NOT NULL,
        PRIMARY KEY (community_id, member_address)
      );
      CREATE INDEX IF NOT EXISTS idx_community_members_address ON community_members(member_address);
      CREATE TABLE IF NOT EXISTS community_energy_transactions (
        id TEXT PRIMARY KEY,
        community_id TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
        member_address TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('contribution', 'allocation')),
        kwh REAL NOT NULL CHECK (kwh > 0),
        discount_percent REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_community_energy ON community_energy_transactions(community_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS community_proposals (
        id TEXT PRIMARY KEY,
        community_id TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
        proposer_address TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        discount_percent REAL NOT NULL,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'passed', 'rejected')),
        created_at TEXT NOT NULL,
        ends_at TEXT NOT NULL,
        resolved_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_community_proposals ON community_proposals(community_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS community_proposal_voters (
        proposal_id TEXT NOT NULL REFERENCES community_proposals(id) ON DELETE CASCADE,
        member_address TEXT NOT NULL,
        PRIMARY KEY (proposal_id, member_address)
      );
      CREATE TABLE IF NOT EXISTS community_votes (
        proposal_id TEXT NOT NULL REFERENCES community_proposals(id) ON DELETE CASCADE,
        member_address TEXT NOT NULL,
        choice TEXT NOT NULL CHECK (choice IN ('yes', 'no')),
        created_at TEXT NOT NULL,
        PRIMARY KEY (proposal_id, member_address)
      );
      CREATE TABLE IF NOT EXISTS commons_boundaries (
        community_id TEXT PRIMARY KEY REFERENCES communities(id) ON DELETE CASCADE,
        max_pool_kwh REAL NOT NULL,
        max_allocation_kwh REAL NOT NULL,
        max_daily_allocation_kwh REAL NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS commons_rules (
        id TEXT PRIMARY KEY,
        community_id TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
        proposer_address TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        rule_type TEXT NOT NULL CHECK (rule_type IN ('boundary', 'usage', 'sanction', 'conflict')),
        payload TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'passed', 'rejected')),
        created_at TEXT NOT NULL,
        ends_at TEXT NOT NULL,
        resolved_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_commons_rules ON commons_rules(community_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS commons_rule_voters (
        rule_id TEXT NOT NULL REFERENCES commons_rules(id) ON DELETE CASCADE,
        member_address TEXT NOT NULL,
        PRIMARY KEY (rule_id, member_address)
      );
      CREATE TABLE IF NOT EXISTS commons_rule_votes (
        rule_id TEXT NOT NULL REFERENCES commons_rules(id) ON DELETE CASCADE,
        member_address TEXT NOT NULL,
        choice TEXT NOT NULL CHECK (choice IN ('yes', 'no')),
        created_at TEXT NOT NULL,
        PRIMARY KEY (rule_id, member_address)
      );
      CREATE TABLE IF NOT EXISTS commons_sanctions (
        id TEXT PRIMARY KEY,
        community_id TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
        member_address TEXT NOT NULL,
        level INTEGER NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'appealed', 'overturned')),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_commons_sanctions ON commons_sanctions(community_id, member_address, created_at DESC);
      CREATE TABLE IF NOT EXISTS commons_conflicts (
        id TEXT PRIMARY KEY,
        community_id TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
        complainant_address TEXT NOT NULL,
        respondent_address TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
        resolution TEXT,
        arbiter_address TEXT,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_commons_conflicts ON commons_conflicts(community_id, created_at DESC);
    `);
  }
  return _db;
}

registerDatabase("communities", () => {
  _db?.close();
  _db = undefined;
});

type CommunityRow = {
  id: string;
  name: string;
  description: string;
  owner_address: string;
  discount_percent: number;
  pooled_kwh: number;
  contributed_kwh: number;
  allocated_kwh: number;
  member_count: number;
  is_member: number;
  created_at: string;
};

function mapCommunity(row: CommunityRow): Community {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    ownerAddress: row.owner_address,
    discountPercent: row.discount_percent,
    pooledKwh: row.pooled_kwh,
    contributedKwh: row.contributed_kwh,
    allocatedKwh: row.allocated_kwh,
    memberCount: row.member_count,
    isMember: Boolean(row.is_member),
    createdAt: row.created_at,
  };
}

function communityRow(id: string, viewerAddress?: string): CommunityRow | undefined {
  return db().prepare(`
    SELECT c.*,
      (SELECT COUNT(*) FROM community_members m WHERE m.community_id = c.id) AS member_count,
      EXISTS(SELECT 1 FROM community_members m WHERE m.community_id = c.id AND m.member_address = ?) AS is_member
    FROM communities c WHERE c.id = ?
  `).get(viewerAddress ?? "", id) as CommunityRow | undefined;
}

function requireMember(communityId: string, address: string) {
  const member = db().prepare(
    "SELECT 1 FROM community_members WHERE community_id = ? AND member_address = ?",
  ).get(communityId, address);
  if (!member) throw new CommunityError("Join this community before using its shared resources", 403);
}

export function createCommunity(input: {
  name: string;
  description: string;
  ownerAddress: string;
}, now = new Date()): Community {
  const id = crypto.randomUUID();
  const transaction = db().transaction(() => {
    db().prepare(`
      INSERT INTO communities (id, name, description, owner_address, discount_percent, created_at)
      VALUES (?, ?, ?, ?, 0, ?)
    `).run(
      id,
      input.name.trim().slice(0, 100),
      input.description.trim().slice(0, 500),
      input.ownerAddress,
      now.toISOString(),
    );
    db().prepare(`
      INSERT INTO community_members (community_id, member_address, role, joined_at)
      VALUES (?, ?, 'owner', ?)
    `).run(id, input.ownerAddress, now.toISOString());
  });
  transaction();
  return mapCommunity(communityRow(id, input.ownerAddress)!);
}

export function listCommunities(viewerAddress?: string): Community[] {
  const rows = db().prepare(`
    SELECT c.*,
      (SELECT COUNT(*) FROM community_members m WHERE m.community_id = c.id) AS member_count,
      EXISTS(SELECT 1 FROM community_members m WHERE m.community_id = c.id AND m.member_address = ?) AS is_member
    FROM communities c ORDER BY c.created_at DESC
  `).all(viewerAddress ?? "") as CommunityRow[];
  return rows.map(mapCommunity);
}

export function joinCommunity(communityId: string, address: string, now = new Date()): Community {
  const transaction = db().transaction(() => {
    if (!communityRow(communityId)) throw new CommunityError("Community not found", 404);
    try {
      db().prepare(`
        INSERT INTO community_members (community_id, member_address, role, joined_at)
        VALUES (?, ?, 'member', ?)
      `).run(communityId, address, now.toISOString());
    } catch (error) {
      if (error instanceof Error && /UNIQUE/.test(error.message)) {
        throw new CommunityError("Already a member of this community", 409);
      }
      throw error;
    }
  });
  transaction();
  return mapCommunity(communityRow(communityId, address)!);
}

export function leaveCommunity(communityId: string, address: string): boolean {
  const community = communityRow(communityId);
  if (!community) return false;
  if (community.owner_address === address) throw new CommunityError("The owner cannot leave their community", 409);
  return db().prepare(
    "DELETE FROM community_members WHERE community_id = ? AND member_address = ?",
  ).run(communityId, address).changes > 0;
}

export function contributeEnergy(communityId: string, address: string, kwh: number, now = new Date()) {
  if (!Number.isFinite(kwh) || kwh <= 0 || kwh > 1000) throw new CommunityError("kWh must be greater than 0 and at most 1000", 400);
  const transaction = db().transaction(() => {
    requireMember(communityId, address);
    const id = crypto.randomUUID();
    db().prepare("UPDATE communities SET pooled_kwh = pooled_kwh + ?, contributed_kwh = contributed_kwh + ? WHERE id = ?")
      .run(kwh, kwh, communityId);
    db().prepare(`
      INSERT INTO community_energy_transactions (id, community_id, member_address, type, kwh, created_at)
      VALUES (?, ?, ?, 'contribution', ?, ?)
    `).run(id, communityId, address, kwh, now.toISOString());
    return id;
  });
  const id = transaction();
  return db().prepare("SELECT * FROM community_energy_transactions WHERE id = ?").get(id);
}

export function allocateEnergy(communityId: string, address: string, kwh: number, now = new Date()) {
  if (!Number.isFinite(kwh) || kwh <= 0 || kwh > 1000) throw new CommunityError("kWh must be greater than 0 and at most 1000", 400);
  const transaction = db().transaction(() => {
    requireMember(communityId, address);
    const community = communityRow(communityId);
    if (!community) throw new CommunityError("Community not found", 404);
    const boundary = getCommonsBoundary(communityId);
    if (kwh > boundary.maxAllocationKwh) {
      throw new CommunityError(`Allocation exceeds the community boundary of ${boundary.maxAllocationKwh} kWh`, 409);
    }
    const dayStart = new Date(now.getTime() - 86_400_000).toISOString();
    const daily = db().prepare(`
      SELECT COALESCE(SUM(kwh), 0) AS total FROM community_energy_transactions
      WHERE community_id = ? AND member_address = ? AND type = 'allocation' AND created_at >= ?
    `).get(communityId, address, dayStart) as { total: number };
    if (daily.total + kwh > boundary.maxDailyAllocationKwh) {
      throw new CommunityError(`Daily allocation limit of ${boundary.maxDailyAllocationKwh} kWh exceeded`, 409);
    }
    const sanction = activeSanction(communityId, address, now);
    if (sanction) {
      const multiplier = SANCTION_LEVELS[Math.min(sanction.level, SANCTION_LEVELS.length) - 1].allocationMultiplier;
      if (multiplier <= 0) throw new CommunityError("Member is suspended from allocations by an active sanction", 403);
      if (kwh > boundary.maxAllocationKwh * multiplier) {
        throw new CommunityError("Active sanction limits this member's allocation", 403);
      }
    }
    if (community.pooled_kwh < kwh) throw new CommunityError("Insufficient energy in the shared pool", 409);
    const id = crypto.randomUUID();
    db().prepare("UPDATE communities SET pooled_kwh = pooled_kwh - ?, allocated_kwh = allocated_kwh + ? WHERE id = ?")
      .run(kwh, kwh, communityId);
    db().prepare(`
      INSERT INTO community_energy_transactions
        (id, community_id, member_address, type, kwh, discount_percent, created_at)
      VALUES (?, ?, ?, 'allocation', ?, ?, ?)
    `).run(id, communityId, address, kwh, community.discount_percent, now.toISOString());
    return { id, discountPercent: community.discount_percent, discountedKwh: kwh * community.discount_percent / 100 };
  });
  const result = transaction();
  const entry = db().prepare("SELECT * FROM community_energy_transactions WHERE id = ?").get(result.id);
  return { transaction: entry, discountPercent: result.discountPercent, discountedKwh: result.discountedKwh };
}

function activeSanction(communityId: string, address: string, now: Date): CommonsSanction | undefined {
  const row = db().prepare(`
    SELECT * FROM commons_sanctions
    WHERE community_id = ? AND member_address = ? AND status = 'active' AND expires_at > ?
    ORDER BY level DESC, created_at DESC LIMIT 1
  `).get(communityId, address, now.toISOString()) as
    | { id: string; community_id: string; member_address: string; level: number; reason: string;
        status: CommonsSanction["status"]; created_at: string; expires_at: string }
    | undefined;
  if (!row) return undefined;
  return {
    id: row.id,
    communityId: row.community_id,
    memberAddress: row.member_address,
    level: row.level,
    reason: row.reason,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

export function getCommonsBoundary(communityId: string): CommonsBoundary {
  const row = db().prepare("SELECT * FROM commons_boundaries WHERE community_id = ?").get(communityId) as
    | { community_id: string; max_pool_kwh: number; max_allocation_kwh: number; max_daily_allocation_kwh: number; updated_at: string }
    | undefined;
  if (!row) {
    return {
      communityId,
      maxPoolKwh: COMMONS_DEFAULT_BOUNDARY.maxPoolKwh,
      maxAllocationKwh: COMMONS_DEFAULT_BOUNDARY.maxAllocationKwh,
      maxDailyAllocationKwh: COMMONS_DEFAULT_BOUNDARY.maxDailyAllocationKwh,
      updatedAt: "",
    };
  }
  return {
    communityId: row.community_id,
    maxPoolKwh: row.max_pool_kwh,
    maxAllocationKwh: row.max_allocation_kwh,
    maxDailyAllocationKwh: row.max_daily_allocation_kwh,
    updatedAt: row.updated_at,
  };
}

export function setCommonsBoundary(input: {
  communityId: string;
  actorAddress: string;
  maxPoolKwh?: number;
  maxAllocationKwh?: number;
  maxDailyAllocationKwh?: number;
}, now = new Date()): CommonsBoundary {
  const transaction = db().transaction(() => {
    requireMember(input.communityId, input.actorAddress);
    const current = getCommonsBoundary(input.communityId);
    const next = {
      maxPoolKwh: input.maxPoolKwh ?? current.maxPoolKwh,
      maxAllocationKwh: input.maxAllocationKwh ?? current.maxAllocationKwh,
      maxDailyAllocationKwh: input.maxDailyAllocationKwh ?? current.maxDailyAllocationKwh,
    };
    for (const value of Object.values(next)) {
      if (!Number.isFinite(value) || value <= 0) throw new CommunityError("Boundary values must be positive", 400);
    }
    if (next.maxAllocationKwh > next.maxPoolKwh) {
      throw new CommunityError("Max allocation cannot exceed the pool boundary", 400);
    }
    db().prepare(`
      INSERT INTO commons_boundaries (community_id, max_pool_kwh, max_allocation_kwh, max_daily_allocation_kwh, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(community_id) DO UPDATE SET
        max_pool_kwh = excluded.max_pool_kwh,
        max_allocation_kwh = excluded.max_allocation_kwh,
        max_daily_allocation_kwh = excluded.max_daily_allocation_kwh,
        updated_at = excluded.updated_at
    `).run(input.communityId, next.maxPoolKwh, next.maxAllocationKwh, next.maxDailyAllocationKwh, now.toISOString());
  });
  transaction();
  return getCommonsBoundary(input.communityId);
}

export function createCommonsRuleProposal(input: {
  communityId: string;
  proposerAddress: string;
  title: string;
  description: string;
  ruleType: CommonsRule["ruleType"];
  payload?: Record<string, unknown>;
}, now = new Date()): string {
  if (!["boundary", "usage", "sanction", "conflict"].includes(input.ruleType)) {
    throw new CommunityError("Invalid rule type", 400);
  }
  const id = crypto.randomUUID();
  const endsAt = new Date(now.getTime() + PROPOSAL_DURATION_DAYS * 86_400_000);
  const transaction = db().transaction(() => {
    requireMember(input.communityId, input.proposerAddress);
    db().prepare(`
      INSERT INTO commons_rules (id, community_id, proposer_address, title, description, rule_type, payload,
        status, created_at, ends_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)
    `).run(id, input.communityId, input.proposerAddress, input.title.trim().slice(0, 100),
      input.description.trim().slice(0, 500), input.ruleType, JSON.stringify(input.payload ?? {}),
      now.toISOString(), endsAt.toISOString());
    db().prepare(`
      INSERT INTO commons_rule_voters (rule_id, member_address)
      SELECT ?, member_address FROM community_members WHERE community_id = ?
    `).run(id, input.communityId);
  });
  transaction();
  return id;
}

function tallyRule(ruleId: string) {
  return db().prepare(`
    SELECT
      (SELECT COUNT(*) FROM commons_rule_voters WHERE rule_id = ?) AS eligible,
      (SELECT COUNT(*) FROM commons_rule_votes WHERE rule_id = ? AND choice = 'yes') AS yes_votes,
      (SELECT COUNT(*) FROM commons_rule_votes WHERE rule_id = ? AND choice = 'no') AS no_votes
  `).get(ruleId, ruleId, ruleId) as { eligible: number; yes_votes: number; no_votes: number };
}

function applyRule(ruleId: string, now: Date) {
  const rule = db().prepare("SELECT * FROM commons_rules WHERE id = ?").get(ruleId) as
    | { community_id: string; rule_type: CommonsRule["ruleType"]; payload: string }
    | undefined;
  if (!rule) return;
  const payload = JSON.parse(rule.payload || "{}") as Record<string, unknown>;
  if (rule.rule_type === "boundary") {
    setCommonsBoundary({
      communityId: rule.community_id,
      actorAddress: "",
      maxPoolKwh: typeof payload.maxPoolKwh === "number" ? payload.maxPoolKwh : undefined,
      maxAllocationKwh: typeof payload.maxAllocationKwh === "number" ? payload.maxAllocationKwh : undefined,
      maxDailyAllocationKwh: typeof payload.maxDailyAllocationKwh === "number" ? payload.maxDailyAllocationKwh : undefined,
    }, now);
  }
}

function resolveRule(ruleId: string, status: "passed" | "rejected", now: Date) {
  db().prepare("UPDATE commons_rules SET status = ?, resolved_at = ? WHERE id = ? AND status = 'open'")
    .run(status, now.toISOString(), ruleId);
  if (status === "passed") applyRule(ruleId, now);
}

export function castCommonsRuleVote(
  communityId: string,
  ruleId: string,
  address: string,
  choice: "yes" | "no",
  now = new Date(),
) {
  const transaction = db().transaction(() => {
    const rule = db().prepare("SELECT * FROM commons_rules WHERE id = ?").get(ruleId) as
      | { id: string; status: string; ends_at: string; community_id: string }
      | undefined;
    if (!rule || rule.community_id !== communityId) throw new CommunityError("Rule proposal not found", 404);
    if (rule.status !== "open") throw new CommunityError("Rule proposal is closed", 409);
    if (new Date(rule.ends_at) <= now) throw new CommunityError("Voting period has ended", 409);
    const eligible = db().prepare(
      "SELECT 1 FROM commons_rule_voters WHERE rule_id = ? AND member_address = ?",
    ).get(ruleId, address);
    if (!eligible) throw new CommunityError("Only members at proposal creation can vote", 403);
    try {
      db().prepare("INSERT INTO commons_rule_votes (rule_id, member_address, choice, created_at) VALUES (?, ?, ?, ?)")
        .run(ruleId, address, choice, now.toISOString());
    } catch (error) {
      if (error instanceof Error && /UNIQUE/.test(error.message)) throw new CommunityError("Member has already voted", 409);
      throw error;
    }
    const tally = tallyRule(ruleId);
    const votes = tally.yes_votes + tally.no_votes;
    let status: "open" | "passed" | "rejected" = "open";
    if (tally.yes_votes > tally.eligible / 2) status = "passed";
    else if (tally.no_votes >= Math.ceil(tally.eligible / 2) || votes === tally.eligible) status = "rejected";
    if (status !== "open") resolveRule(ruleId, status, now);
    return { status, ...tally };
  });
  return transaction();
}

export function finalizeCommonsRuleProposal(communityId: string, ruleId: string, address: string, now = new Date()) {
  const transaction = db().transaction(() => {
    const rule = db().prepare("SELECT * FROM commons_rules WHERE id = ?").get(ruleId) as
      | { id: string; community_id: string; status: string; ends_at: string }
      | undefined;
    if (!rule || rule.community_id !== communityId) throw new CommunityError("Rule proposal not found", 404);
    requireMember(communityId, address);
    if (rule.status !== "open") return rule.status;
    const tally = tallyRule(ruleId);
    if (new Date(rule.ends_at) > now && tally.yes_votes + tally.no_votes < tally.eligible) {
      throw new CommunityError("Voting is still open", 409);
    }
    const status = tally.yes_votes > tally.eligible / 2 ? "passed" : "rejected";
    resolveRule(ruleId, status, now);
    return status;
  });
  return transaction();
}

export function listCommonsRules(communityId: string, viewerAddress?: string): CommonsRule[] {
  const rows = db().prepare(`
    SELECT r.*,
      (SELECT COUNT(*) FROM commons_rule_votes v WHERE v.rule_id = r.id AND v.choice = 'yes') AS yes_votes,
      (SELECT COUNT(*) FROM commons_rule_votes v WHERE v.rule_id = r.id AND v.choice = 'no') AS no_votes,
      (SELECT COUNT(*) FROM commons_rule_voters v WHERE v.rule_id = r.id) AS eligible_voters,
      (SELECT choice FROM commons_rule_votes v WHERE v.rule_id = r.id AND v.member_address = ?) AS my_vote
    FROM commons_rules r WHERE r.community_id = ? ORDER BY r.created_at DESC LIMIT 50
  `).all(viewerAddress ?? "", communityId) as Array<{
    id: string; community_id: string; proposer_address: string; title: string; description: string;
    rule_type: CommonsRule["ruleType"]; payload: string; status: CommonsRule["status"];
    created_at: string; ends_at: string; yes_votes: number; no_votes: number;
    eligible_voters: number; my_vote: "yes" | "no" | null;
  }>;
  return rows.map((row) => ({
    id: row.id,
    communityId: row.community_id,
    proposerAddress: row.proposer_address,
    title: row.title,
    description: row.description,
    ruleType: row.rule_type,
    payload: JSON.parse(row.payload || "{}") as Record<string, unknown>,
    status: row.status,
    createdAt: row.created_at,
    endsAt: row.ends_at,
    yesVotes: row.yes_votes,
    noVotes: row.no_votes,
    eligibleVoters: row.eligible_voters,
    myVote: row.my_vote,
  }));
}

export function recordCommonsViolation(input: {
  communityId: string;
  reporterAddress: string;
  memberAddress: string;
  reason: string;
}, now = new Date()): CommonsSanction {
  const transaction = db().transaction(() => {
    requireMember(input.communityId, input.reporterAddress);
    requireMember(input.communityId, input.memberAddress);
    const prior = db().prepare(`
      SELECT COUNT(*) AS count FROM commons_sanctions
      WHERE community_id = ? AND member_address = ? AND status IN ('active', 'expired')
    `).get(input.communityId, input.memberAddress) as { count: number };
    const level = Math.min(prior.count + 1, SANCTION_LEVELS.length);
    const durationDays = SANCTION_LEVELS[level - 1].durationDays;
    const id = crypto.randomUUID();
    db().prepare(`
      INSERT INTO commons_sanctions (id, community_id, member_address, level, reason, status, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
    `).run(id, input.communityId, input.memberAddress, level, input.reason.trim().slice(0, 500),
      now.toISOString(), new Date(now.getTime() + durationDays * 86_400_000).toISOString());
    return id;
  });
  const id = transaction();
  const row = db().prepare("SELECT * FROM commons_sanctions WHERE id = ?").get(id) as {
    id: string; community_id: string; member_address: string; level: number; reason: string;
    status: CommonsSanction["status"]; created_at: string; expires_at: string;
  };
  return {
    id: row.id,
    communityId: row.community_id,
    memberAddress: row.member_address,
    level: row.level,
    reason: row.reason,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

export function listCommonsSanctions(communityId: string): CommonsSanction[] {
  const rows = db().prepare(`
    SELECT * FROM commons_sanctions WHERE community_id = ? ORDER BY created_at DESC LIMIT 100
  `).all(communityId) as Array<{
    id: string; community_id: string; member_address: string; level: number; reason: string;
    status: CommonsSanction["status"]; created_at: string; expires_at: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    communityId: row.community_id,
    memberAddress: row.member_address,
    level: row.level,
    reason: row.reason,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  }));
}

export function appealCommonsSanction(input: {
  communityId: string;
  sanctionId: string;
  memberAddress: string;
}, now = new Date()): CommonsSanction {
  const transaction = db().transaction(() => {
    const sanction = db().prepare("SELECT * FROM commons_sanctions WHERE id = ? AND community_id = ?")
      .get(input.sanctionId, input.communityId) as
      | { id: string; member_address: string; status: CommonsSanction["status"] }
      | undefined;
    if (!sanction) throw new CommunityError("Sanction not found", 404);
    if (sanction.member_address !== input.memberAddress) throw new CommunityError("Only the sanctioned member can appeal", 403);
    if (sanction.status !== "active") throw new CommunityError("Only active sanctions can be appealed", 409);
    db().prepare("UPDATE commons_sanctions SET status = 'appealed' WHERE id = ?").run(input.sanctionId);
  });
  transaction();
  return listCommonsSanctions(input.communityId).find((s) => s.id === input.sanctionId)!;
}

export function openCommonsConflict(input: {
  communityId: string;
  complainantAddress: string;
  respondentAddress: string;
  description: string;
}, now = new Date()): CommonsConflict {
  if (input.complainantAddress === input.respondentAddress) {
    throw new CommunityError("A conflict requires two distinct members", 400);
  }
  const id = crypto.randomUUID();
  const transaction = db().transaction(() => {
    requireMember(input.communityId, input.complainantAddress);
    requireMember(input.communityId, input.respondentAddress);
    db().prepare(`
      INSERT INTO commons_conflicts (id, community_id, complainant_address, respondent_address, description,
        status, created_at)
      VALUES (?, ?, ?, ?, ?, 'open', ?)
    `).run(id, input.communityId, input.complainantAddress, input.respondentAddress,
      input.description.trim().slice(0, 1000), now.toISOString());
  });
  transaction();
  return getCommonsConflict(input.communityId, id)!;
}

export function getCommonsConflict(communityId: string, conflictId: string): CommonsConflict | undefined {
  const row = db().prepare("SELECT * FROM commons_conflicts WHERE id = ? AND community_id = ?")
    .get(conflictId, communityId) as
    | { id: string; community_id: string; complainant_address: string; respondent_address: string;
        description: string; status: CommonsConflict["status"]; resolution: string | null;
        arbiter_address: string | null; created_at: string; resolved_at: string | null }
    | undefined;
  if (!row) return undefined;
  return {
    id: row.id,
    communityId: row.community_id,
    complainantAddress: row.complainant_address,
    respondentAddress: row.respondent_address,
    description: row.description,
    status: row.status,
    resolution: row.resolution,
    arbiterAddress: row.arbiter_address,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

export function listCommonsConflicts(communityId: string): CommonsConflict[] {
  const rows = db().prepare(`
    SELECT id FROM commons_conflicts WHERE community_id = ? ORDER BY created_at DESC LIMIT 100
  `).all(communityId) as Array<{ id: string }>;
  return rows.map((row) => getCommonsConflict(communityId, row.id)!).filter(Boolean);
}

export function resolveCommonsConflict(input: {
  communityId: string;
  conflictId: string;
  arbiterAddress: string;
  resolution: string;
  outcome: "resolved" | "dismissed";
}, now = new Date()): CommonsConflict {
  const transaction = db().transaction(() => {
    requireMember(input.communityId, input.arbiterAddress);
    const conflict = getCommonsConflict(input.communityId, input.conflictId);
    if (!conflict) throw new CommunityError("Conflict not found", 404);
    if (conflict.status !== "open") throw new CommunityError("Conflict is already closed", 409);
    if (conflict.complainantAddress === input.arbiterAddress || conflict.respondentAddress === input.arbiterAddress) {
      throw new CommunityError("Parties to a conflict cannot arbitrate it", 403);
    }
    db().prepare(`
      UPDATE commons_conflicts SET status = ?, resolution = ?, arbiter_address = ?, resolved_at = ?
      WHERE id = ?
    `).run(input.outcome, input.resolution.trim().slice(0, 1000), input.arbiterAddress,
      now.toISOString(), input.conflictId);
  });
  transaction();
  return getCommonsConflict(input.communityId, input.conflictId)!;
}

export function getCommonsOverview(communityId: string, viewerAddress?: string) {
  const boundary = getCommonsBoundary(communityId);
  const sanctions = listCommonsSanctions(communityId);
  const conflicts = listCommonsConflicts(communityId);
  const rules = listCommonsRules(communityId, viewerAddress);
  const activeSanctions = sanctions.filter((s) => s.status === "active" && new Date(s.expiresAt) > new Date());
  return {
    boundary,
    rules,
    sanctions,
    conflicts,
    activeSanctionCount: activeSanctions.length,
    openConflictCount: conflicts.filter((c) => c.status === "open").length,
  };
}

export function getMemberDiscountPercent(address: string): number {
  const row = db().prepare(`
    SELECT COALESCE(MAX(c.discount_percent), 0) AS discount
    FROM communities c JOIN community_members m ON m.community_id = c.id
    WHERE m.member_address = ?
  `).get(address) as { discount: number };
  return row.discount;
}

export function createDiscountProposal(input: {
  communityId: string;
  proposerAddress: string;
  title: string;
  description: string;
  discountPercent: number;
}, now = new Date()) {
  if (!Number.isFinite(input.discountPercent) || input.discountPercent < 0 || input.discountPercent > MAX_COMMUNITY_DISCOUNT_PERCENT) {
    throw new CommunityError(`Discount must be between 0 and ${MAX_COMMUNITY_DISCOUNT_PERCENT}%`, 400);
  }
  const id = crypto.randomUUID();
  const endsAt = new Date(now.getTime() + PROPOSAL_DURATION_DAYS * 86_400_000);
  const transaction = db().transaction(() => {
    requireMember(input.communityId, input.proposerAddress);
    db().prepare(`
      INSERT INTO community_proposals (id, community_id, proposer_address, title, description,
        discount_percent, status, created_at, ends_at)
      VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)
    `).run(id, input.communityId, input.proposerAddress, input.title.trim().slice(0, 100),
      input.description.trim().slice(0, 500), input.discountPercent, now.toISOString(), endsAt.toISOString());
    db().prepare(`
      INSERT INTO community_proposal_voters (proposal_id, member_address)
      SELECT ?, member_address FROM community_members WHERE community_id = ?
    `).run(id, input.communityId);
  });
  transaction();
  return id;
}

function tallyProposal(proposalId: string) {
  return db().prepare(`
    SELECT
      (SELECT COUNT(*) FROM community_proposal_voters WHERE proposal_id = ?) AS eligible,
      (SELECT COUNT(*) FROM community_votes WHERE proposal_id = ? AND choice = 'yes') AS yes_votes,
      (SELECT COUNT(*) FROM community_votes WHERE proposal_id = ? AND choice = 'no') AS no_votes
  `).get(proposalId, proposalId, proposalId) as { eligible: number; yes_votes: number; no_votes: number };
}

function resolveProposal(proposalId: string, status: "passed" | "rejected", now: Date) {
  db().prepare("UPDATE community_proposals SET status = ?, resolved_at = ? WHERE id = ? AND status = 'open'")
    .run(status, now.toISOString(), proposalId);
  if (status === "passed") {
    db().prepare(`
      UPDATE communities SET discount_percent = (
        SELECT discount_percent FROM community_proposals WHERE id = ?
      ) WHERE id = (SELECT community_id FROM community_proposals WHERE id = ?)
    `).run(proposalId, proposalId);
  }
  return yesVotes;
}

export function castDiscountVote(
  communityId: string,
  proposalId: string,
  address: string,
  choice: "yes" | "no",
  now = new Date(),
) {
  const transaction = db().transaction(() => {
    const proposal = db().prepare("SELECT * FROM community_proposals WHERE id = ?").get(proposalId) as
      | { id: string; status: string; ends_at: string; community_id: string }
      | undefined;
    if (!proposal) throw new CommunityError("Proposal not found", 404);
    if (proposal.community_id !== communityId) throw new CommunityError("Proposal not found", 404);
    if (proposal.status !== "open") throw new CommunityError("Proposal is closed", 409);
    if (new Date(proposal.ends_at) <= now) throw new CommunityError("Voting period has ended", 409);
    const eligible = db().prepare(
      "SELECT 1 FROM community_proposal_voters WHERE proposal_id = ? AND member_address = ?",
    ).get(proposalId, address);
    if (!eligible) throw new CommunityError("Only members at proposal creation can vote", 403);
    try {
      db().prepare("INSERT INTO community_votes (proposal_id, member_address, choice, created_at) VALUES (?, ?, ?, ?)")
        .run(proposalId, address, choice, now.toISOString());
    } catch (error) {
      if (error instanceof Error && /UNIQUE/.test(error.message)) throw new CommunityError("Member has already voted", 409);
      throw error;
    }
    const tally = tallyProposal(proposalId);
    const votes = tally.yes_votes + tally.no_votes;
    let status: "open" | "passed" | "rejected" = "open";
    if (tally.yes_votes > tally.eligible / 2) status = "passed";
    else if (tally.no_votes >= Math.ceil(tally.eligible / 2) || votes === tally.eligible) status = "rejected";
    if (status !== "open") resolveProposal(proposalId, status, now);
    return { status, ...tally };
  });
  return transaction();
}

export function finalizeDiscountProposal(communityId: string, proposalId: string, address: string, now = new Date()) {
  const transaction = db().transaction(() => {
    const proposal = db().prepare("SELECT * FROM community_proposals WHERE id = ?").get(proposalId) as
      | { id: string; community_id: string; status: string; ends_at: string }
      | undefined;
    if (!proposal) throw new CommunityError("Proposal not found", 404);
    if (proposal.community_id !== communityId) throw new CommunityError("Proposal not found", 404);
    requireMember(communityId, address);
    if (proposal.status !== "open") return proposal.status;
    const tally = tallyProposal(proposalId);
    if (new Date(proposal.ends_at) > now && tally.yes_votes + tally.no_votes < tally.eligible) {
      throw new CommunityError("Voting is still open", 409);
    }
    const status = tally.yes_votes > tally.eligible / 2 ? "passed" : "rejected";
    resolveProposal(proposalId, status, now);
    return status;
  });
  return transaction();
}

export function getCommunityDashboard(communityId: string, viewerAddress?: string) {
  const row = communityRow(communityId, viewerAddress);
  if (!row) return undefined;
  const members = db().prepare(`
    SELECT member_address AS address, role, joined_at AS joinedAt
    FROM community_members WHERE community_id = ? ORDER BY joined_at ASC
  `).all(communityId);
  const energyTransactions = db().prepare(`
    SELECT member_address AS memberAddress, type, kwh, discount_percent AS discountPercent,
      created_at AS createdAt
    FROM community_energy_transactions WHERE community_id = ?
    ORDER BY created_at DESC LIMIT 30
  `).all(communityId);
  const benefits = db().prepare(`
    SELECT COALESCE(SUM(kwh * discount_percent / 100), 0) AS discounted_kwh
    FROM community_energy_transactions WHERE community_id = ? AND type = 'allocation'
  `).get(communityId) as { discounted_kwh: number };
  const proposals = db().prepare(`
    SELECT p.*,
      (SELECT COUNT(*) FROM community_votes v WHERE v.proposal_id = p.id AND v.choice = 'yes') AS yes_votes,
      (SELECT COUNT(*) FROM community_votes v WHERE v.proposal_id = p.id AND v.choice = 'no') AS no_votes,
      (SELECT COUNT(*) FROM community_proposal_voters v WHERE v.proposal_id = p.id) AS eligible_voters,
      (SELECT choice FROM community_votes v WHERE v.proposal_id = p.id AND v.member_address = ?) AS my_vote
    FROM community_proposals p WHERE p.community_id = ? ORDER BY p.created_at DESC LIMIT 50
  `).all(viewerAddress ?? "", communityId) as Array<{
    id: string; community_id: string; proposer_address: string; title: string; description: string;
    discount_percent: number; status: "open" | "passed" | "rejected"; created_at: string; ends_at: string;
    yes_votes: number; no_votes: number; eligible_voters: number; my_vote: "yes" | "no" | null;
  }>;
  return {
    ...mapCommunity(row),
    discountedEnergyKwh: benefits.discounted_kwh,
    commons: getCommonsOverview(communityId, viewerAddress),
    members,
    energyTransactions,
    proposals: proposals.map((proposal): CommunityProposal => ({
      id: proposal.id,
      communityId: proposal.community_id,
      proposerAddress: proposal.proposer_address,
      title: proposal.title,
      description: proposal.description,
      discountPercent: proposal.discount_percent,
      status: proposal.status,
      createdAt: proposal.created_at,
      endsAt: proposal.ends_at,
      yesVotes: proposal.yes_votes,
      noVotes: proposal.no_votes,
      eligibleVoters: proposal.eligible_voters,
      myVote: proposal.my_vote,
    })),
  };
}