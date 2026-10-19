/**
 * Smart home integration core (#904): account linking, device control,
 * energy routines and the voice-activity log shared by the Google Home and
 * Alexa adapters (see smartHomePlatforms.ts).
 *
 * Privacy model
 *   - Linking requires a wallet signature from the meter owner, and only the
 *     meters the owner explicitly selects are exposed to the platform.
 *   - Scopes limit a link to reading state ("read") and/or switching meters
 *     ("control").
 *   - OAuth access and refresh tokens are stored only as SHA-256 hashes.
 *   - Nothing but a meter nickname (or its ID) and on/off/balance state is
 *     sent to Google or Amazon: no wallet addresses and no usage history.
 *   - Voice activity is kept for SMART_HOME_ACTIVITY_RETENTION_DAYS (default
 *     30) then deleted. Owners can list and erase all of their data, and an
 *     unlink from the Google Home / Alexa app deletes the link immediately.
 *     Links unused for SMART_HOME_LINK_INACTIVE_DAYS (default 90) expire.
 */
import crypto from "node:crypto";
import path from "node:path";
import { mkdirSync } from "node:fs";
import Database from "better-sqlite3";
import { registerDatabase } from "./databaseLifecycle.js";
import { getOnChainMeter } from "./meterOwnership.js";
import { logger } from "./logger.js";

const DB_PATH = process.env.SMART_HOME_DB_PATH ?? path.resolve(process.cwd(), "data", "smart-home.sqlite");
const ACCESS_TOKEN_TTL_S = Number(process.env.SMART_HOME_ACCESS_TOKEN_TTL_S ?? 3600);
const AUTH_CODE_TTL_MS = 10 * 60 * 1000;
const ACTIVITY_RETENTION_DAYS = Number(process.env.SMART_HOME_ACTIVITY_RETENTION_DAYS ?? 30);
const LINK_INACTIVE_DAYS = Number(process.env.SMART_HOME_LINK_INACTIVE_DAYS ?? 90);
const STATE_TIMEOUT_MS =Number(process.env.SMART_HOME_STATE_TIMEOUT_MS ?? 4000);
const BALANCE_CHECK_INTERVAL_MS =Number(process.env.SMART_HOME_BALANCE_CHECK_INTERVAL_MS ?? 15 * 60 * 1000);

export type Platform = "google" | "alexa";
export const PLATFORMS: Platform[] = ["google", "alexa"];
export type Scope = "read" | "control";
export const SCOPES: Scope[] = ["read", "control"];
export type RelayCommand = "on" | "off";

export type LinkedMeter = { meterId: string; nickname: string | null };

export type SmartHomeLink = {
  id: string;
  platform: Platform;
  owner_address: string;
  meters: LinkedMeter[];
  scopes: Scope[];
  created_at: string;
  last_used_at: string | null;
};

type LinkRow = Omit<SmartHomeLink, "meters" | "scopes"> & {
  meters: string;
  scopes: string;
  access_hash: string | null;
  access_expires_at: string | null;
  refresh_hash: string;
};

export type RoutineTrigger =
  | { type: "schedule"; time: string; days: number[]; timezone: string }
  | { type: "balance_below"; meterId: string; threshold: number }
  | { type: "voice" };

export type RoutineAction = { meterId: string; command: RelayCommand };

export type Routine = {
  id: string;
  owner_address: string;
  name: string;
  enabled: boolean;
  trigger: RoutineTrigger;
  actions: RoutineAction[];
  created_at: string;
  updated_at: string;
  last_run_at: string | null;
};

type RoutineRow = Omit<Routine, "enabled" | "trigger" | "actions"> & {
  enabled: number;
  trigger_def: string;
  actions: string;
  armed: number;
};

export type ActivityEntry = {
  id: number;
  owner_address: string;
  platform: string;
  action: string;
  meter_id: string | null;
  result: string;
  created_at: string;
};

// ── Storage ──────────────────────────────────────────────────────────────────

