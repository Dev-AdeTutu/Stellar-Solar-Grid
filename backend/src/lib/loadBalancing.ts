import { randomUUID } from "node:crypto";
import { z } from "zod";
import { DeviceIdSchema, TransferAckSchema } from "../iot/telemetrySchemas.js";
import { latestObservation, operationsDb, type Observation } from "./meterOperationsStore.js";

export const LoadRuleSchema = z.object({
  id: DeviceIdSchema,
  enabled: z.boolean().default(false),
  controllerId: DeviceIdSchema,
  members: z.array(z.object({ meterId: DeviceIdSchema, capacityWatts: z.number().finite().positive().max(1_000_000_000) }).strict()).min(2).max(20),
  // Explicit directed, electrically commissioned paths. Never infer connectivity from geography.
  paths: z.array(z.object({ from: DeviceIdSchema, to: DeviceIdSchema }).strict()).min(1).max(100),
  overloadRatio: z.number().min(0.5).max(1).default(0.9),
  targetRatio: z.number().min(0.1).max(0.9).default(0.7),
  reserveWatts: z.number().finite().min(0).max(1_000_000_000).default(100),
  maxTransferWatts: z.number().finite().positive().max(1_000_000_000),
  minTransferWatts: z.number().finite().positive().default(1),
  staleAfterMs: z.number().int().min(1000).max(300_000).default(30_000),
  ackTimeoutMs: z.number().int().min(1000).max(60_000).default(10_000),
  cooldownMs: z.number().int().min(1000).max(3_600_000).default(60_000),
}).strict().superRefine((rule, ctx) => {
  const ids = rule.members.map(m => m.meterId);
  if (new Set(ids).size !== ids.length || rule.targetRatio >= rule.overloadRatio || rule.minTransferWatts > rule.maxTransferWatts) {
    ctx.addIssue({ code: "custom", message: "Members must be unique; targetRatio < overloadRatio; minTransferWatts <= maxTransferWatts" });
  }
  const keys = rule.paths.map(p => `${p.from}:${p.to}`);
  if (new Set(keys).size !== keys.length || rule.paths.some(p => p.from === p.to || !ids.includes(p.from) || !ids.includes(p.to))) {
    ctx.addIssue({ code: "custom", message: "Paths must be unique, directed links between distinct group members" });
  }
});
export type LoadRule = z.infer<typeof LoadRuleSchema>;
export type LoadCommand = {
  id: string; group_id: string; controller_id: string; from_id: string; to_id: string; watts: number;
  created_at: number; deadline: number; status: "pending" | "acknowledged" | "rejected" | "unknown";
  command_json: string; reason: string | null; acknowledged_at: number | null;
};
export type Publisher = (topic: string, payload: string) => Promise<void>;

export function loadRules(): LoadRule[] {
  return (operationsDb().prepare("SELECT json FROM load_rules ORDER BY id").all() as Array<{ json: string }>).map(r => LoadRuleSchema.parse(JSON.parse(r.json)));
}
export function loadCommands(groupId?: string): LoadCommand[] {
  return (groupId ? operationsDb().prepare("SELECT * FROM load_commands WHERE group_id=? ORDER BY created_at DESC LIMIT 100").all(groupId)
    : operationsDb().prepare("SELECT * FROM load_commands ORDER BY created_at DESC LIMIT 100").all()) as LoadCommand[];
}
export function saveLoadRule(input: unknown): LoadRule {
  const rule = LoadRuleSchema.parse(input);
  if (operationsDb().prepare("SELECT id FROM load_commands WHERE group_id=? AND status IN ('pending','unknown') LIMIT 1").get(rule.id)) {
    throw Object.assign(new Error("Cannot change rules while a command is unresolved"), { status: 409 });
  }
  operationsDb().prepare("INSERT INTO load_rules(id,json) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json").run(rule.id, JSON.stringify(rule));
  return rule;
}
function fresh(o: Observation | undefined, now: number, staleMs: number): o is Observation {
  return Boolean(o && o.available && o.active && o.received_at <= now && now - o.received_at <= staleMs);
}
const compareId = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/** Pure, stable tie-breaking, at most one bounded transfer per group per cycle. */
export function planLoadTransfer(rule: LoadRule, observations: Map<string, Observation>, now: number, blocked = new Set<string>()) {
  const eligible = rule.members.filter(m => !blocked.has(m.meterId) && fresh(observations.get(m.meterId), now, rule.staleAfterMs));
  const sources = eligible.filter(m => observations.get(m.meterId)!.load_watts > m.capacityWatts * rule.overloadRatio)
    .sort((a, b) => observations.get(b.meterId)!.load_watts / b.capacityWatts - observations.get(a.meterId)!.load_watts / a.capacityWatts || compareId(a.meterId, b.meterId));
  for (const source of sources) {
    const destinations = eligible.filter(m => rule.paths.some(p => p.from === source.meterId && p.to === m.meterId))
      .sort((a, b) => observations.get(a.meterId)!.load_watts / a.capacityWatts - observations.get(b.meterId)!.load_watts / b.capacityWatts || compareId(a.meterId, b.meterId));
    for (const dest of destinations) {
      const headroom = dest.capacityWatts * rule.targetRatio - rule.reserveWatts - observations.get(dest.meterId)!.load_watts;
      const excess = observations.get(source.meterId)!.load_watts - source.capacityWatts * rule.targetRatio;
      const watts = Math.floor(Math.min(headroom, excess, rule.maxTransferWatts));
      if (watts >= rule.minTransferWatts) return { from: source.meterId, to: dest.meterId, watts };
    }
  }
  return null;
}

