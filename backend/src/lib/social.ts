import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { getMeterUsageStats, type MeterUsageStats } from "./usageEvents.js";

const DB_PATH =
  process.env.SOCIAL_DB_PATH ??
  path.resolve(process.cwd(), "data", "social.sqlite");

export type Privacy = {
  showOnLeaderboard: boolean;
  showActivity: boolean;
  publicProfile: boolean;
};

export type Profile = {
  address: string;
  displayName: string;
  bio: string;
  avatarUrl: string | null;
  meterIds: string[];
  privacy: Privacy;
  updatedAt: string;
};

export type UserStats = {
  totalUnits: number;
  totalCost: number;
  events: number;
  activeDays: number;
  meters: number;
  profileComplete: boolean;
};

export type Achievement = {
  id: string;
  name: string;
  description: string;
  test: (s: UserStats) => boolean;
};

const DEFAULT_PRIVACY: Privacy = { showOnLeaderboard: true, showActivity: true, publicProfile: true };

const db = (() => {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const d = new Database(DB_PATH);
  d.pragma("journal_mode = WAL");
  d.exec(`
    CREATE TABLE IF NOT EXISTS profiles (
      address TEXT PRIMARY KEY,
      display_name TEXT NOT NULL DEFAULT '',
      bio TEXT NOT NULL DEFAULT '',
      avatar_url TEXT,
      meter_ids TEXT NOT NULL DEFAULT '[]',
      privacy TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_achievements (
      address TEXT NOT NULL,
      achievement_id TEXT NOT NULL,
      unlocked_at TEXT NOT NULL,
      PRIMARY KEY (address, achievement_id)
    );
    CREATE TABLE IF NOT EXISTS activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      address TEXT NOT NULL,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_activity_created ON activity (created_at DESC);
    CREATE TABLE IF NOT EXISTS leaderboard_snapshots (
      board TEXT NOT NULL,
      day TEXT NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY (board, day)
    );
  `);
  return d;
})();

// ── Achievements (24) ────────────────────────────────────────────────────────
const tier = (id: string, name: string, desc: string, test: (s: UserStats) => boolean): Achievement =>
  ({ id, name, description: desc, test });

export const ACHIEVEMENTS: Achievement[] = [
  tier("first_spark", "First Spark", "Record your first energy usage", (s) => s.events >= 1),
  tier("ten_readings", "Getting Started", "Record 10 usage events", (s) => s.events >= 10),
  tier("hundred_readings", "Steady Flow", "Record 100 usage events", (s) => s.events >= 100),
  tier("thousand_readings", "Data Dynamo", "Record 1,000 usage events", (s) => s.events >= 1000),
  tier("green_10", "Seedling", "Consume 10 units of solar energy", (s) => s.totalUnits >= 10),
  tier("green_100", "Sprout", "Consume 100 units of solar energy", (s) => s.totalUnits >= 100),
  tier("green_1k", "Sunflower", "Consume 1,000 units of solar energy", (s) => s.totalUnits >= 1_000),
  tier("green_10k", "Solar Grove", "Consume 10,000 units of solar energy", (s) => s.totalUnits >= 10_000),
  tier("green_100k", "Sun Forest", "Consume 100,000 units of solar energy", (s) => s.totalUnits >= 100_000),
  tier("trader_1", "First Trade", "Pay for energy for the first time", (s) => s.totalCost > 0),
  tier("trader_100", "Market Regular", "Trade 100 in energy value", (s) => s.totalCost >= 100),
  tier("trader_1k", "Energy Merchant", "Trade 1,000 in energy value", (s) => s.totalCost >= 1_000),
  tier("trader_10k", "Grid Tycoon", "Trade 10,000 in energy value", (s) => s.totalCost >= 10_000),
  tier("days_3", "Habit Forming", "Be active on 3 different days", (s) => s.activeDays >= 3),
  tier("days_7", "Week Warrior", "Be active on 7 different days", (s) => s.activeDays >= 7),
  tier("days_30", "Monthly Maven", "Be active on 30 different days", (s) => s.activeDays >= 30),
  tier("days_100", "Centurion", "Be active on 100 different days", (s) => s.activeDays >= 100),
  tier("days_365", "Year of Sun", "Be active on 365 different days", (s) => s.activeDays >= 365),
  tier("meter_1", "Plugged In", "Link a meter to your profile", (s) => s.meters >= 1),
  tier("meter_3", "Multi-Site", "Link 3 meters to your profile", (s) => s.meters >= 3),
  tier("meter_10", "Mini Grid", "Link 10 meters to your profile", (s) => s.meters >= 10),
  tier("profile_complete", "Identity", "Complete your profile (name, bio, avatar)", (s) => s.profileComplete),
  tier("efficient", "Efficiency Expert", "Average under 1.0 cost per unit over 100+ units",
    (s) => s.totalUnits >= 100 && s.totalCost / s.totalUnits < 1),
  tier("all_rounder", "All-Rounder", "1,000 units, 1,000 traded and 30 active days",
    (s) => s.totalUnits >= 1_000 && s.totalCost >= 1_000 && s.activeDays >= 30),
];