let _db: Database.Database | undefined;

function db(): Database.Database {
  if (!_db) {
    mkdirSync(path.dirname(DB_PATH), { recursive: true });
    _db = new Database(DB_PATH);
    _db.pragma("journal_mode = WAL");
    _db.exec(`
      CREATE TABLE IF NOT EXISTS smart_home_links (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        owner_address TEXT NOT NULL,
        meters TEXT NOT NULL,
        scopes TEXT NOT NULL,
        access_hash TEXT UNIQUE,
        access_expires_at TEXT,
        refresh_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        last_used_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_sh_links_owner ON smart_home_links (owner_address);
      CREATE TABLE IF NOT EXISTS smart_home_routines (
        id TEXT PRIMARY KEY,
        owner_address TEXT NOT NULL,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        trigger_def TEXT NOT NULL,
        actions TEXT NOT NULL,
        armed INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_run_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_sh_routines_owner ON smart_home_routines (owner_address);
      CREATE TABLE IF NOT EXISTS smart_home_relay_state (
        meter_id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        source TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS smart_home_activity (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_address TEXT NOT NULL,
        platform TEXT NOT NULL,
        action TEXT NOT NULL,
        meter_id TEXT,
        result TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sh_activity_owner ON smart_home_activity (owner_address, created_at DESC);
    `);
  }
  return _db;
}

registerDatabase("smart-home", () => {
  _db?.close();
  _db = undefined;
});

const hash = (v: string) => crypto.createHash("sha256").update(v).digest("hex");

// ── OAuth clients & account linking ──────────────────────────────────────────

export type OAuthClient = { platform: Platform; clientId: string; clientSecret: string; redirectUris: string[] };

export function oauthClients(): OAuthClient[] {
  return PLATFORMS.flatMap((platform) => {
    const prefix = `SMART_HOME_${platform.toUpperCase()}`;
    const clientId = process.env[`${prefix}_CLIENT_ID`];
    const clientSecret = process.env[`${prefix}_CLIENT_SECRET`];
    if (!clientId || !clientSecret) return [];
    const redirectUris = (process.env[`${prefix}_REDIRECT_URIS`] ?? "")
      .split(",")
      .map((u) => u.trim())
      .filter(Boolean);
    return [{ platform, clientId, clientSecret, redirectUris }];
  });
}

export function findClient(clientId: string | undefined): OAuthClient | undefined {
  return oauthClients().find((c) => c.clientId === clientId);
}

function secretsEqual(a: string, b: string): boolean {
  const ha = Buffer.from(hash(a));
  const hb = Buffer.from(hash(b));
  return crypto.timingSafeEqual(ha, hb);
}

export function authenticateClient(clientId: string | undefined, clientSecret: string | undefined): OAuthClient | undefined {
  const client = findClient(clientId);
  if (!client || !clientSecret || !secretsEqual(client.clientSecret, clientSecret)) return undefined;
  return client;
}

type PendingCode = {
  clientId: string;
  redirectUri: string;
  ownerAddress: string;
  meters: LinkedMeter[];
  scopes: Scope[];
  expiresAt: number;
};

const authCodes = new Map<string, PendingCode>();

/** Issue a single-use authorization code after the owner consented in the web app. */
export function issueAuthCode(input: Omit<PendingCode, "expiresAt">): string {
  for (const [k, v] of authCodes) if (v.expiresAt <= Date.now()) authCodes.delete(k);
  const code = crypto.randomBytes(32).toString("hex");
  authCodes.set(hash(code), { ...input, expiresAt: Date.now() + AUTH_CODE_TTL_MS });
  return code;
}

export type TokenResponse = {
  token_type: "Bearer";
  access_token: string;
  refresh_token?: string;
  expires_in: number;
};

function newAccessToken(linkId: string): { token: string; expiresAt: string } {
  const token = `sha_${crypto.randomBytes(32).toString("hex")}`;
  const expiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_S * 1000).toISOString();
  db().prepare("UPDATE smart_home_links SET access_hash = ?, access_expires_at = ? WHERE id = ?").run(hash(token), expiresAt, linkId);
  return { token, expiresAt };
}