/** Synchronous reservation BEFORE network I/O prevents overlapping plans, including across groups. */
export async function runLoadBalancing(publish: Publisher, clock?: number, registryBlocked = new Set<string>()) {
  const db = operationsDb();
  db.prepare("UPDATE load_commands SET status='unknown', reason='Acknowledgement timeout; physical outcome unknown' WHERE status='pending' AND deadline<=?").run(clock ?? Date.now());
  for (const rule of loadRules().filter(r => r.enabled)) {
    const now = clock ?? Date.now(); // re-evaluate freshness after preceding asynchronous publishes
    if (registryBlocked.has(rule.controllerId) || !fresh(latestObservation(rule.controllerId), now, rule.staleAfterMs)) continue;
    const unresolved = db.prepare("SELECT * FROM load_commands WHERE status IN ('pending','unknown')").all() as LoadCommand[];
    if (unresolved.some(c => c.group_id === rule.id || c.controller_id === rule.controllerId)) continue;
    const last = db.prepare("SELECT * FROM load_commands WHERE group_id=? ORDER BY created_at DESC LIMIT 1").get(rule.id) as LoadCommand | undefined;
    if (last && now - Math.max(last.created_at, last.acknowledged_at ?? 0) < rule.cooldownMs) continue;
    const blocked = new Set([...registryBlocked, ...unresolved.flatMap(c => [c.from_id, c.to_id])]);
    const observations = new Map(rule.members.map(m => [m.meterId, latestObservation(m.meterId)]).filter((pair): pair is [string, Observation] => Boolean(pair[1])));
    // Require fresh telemetry after ALL previous terminal commands involving a meter.
    for (const member of rule.members) {
      const terminal = db.prepare("SELECT MAX(acknowledged_at) AS at FROM load_commands WHERE (from_id=? OR to_id=?) AND acknowledged_at IS NOT NULL").get(member.meterId, member.meterId) as { at: number | null };
      if (terminal.at !== null && ((observations.get(member.meterId)?.received_at ?? 0) <= terminal.at || now - terminal.at < rule.cooldownMs)) blocked.add(member.meterId);
    }
    const plan = planLoadTransfer(rule, observations, now, blocked);
    if (!plan) continue;
    const id = randomUUID();
    const command = { version: 1, cmd: "LOAD_TRANSFER_REQUEST", commandId: id, groupId: rule.id,
      fromMeterId: plan.from, toMeterId: plan.to, watts: plan.watts,
      expiresAt: now + rule.ackTimeoutMs, timestamp: new Date(now).toISOString() };
    db.prepare(`INSERT INTO load_commands(id,group_id,controller_id,from_id,to_id,watts,created_at,deadline,status,command_json)
      VALUES (?,?,?,?,?,?,?,?,'pending',?)`).run(id, rule.id, rule.controllerId, plan.from, plan.to, plan.watts, now, command.expiresAt, JSON.stringify(command));
    try {
      await publish(`solargrid/meters/${rule.controllerId}/control`, JSON.stringify(command));
      // MQTT PUBACK confirms broker delivery only. No assumed load mutation here.
    } catch (error) {
      db.prepare("UPDATE load_commands SET status='unknown', reason=? WHERE id=? AND status='pending'").run(`Publish outcome uncertain: ${String(error)}`, id);
    }
  }
}

export function acknowledgeTransfer(controllerId: string, input: unknown, now = Date.now()): boolean {
  const ack = TransferAckSchema.parse(input);
  const db = operationsDb();
  const command = db.prepare("SELECT * FROM load_commands WHERE id=?").get(ack.commandId) as LoadCommand | undefined;
  if (!command || command.controller_id !== controllerId || !["pending", "unknown"].includes(command.status) || now < command.created_at) return false;
  // Late definitive controller reports may resolve 'unknown'. Still require new telemetry before replanning.
  db.prepare("UPDATE load_commands SET status=?, reason=?, acknowledged_at=? WHERE id=?").run(
    ack.status === "executed" ? "acknowledged" : "rejected", ack.reason ?? null, now, command.id);
  return true;
}

export function loadDistribution(now = Date.now()) {
  return loadRules().map(rule => ({ rule, meters: rule.members.map(member => {
    const observation = latestObservation(member.meterId);
    return { ...member, observation: observation ?? null, stale: !fresh(observation, now, rule.staleAfterMs),
      ratio: observation ? observation.load_watts / member.capacityWatts : null };
  }), commands: loadCommands(rule.id) }));
}
