import { describe, it, expect } from "vitest";
import { DisasterRecovery, RPO_MS, type DrAdapter, type Site } from "../src/lib/disasterRecovery.js";

function fakeAdapter(opts: { lagMs?: number; drHealthy?: boolean; replicateFails?: boolean; clock: { t: number } }) {
  const calls: string[] = [];
  let last = opts.clock.t - (opts.lagMs ?? 0);
  const adapter: DrAdapter = {
    lastReplicatedAt: async () => last,
    replicate: async () => {
      calls.push("replicate");
      if (opts.replicateFails) throw new Error("link down");
      last = opts.clock.t;
    },
    activate: async (s: Site) => void calls.push(`activate:${s}`),
    healthCheck: async (s: Site) => (s === "dr" ? opts.drHealthy ?? true : true),
  };
  return { adapter, calls };
}

describe("disaster recovery automation (#1060)", () => {
  it("fails over to DR within RTO and RPO", async () => {
    const clock = { t: 1_000_000_000 };
    const { adapter, calls } = fakeAdapter({ lagMs: 60_000, clock });
    const dr = new DisasterRecovery(adapter, () => clock.t);
    const r = await dr.failover();
    expect(r.ok).toBe(true);
    expect(r.activeSite).toBe("dr");
    expect(r.rtoMet).toBe(true);
    expect(r.rpoMet).toBe(true);
    expect(calls).toEqual(["activate:dr"]);
    await expect(dr.failover()).rejects.toThrow(/already/);
  });

  it("catches up replication when lag exceeds RPO", async () => {
    const clock = { t: 1_000_000_000 };
    const { adapter, calls } = fakeAdapter({ lagMs: RPO_MS + 1, clock });
    const dr = new DisasterRecovery(adapter, () => clock.t);
    const r = await dr.failover();
    expect(calls[0]).toBe("replicate");
    expect(r.rpoMet).toBe(true);
    expect(r.steps.find((s) => s.step === "catch_up_replication")?.ok).toBe(true);
  });

  it("reports RPO breach when replication cannot catch up", async () => {
    const clock = { t: 1_000_000_000 };
    const { adapter } = fakeAdapter({ lagMs: RPO_MS * 2, replicateFails: true, clock });
    const r = await new DisasterRecovery(adapter, () => clock.t).failover();
    expect(r.rpoMet).toBe(false);
    expect(r.ok).toBe(false);
  });

  it("rolls back to primary when DR health checks fail", async () => {
    const clock = { t: 1_000_000_000 };
    const { adapter, calls } = fakeAdapter({ drHealthy: false, clock });
    const dr = new DisasterRecovery(adapter, () => clock.t);
    const r = await dr.failover();
    expect(r.ok).toBe(false);
    expect(r.rolledBack).toBe(true);
    expect(dr.activeSite).toBe("primary");
    expect(calls).toEqual(["activate:dr", "activate:primary"]);
  });

  it("drills switch back to primary and are recorded", async () => {
    const clock = { t: 1_000_000_000 };
    const { adapter } = fakeAdapter({ clock });
    const dr = new DisasterRecovery(adapter, () => clock.t);
    const r = await dr.failover({ drill: true });
    expect(r.ok).toBe(true);
    expect(r.drill).toBe(true);
    expect(dr.activeSite).toBe("primary");
    expect(dr.history).toHaveLength(1);
  });

  it("flags RTO breach on slow failover and supports failback", async () => {
    const clock = { t: 1_000_000_000 };
    const { adapter } = fakeAdapter({ clock });
    adapter.activate = async () => {
      clock.t += 61 * 60_000;
    };
    const dr = new DisasterRecovery(adapter, () => clock.t);
    const r = await dr.failover();
    expect(r.rtoMet).toBe(false);
    const back = await dr.failback();
    expect(back.ok).toBe(true);
    expect(dr.activeSite).toBe("primary");
  });
});