// ── Profiles ────────────────────────────────────────────────────────────────
type ProfileRow = {
  address: string; display_name: string; bio: string; avatar_url: string | null;
  meter_ids: string; privacy: string; updated_at: string;
};

const toProfile = (r: ProfileRow): Profile => ({
  address: r.address,
  displayName: r.display_name,
  bio: r.bio,
  avatarUrl: r.avatar_url,
  meterIds: JSON.parse(r.meter_ids),
  privacy: { ...DEFAULT_PRIVACY, ...JSON.parse(r.privacy) },
  updatedAt: r.updated_at,
});

export function getProfile(address: string): Profile | null {
  const row = db.prepare("SELECT * FROM profiles WHERE address = ?").get(address) as ProfileRow | undefined;
  return row ? toProfile(row) : null;
}

function allProfiles(): Profile[] {
  return (db.prepare("SELECT * FROM profiles").all() as ProfileRow[]).map(toProfile);
}

export function upsertProfile(
  address: string,
  patch: Partial<Pick<Profile, "displayName" | "bio" | "avatarUrl" | "meterIds">> & { privacy?: Partial<Privacy> },
): Profile {
  const existing = getProfile(address);
  const next: Profile = {
    address,
    displayName: (patch.displayName ?? existing?.displayName ?? "").slice(0, 50),
    bio: (patch.bio ?? existing?.bio ?? "").slice(0, 280),
    avatarUrl: patch.avatarUrl !== undefined ? patch.avatarUrl : existing?.avatarUrl ?? null,
    meterIds: patch.meterIds ?? existing?.meterIds ?? [],
    privacy: { ...DEFAULT_PRIVACY, ...existing?.privacy, ...patch.privacy },
    updatedAt: new Date().toISOString(),
  };
  db.prepare(
    `INSERT INTO profiles (address, display_name, bio, avatar_url, meter_ids, privacy, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(address) DO UPDATE SET display_name = excluded.display_name, bio = excluded.bio,
       avatar_url = excluded.avatar_url, meter_ids = excluded.meter_ids,
       privacy = excluded.privacy, updated_at = excluded.updated_at`,
  ).run(next.address, next.displayName, next.bio, next.avatarUrl, JSON.stringify(next.meterIds),
    JSON.stringify(next.privacy), next.updatedAt);
  if (!existing) addActivity(address, "joined", `${next.displayName || shortAddr(address)} joined the community`);
  syncAchievements(address);
  return next;
}

/** Public view of a profile — hides details when the owner opted out. */
export function publicProfile(p: Profile) {
  if (!p.privacy.publicProfile) return { address: p.address, displayName: "Private user", private: true };
  return { address: p.address, displayName: p.displayName, bio: p.bio, avatarUrl: p.avatarUrl,
    meterCount: p.meterIds.length, achievements: getUserAchievements(p.address) };
}

// ── Stats & achievements ────────────────────────────────────────────────────
function statsFor(p: Profile, usage: Map<string, MeterUsageStats>): UserStats {
  const s: UserStats = { totalUnits: 0, totalCost: 0, events: 0, activeDays: 0, meters: p.meterIds.length,
    profileComplete: Boolean(p.displayName && p.bio && p.avatarUrl) };
  for (const m of p.meterIds) {
    const u = usage.get(m);
    if (!u) continue;
    s.totalUnits += u.total_units;
    s.totalCost += u.total_cost;
    s.events += u.event_count;
    s.activeDays = Math.max(s.activeDays, u.active_days);
  }
  return s;
}

