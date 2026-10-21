import { beforeEach, describe, expect, it, vi } from "vitest";
vi.hoisted(() => { process.env.METER_OPERATIONS_DB_PATH = ":memory:"; });
import { LoadRuleSchema, planLoadTransfer, saveLoadRule, runLoadBalancing, loadCommands, acknowledgeTransfer } from "../src/lib/loadBalancing.js";
import { operationsDb, type Observation } from "../src/lib/meterOperationsStore.js";

const now = 1_000_000;
const rule = () => LoadRuleSchema.parse({ id: "GROUP", enabled: true, controllerId: "CTRL",
  members: [{ meterId: "A", capacityWatts: 1000 }, { meterId: "B", capacityWatts: 1000 }, { meterId: "C", capacityWatts: 1000 }],
  paths: [{ from: "A", to: "B" }, { from: "A", to: "C" }], maxTransferWatts: 200, reserveWatts: 100,
});
const observation = (id: string, watts: number, received = now): Observation => ({ meter_id: id, sequence: 1, received_at: received, load_watts: watts, active: 1, available: 1 });
function observations() { return new Map([['A', observation('A', 950)], ['B', observation('B', 200)], ['C', observation('C', 200)], ['CTRL', observation('CTRL', 0)]]); }
function seed() {
  const db = operationsDb();
  for (const o of observations().values()) db.prepare("INSERT INTO meter_observations VALUES(?,?,?,?,?,?)").run(o.meter_id, o.sequence, o.received_at, o.load_watts, o.available, o.active);
  saveLoadRule(rule());
}
describe("safe deterministic load balancing", () => {
  beforeEach(() => operationsDb().exec("DELETE FROM load_commands; DELETE FROM load_rules; DELETE FROM meter_observations"));
  it("chooses stable ties, commissioned paths, and bounded headroom", () => {
    expect(planLoadTransfer(rule(), observations(), now)).toEqual({ from: "A", to: "B", watts: 200 });
    const reversed = new Map([...observations()].reverse());
    expect(planLoadTransfer(rule(), reversed, now)).toEqual(planLoadTransfer(rule(), observations(), now));
    const r = rule(); r.maxTransferWatts = 800;
    expect(planLoadTransfer(r, observations(), now)?.watts).toBe(250); // source returns to 70% target
  });
  it("never transfers from stale, inactive, unavailable, future-dated or non-overloaded meters", () => {
    for (const patch of [{ received_at: now - 31_000 }, { active: 0 }, { available: 0 }, { received_at: now + 1 }, { load_watts: 800 }]) {
      const data = observations(); data.set('A', { ...data.get('A')!, ...patch });
      expect(planLoadTransfer(rule(), data, now)).toBeNull();
    }
    const data = observations(); data.set('B', observation('B', 650)); data.set('C', observation('C', 650));
    expect(planLoadTransfer(rule(), data, now)).toBeNull();
  });
  it("validates rules and does not infer uncommissioned or invalid routes", () => {
    const r = rule(); r.paths = [{ from: 'B', to: 'C' }];
    expect(planLoadTransfer(r, observations(), now)).toBeNull();
    for (const patch of [{ targetRatio: .95 }, { members: [r.members[0], r.members[0]] }, { paths: [{ from: 'A', to: 'X' }] }, { maxTransferWatts: -1 }, { staleAfterMs: 0 }, { minTransferWatts: 300 }]) {
      expect(LoadRuleSchema.safeParse({ ...rule(), ...patch }).success).toBe(false);
    }
  });
  it("broker publish acknowledgement remains pending until exact controller execution ack", async () => {
    seed(); const publish = vi.fn().mockResolvedValue(undefined);
    await runLoadBalancing(publish, now);
    const command = loadCommands()[0];
    expect(command.status).toBe('pending');
    expect(publish.mock.calls[0][0]).toBe('solargrid/meters/CTRL/control');
    expect(JSON.parse(publish.mock.calls[0][1])).toMatchObject({ cmd: 'LOAD_TRANSFER_REQUEST', commandId: command.id, watts: 200, expiresAt: now + 10_000 });
    expect(acknowledgeTransfer('B', { version: 1, commandId: command.id, status: 'executed' }, now + 100)).toBe(false);
    expect(acknowledgeTransfer('CTRL', { version: 1, commandId: command.id, status: 'executed' }, now + 100)).toBe(true);
    expect(loadCommands()[0].status).toBe('acknowledged');
    expect(acknowledgeTransfer('CTRL', { version: 1, commandId: command.id, status: 'executed' }, now + 200)).toBe(false);
    expect(operationsDb().prepare("SELECT load_watts FROM meter_observations WHERE meter_id='A'").get()).toEqual({ load_watts: 950 });
  });
  it("times out as unknown, prevents rule edits/retries, and accepts late definitive evidence", async () => {
    seed(); const publish = vi.fn().mockResolvedValue(undefined);
    await runLoadBalancing(publish, now);
    const id = loadCommands()[0].id;
    await runLoadBalancing(publish, now + 11_000);
    expect(loadCommands()[0].status).toBe('unknown');
    expect(() => saveLoadRule(rule())).toThrow('unresolved');
    await runLoadBalancing(publish, now + 70_000);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(acknowledgeTransfer('CTRL', { version: 1, commandId: id, status: 'rejected', reason: 'interlock' }, now + 70_000)).toBe(true);
    expect(loadCommands()[0].status).toBe('rejected');
  });
  it("requires fresh post-ack telemetry and cooldown rather than guessed load mutation", async () => {
    seed(); const publish = vi.fn().mockResolvedValue(undefined);
    await runLoadBalancing(publish, now);
    acknowledgeTransfer('CTRL', { version: 1, commandId: loadCommands()[0].id, status: 'executed' }, now + 10);
    await runLoadBalancing(publish, now + 1000);
    expect(publish).toHaveBeenCalledTimes(1);
    // Even after cooldown an old pre-ack sample cannot be reused.
    await runLoadBalancing(publish, now + 70_000);
    expect(publish).toHaveBeenCalledTimes(1);
  });
  it("publish errors cannot imply success or permit another potentially duplicate transfer", async () => {
    seed(); const publish = vi.fn().mockRejectedValue(new Error('network lost'));
    await runLoadBalancing(publish, now); await runLoadBalancing(publish, now + 1000);
    expect(loadCommands()[0].status).toBe('unknown'); expect(publish).toHaveBeenCalledTimes(1);
  });
  it("requires a fresh available controller and fails closed for registry exclusions", async () => {
    seed(); const publish = vi.fn().mockResolvedValue(undefined);
    await runLoadBalancing(publish, now, new Set(['A']));
    expect(publish).not.toHaveBeenCalled();
    operationsDb().prepare("UPDATE meter_observations SET available=0 WHERE meter_id='CTRL'").run();
    await runLoadBalancing(publish, now);
    expect(publish).not.toHaveBeenCalled();
  });
  it("disabled groups never issue commands and in-flight meters cannot be shared across groups", async () => {
    seed(); const db = operationsDb(); db.prepare("DELETE FROM load_rules").run(); saveLoadRule({ ...rule(), enabled: false });
    const publish = vi.fn().mockResolvedValue(undefined); await runLoadBalancing(publish, now); expect(publish).not.toHaveBeenCalled();
    saveLoadRule(rule()); saveLoadRule({ ...rule(), id: 'GROUP2' });
    await runLoadBalancing(publish, now); expect(publish).toHaveBeenCalledTimes(1);
  });
});
