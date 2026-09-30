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