const usageMap = () => new Map(getMeterUsageStats().map((u) => [u.meter_id, u]));

export function syncAchievements(address: string, usage = usageMap()): string[] {
  const profile = getProfile(address);
  if (!profile) return [];
  const stats = statsFor(profile, usage);
  const insert = db.prepare(
    "INSERT OR IGNORE INTO user_achievements (address, achievement_id, unlocked_at) VALUES (?, ?, ?)",
  );
  const unlocked: string[] = [];
  for (const a of ACHIEVEMENTS) {
    if (a.test(stats) && insert.run(address, a.id, new Date().toISOString()).changes) {
      unlocked.push(a.id);
      addActivity(address, "achievement", `${profile.displayName || shortAddr(address)} unlocked "${a.name}"`);
    }
  }
  return unlocked;
}

export function getUserAchievements(address: string) {
  const rows = db.prepare("SELECT achievement_id, unlocked_at FROM user_achievements WHERE address = ?")
    .all(address) as { achievement_id: string; unlocked_at: string }[];
  const unlocked = new Map(rows.map((r) => [r.achievement_id, r.unlocked_at]));
  return ACHIEVEMENTS.map(({ id, name, description }) =>
    ({ id, name, description, unlockedAt: unlocked.get(id) ?? null }));
}

// ── Leaderboards (snapshotted once per UTC day) ─────────────────────────────
export type Board = "green" | "trader";

export function getLeaderboard(board: Board, limit = 20) {
  const day = new Date().toISOString().slice(0, 10);
  const cached = db.prepare("SELECT data FROM leaderboard_snapshots WHERE board = ? AND day = ?")
    .get(board, day) as { data: string } | undefined;
  const entries = cached ? JSON.parse(cached.data) : refreshLeaderboards(day)[board];
  return { board, day, entries: entries.slice(0, limit) };
}

export function refreshLeaderboards(day = new Date().toISOString().slice(0, 10)) {
  const usage = usageMap();
  const rows = allProfiles()
    .filter((p) => p.privacy.showOnLeaderboard)
    .map((p) => {
      syncAchievements(p.address, usage);
      const s = statsFor(p, usage);
      return { address: p.address, displayName: p.privacy.publicProfile ? p.displayName : "Private user",
        green: s.totalUnits, trader: s.totalCost };
    });
  const rank = (key: Board) => rows
    .filter((r) => r[key] > 0)
    .sort((a, b) => b[key] - a[key])
    .map((r, i) => ({ rank: i + 1, address: r.address, displayName: r.displayName, score: r[key] }));
  const result = { green: rank("green"), trader: rank("trader") };
  const save = db.prepare("INSERT OR REPLACE INTO leaderboard_snapshots (board, day, data) VALUES (?, ?, ?)");
  for (const b of ["green", "trader"] as const) save.run(b, day, JSON.stringify(result[b]));
  return result;
}

let dailyTimer: NodeJS.Timeout | undefined;
/** Rebuild leaderboards every 24h (first run happens lazily on request). */
export function startLeaderboardScheduler() {
  if (dailyTimer) return;
  dailyTimer = setInterval(() => refreshLeaderboards(), 24 * 60 * 60 * 1000);
  dailyTimer.unref();
}

// ── Activity feed ───────────────────────────────────────────────────────────
export function addActivity(address: string, type: string, message: string) {
  db.prepare("INSERT INTO activity (address, type, message, created_at) VALUES (?, ?, ?, ?)")
    .run(address, type, message, new Date().toISOString());
}

/** Community feed; entries from users who hid their activity are excluded. */
export function getActivityFeed(limit = 50, before?: number) {
  const rows = db.prepare(
    `SELECT * FROM activity WHERE (@before IS NULL OR id < @before) ORDER BY id DESC LIMIT @limit`,
  ).all({ before: before ?? null, limit: limit * 2 }) as
    { id: number; address: string; type: string; message: string; created_at: string }[];
  const hidden = new Set(allProfiles().filter((p) => !p.privacy.showActivity).map((p) => p.address));
  return rows.filter((r) => !hidden.has(r.address)).slice(0, limit);
}

const shortAddr = (a: string) => (a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);