export function exchangeAuthCode(client: OAuthClient, code: string, redirectUri: string | undefined): TokenResponse | undefined {
  const key = hash(code);
  const pending = authCodes.get(key);
  authCodes.delete(key);
  if (!pending || pending.expiresAt <= Date.now()) return undefined;
  if (pending.clientId !== client.clientId) return undefined;
  if (redirectUri && redirectUri !== pending.redirectUri) return undefined;

  const id = crypto.randomUUID();
  const refresh = `shr_${crypto.randomBytes(32).toString("hex")}`;
  db()
    .prepare(
      `INSERT INTO smart_home_links (id, platform, owner_address, meters, scopes, refresh_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, client.platform, pending.ownerAddress, JSON.stringify(pending.meters), JSON.stringify(pending.scopes), hash(refresh), new Date().toISOString());
  const access = newAccessToken(id);
  logActivity(pending.ownerAddress, client.platform, "link", null, "ok");
  return { token_type: "Bearer", access_token: access.token, refresh_token: refresh, expires_in: ACCESS_TOKEN_TTL_S };
}

export function refreshAccessToken(client: OAuthClient, refreshToken: string): TokenResponse | undefined {
  const row = db()
    .prepare("SELECT id FROM smart_home_links WHERE refresh_hash = ? AND platform = ?")
    .get(hash(refreshToken), client.platform) as { id: string } | undefined;
  if (!row) return undefined;
  const access = newAccessToken(row.id);
  return { token_type: "Bearer", access_token: access.token, expires_in: ACCESS_TOKEN_TTL_S };
}

function toLink(row: LinkRow): SmartHomeLink {
  return {
    id: row.id,
    platform: row.platform,
    owner_address: row.owner_address,
    meters: JSON.parse(row.meters),
    scopes: JSON.parse(row.scopes),
    created_at: row.created_at,
    last_used_at: row.last_used_at,
  };
}

/** Resolve a platform bearer token to its link, or undefined if invalid/expired. */
export function linkFromAccessToken(token: string | undefined): SmartHomeLink | undefined {
  if (!token) return undefined;
  const row = db().prepare("SELECT * FROM smart_home_links WHERE access_hash = ?").get(hash(token)) as LinkRow | undefined;
  if (!row || !row.access_expires_at || new Date(row.access_expires_at) <= new Date()) return undefined;
  db().prepare("UPDATE smart_home_links SET last_used_at = ? WHERE id = ?").run(new Date().toISOString(), row.id);
  return toLink(row);
}

export function listLinks(ownerAddress: string): SmartHomeLink[] {
  return (db().prepare("SELECT * FROM smart_home_links WHERE owner_address = ? ORDER BY created_at DESC").all(ownerAddress) as LinkRow[]).map(toLink);
}

export function deleteLink(id: string, ownerAddress?: string): boolean {
  const link = db().prepare("SELECT * FROM smart_home_links WHERE id = ?").get(id) as LinkRow | undefined;
  if (!link || (ownerAddress && link.owner_address !== ownerAddress)) return false;
  db().prepare("DELETE FROM smart_home_links WHERE id = ?").run(id);
  logActivity(link.owner_address, link.platform, "unlink", null, "ok");
  return true;
}

/** Erase everything held for an owner: links, routines and activity history. */
export function eraseOwnerData(ownerAddress: string): { links: number; routines: number; activity: number } {
  const d = db();
  return d.transaction(() => ({
    links: d.prepare("DELETE FROM smart_home_links WHERE owner_address = ?").run(ownerAddress).changes,
    routines: d.prepare("DELETE FROM smart_home_routines WHERE owner_address = ?").run(ownerAddress).changes,
    activity: d.prepare("DELETE FROM smart_home_activity WHERE owner_address = ?").run(ownerAddress).changes,
  }))();
}

// ── Activity log ─────────────────────────────────────────────────────────────

export function logActivity(ownerAddress: string, platform: string, action: string, meterId: string | null, result: string): void {
  db()
    .prepare("INSERT INTO smart_home_activity (owner_address, platform, action, meter_id, result, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(ownerAddress, platform, action, meterId, result, new Date().toISOString());
}

export function listActivity(ownerAddress: string, limit = 100): ActivityEntry[] {
  return db()
    .prepare("SELECT * FROM smart_home_activity WHERE owner_address = ? ORDER BY id DESC LIMIT ?")
    .all(ownerAddress, limit) as ActivityEntry[];
}

export function pruneActivity(now = new Date()): number {
  const cutoff = new Date(now.getTime() - ACTIVITY_RETENTION_DAYS * 86_400_000).toISOString();
  // Links nobody has used for LINK_INACTIVE_DAYS are removed too — this also
  // cleans up skills disabled on the platform side without an unlink callback.
  const linkCutoff = new Date(now.getTime() - LINK_INACTIVE_DAYS * 86_400_000).toISOString();
  db().prepare("DELETE FROM smart_home_links WHERE COALESCE(last_used_at, created_at) < ?").run(linkCutoff);
  return db().prepare("DELETE FROM smart_home_activity WHERE created_at < ?").run(cutoff).changes;
}

// ── Device state & control ───────────────────────────────────────────────────

export type MeterState = {
  meterId: string;
  online: boolean;
  on: boolean;
  /** Contract says the meter has paid-up access. */
  active: boolean;
  balance: number;
};

export async function getMeterState(meterId: string): Promise<MeterState> {
  const relay = db().prepare("SELECT state FROM smart_home_relay_state WHERE meter_id = ?").get(meterId) as
    | { state: string }
    | undefined;
  try {
    // Assistants expect a reply within a few seconds; treat a slow RPC as offline.
    const meter = await Promise.race([
      getOnChainMeter(meterId),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), STATE_TIMEOUT_MS).unref?.()),
    ]);
    if (!meter) return { meterId, online: false, on: false, active: false, balance: 0 };
    return { meterId, online: true, on: meter.active && relay?.state !== "OFF", active: meter.active, balance: meter.balance };
  } catch {
    return { meterId, online: false, on: relay?.state === "ON", active: false, balance: 0 };
  }
}

export type CommandResult = { ok: true; state: MeterState } | { ok: false; error: "noCredit" | "offline" | "notLinked" };

type RelaySender = (meterId: string, command: "ON" | "OFF", source: string) => boolean;
let relaySender: RelaySender = () => false;

/** Wired to the IoT bridge at startup; replaceable in tests. */
export function setRelaySender(fn: RelaySender): void {
  relaySender = fn;
}

/**
 * Switch a meter. Turning a meter on never overrides billing: a meter
 * without paid-up access stays off and the assistant is told why.
 */
export async function executeCommand(
  ownerAddress: string,
  meterId: string,
  command: RelayCommand,
  source: string,
): Promise<CommandResult> {
  const state = await getMeterState(meterId);
  let result: CommandResult;
  if (!state.online) result = { ok: false, error: "offline" };
  else if (command === "on" && !state.active) result = { ok: false, error: "noCredit" };
  else if (!relaySender(meterId, command === "on" ? "ON" : "OFF", source)) result = { ok: false, error: "offline" };
  else {
    db()
      .prepare(
        `INSERT INTO smart_home_relay_state (meter_id, state, source, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (meter_id) DO UPDATE SET state = excluded.state, source = excluded.source, updated_at = excluded.updated_at`,
      )
      .run(meterId, command.toUpperCase(), source, new Date().toISOString());
    result = { ok: true, state: { ...state, on: command === "on" } };
  }
  logActivity(ownerAddress, source, `turn_${command}`, meterId, result.ok ? "ok" : result.error);
  return result;
}

// ── Routines ─────────────────────────────────────────────────────────────────

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Validate routine input; returns an error message or the normalised routine fields. */
export function validateRoutineInput(input: unknown): { name: string; trigger: RoutineTrigger; actions: RoutineAction[] } | string {
  if (!input || typeof input !== "object") return "body must be an object";
  const { name, trigger, actions } = input as Record<string, unknown>;
  if (typeof name !== "string" || !name.trim()) return "name is required";
  if (!trigger || typeof trigger !== "object") return "trigger is required";
  const t = trigger as Record<string, unknown>;
  let parsedTrigger: RoutineTrigger;
  switch (t.type) {
    case "schedule": {
      const days = t.days ?? [0, 1, 2, 3, 4, 5, 6];
      const timezone = (t.timezone as string | undefined) ?? "UTC";
      if (typeof t.time !== "string" || !TIME_RE.test(t.time)) return "trigger.time must be HH:MM (24h)";
      if (!Array.isArray(days) || !days.length || !days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) {
        return "trigger.days must be a non-empty array of weekday numbers 0 (Sun) – 6 (Sat)";
      }
      if (!isValidTimezone(timezone)) return "trigger.timezone must be an IANA time zone";
      parsedTrigger = { type: "schedule", time: t.time, days: [...new Set(days as number[])].sort(), timezone };
      break;
    }
    case "balance_below":
      if (typeof t.meterId !== "string" || !t.meterId) return "trigger.meterId is required";
      if (typeof t.threshold !== "number" || t.threshold < 0) return "trigger.threshold must be a non-negative stroop amount";
      parsedTrigger = { type: "balance_below", meterId: t.meterId, threshold: t.threshold };
      break;
    case "voice":
      parsedTrigger = { type: "voice" };
      break;
    default:
      return "trigger.type must be schedule, balance_below or voice";
  }
  if (!Array.isArray(actions) || !actions.length || actions.length > 20) return "actions must be an array of 1–20 actions";
  for (const a of actions) {
    if (!a || typeof a !== "object" || typeof a.meterId !== "string" || !["on", "off"].includes(a.command)) {
      return "each action needs a meterId and a command of on or off";
    }
  }
  return {
    name: name.trim().slice(0, 60),
    trigger: parsedTrigger,
    actions: (actions as RoutineAction[]).map((a) => ({ meterId: a.meterId, command: a.command })),
  };
}

function toRoutine(row: RoutineRow): Routine {
  const { armed: _armed, trigger_def, ...rest } = row;
  return { ...rest, enabled: row.enabled === 1, trigger: JSON.parse(trigger_def), actions: JSON.parse(row.actions) };
}

export function listRoutines(ownerAddress: string): Routine[] {
  return (db().prepare("SELECT * FROM smart_home_routines WHERE owner_address = ? ORDER BY created_at").all(ownerAddress) as RoutineRow[]).map(toRoutine);
}

export function getRoutine(id: string): Routine | undefined {
  const row = db().prepare("SELECT * FROM smart_home_routines WHERE id = ?").get(id) as RoutineRow | undefined;
  return row ? toRoutine(row) : undefined;
}

export function createRoutine(ownerAddress: string, input: { name: string; trigger: RoutineTrigger; actions: RoutineAction[] }): Routine {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db()
    .prepare(
      `INSERT INTO smart_home_routines (id, owner_address, name, enabled, trigger_def, actions, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?)`,
    )
    .run(id, ownerAddress, input.name, JSON.stringify(input.trigger), JSON.stringify(input.actions), now, now);
  return getRoutine(id)!;
}

export function updateRoutine(
  id: string,
  patch: { name?: string; enabled?: boolean; trigger?: RoutineTrigger; actions?: RoutineAction[] },
): Routine | undefined {
  const r = getRoutine(id);
  if (!r) return undefined;
  db()
    .prepare("UPDATE smart_home_routines SET name = ?, enabled = ?, trigger_def = ?, actions = ?, armed = 1, updated_at = ? WHERE id = ?")
    .run(
      patch.name ?? r.name,
      (patch.enabled ?? r.enabled) ? 1 : 0,
      JSON.stringify(patch.trigger ?? r.trigger),
      JSON.stringify(patch.actions ?? r.actions),
      new Date().toISOString(),
      id,
    );
  return getRoutine(id);
}

export function deleteRoutine(id: string): boolean {
  return db().prepare("DELETE FROM smart_home_routines WHERE id = ?").run(id).changes > 0;
}

export async function runRoutine(routine: Routine, source: string): Promise<{ meterId: string; command: RelayCommand; ok: boolean; error?: string }[]> {
  const results = [];
  for (const action of routine.actions) {
    const r = await executeCommand(routine.owner_address, action.meterId, action.command, source);
    results.push({ ...action, ok: r.ok, ...(r.ok ? {} : { error: r.error }) });
  }
  db().prepare("UPDATE smart_home_routines SET last_run_at = ? WHERE id = ?").run(new Date().toISOString(), routine.id);
  logActivity(routine.owner_address, source, `routine:${routine.name}`, null, results.every((r) => r.ok) ? "ok" : "partial");
  return results;
}

/** Voice-triggerable routines, exposed to assistants as scenes. */
export function voiceRoutines(ownerAddress: string): Routine[] {
  return listRoutines(ownerAddress).filter((r) => r.enabled);
}

function localClock(now: Date, timeZone: string): { hhmm: string; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  return { hhmm: `${get("hour")}:${get("minute")}`, weekday };
}

let lastBalanceCheck = 0;
let tickRunning = false;

export async function routineTick(now = new Date()): Promise<void> {
  if (tickRunning) return;
  tickRunning = true;
  try {
    const rows = db().prepare("SELECT * FROM smart_home_routines WHERE enabled = 1").all() as RoutineRow[];
    const checkBalances = now.getTime() - lastBalanceCheck >= BALANCE_CHECK_INTERVAL_MS;
    if (checkBalances) lastBalanceCheck = now.getTime();

    for (const row of rows) {
      const routine = toRoutine(row);
      const trigger = routine.trigger;
      if (trigger.type === "schedule") {
        const { hhmm, weekday } = localClock(now, trigger.timezone);
        const recentlyRan = routine.last_run_at && now.getTime() - new Date(routine.last_run_at).getTime() < 2 * 60_000;
        if (hhmm === trigger.time && trigger.days.includes(weekday) && !recentlyRan) await runRoutine(routine, "routine");
      } else if (trigger.type === "balance_below" && checkBalances) {
        const state = await getMeterState(trigger.meterId);
        if (!state.online) continue;
        const below = state.balance < trigger.threshold;
        // Fire once per crossing: disarm after running, re-arm when balance recovers.
        if (below && row.armed) {
          await runRoutine(routine, "routine");
          db().prepare("UPDATE smart_home_routines SET armed = 0 WHERE id = ?").run(routine.id);
        } else if (!below && !row.armed) {
          db().prepare("UPDATE smart_home_routines SET armed = 1 WHERE id = ?").run(routine.id);
        }
      }
    }
  } catch (err) {
    logger.error("Smart home routine tick failed", { error: err instanceof Error ? err.message : String(err) });
  } finally {
    tickRunning = false;
  }
}

let routineTimer: NodeJS.Timeout | undefined;
let pruneTimer: NodeJS.Timeout | undefined;

export function startSmartHomeScheduler(): void {
  if (routineTimer || process.env.SMART_HOME_ENABLED === "false") return;
  routineTimer = setInterval(() => void routineTick(), 60_000);
  routineTimer.unref?.();
  pruneActivity();
  pruneTimer = setInterval(() => pruneActivity(), 24 * 60 * 60 * 1000);
  pruneTimer.unref?.();
}

export function stopSmartHomeScheduler(): void {
  if (routineTimer) clearInterval(routineTimer);
  if (pruneTimer) clearInterval(pruneTimer);
  routineTimer = pruneTimer = undefined;
}
