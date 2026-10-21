/**
 * Disaster recovery automation (#1060).
 *
 * - Tracks replication of the primary database to the DR site and checks RPO (< 15 min).
 * - One-click failover: pre-flight replica check → promote DR → health checks →
 *   automatic rollback to the primary if the DR site is unhealthy.
 * - Each run is timed against the RTO (< 1 hour) and recorded for drill reporting.
 */

export const RPO_MS = 15 * 60_000;
export const RTO_MS = 60 * 60_000;

export type Site = "primary" | "dr";

export interface DrAdapter {
  /** Timestamp of the last change successfully replicated to the DR site. */
  lastReplicatedAt(): Promise<number>;
  /** Push pending changes to the DR site. */
  replicate(): Promise<void>;
  /** Promote a site to active (DB writable, traffic routed to it). */
  activate(site: Site): Promise<void>;
  /** Health check of a site; resolves true when healthy. */
  healthCheck(site: Site): Promise<boolean>;
}

export interface FailoverStep {
  step: string;
  ok: boolean;
  detail?: string;
  at: number;
}

export interface FailoverResult {
  ok: boolean;
  activeSite: Site;
  rolledBack: boolean;
  drill: boolean;
  durationMs: number;
  rtoMet: boolean;
  dataLossMs: number;
  rpoMet: boolean;
  steps: FailoverStep[];
}

export interface ReplicationStatus {
  lastReplicatedAt: number;
  lagMs: number;
  rpoMet: boolean;
}

export class DisasterRecovery {
  private active: Site = "primary";
  private inProgress = false;
  readonly history: FailoverResult[] = [];

  constructor(
    private adapter: DrAdapter,
    private now: () => number = Date.now,
    private healthRetries = 3,
  ) {}

  get activeSite(): Site {
    return this.active;
  }

  async replicationStatus(): Promise<ReplicationStatus> {
    const last = await this.adapter.lastReplicatedAt();
    const lagMs = Math.max(0, this.now() - last);
    return { lastReplicatedAt: last, lagMs, rpoMet: lagMs < RPO_MS };
  }

  /** Run a replication cycle; returns the resulting status. */
  async replicate(): Promise<ReplicationStatus> {
    await this.adapter.replicate();
    return this.replicationStatus();
  }

  private async healthy(site: Site): Promise<boolean> {
    for (let i = 0; i < this.healthRetries; i++) {
      try {
        if (await this.adapter.healthCheck(site)) return true;
      } catch {
        /* retry */
      }
    }
    return false;
  }

  /**
   * One-click failover to the DR site. With `drill: true` the DR site is validated
   * and traffic is switched back to the primary afterwards.
   */
  async failover(opts: { drill?: boolean } = {}): Promise<FailoverResult> {
    if (this.inProgress) throw new Error("failover already in progress");
    if (this.active === "dr" && !opts.drill) throw new Error("already failed over to DR");
    this.inProgress = true;
    const start = this.now();
    const steps: FailoverStep[] = [];
    const log = (step: string, ok: boolean, detail?: string) => steps.push({ step, ok, detail, at: this.now() });
    let rolledBack = false;
    let dataLossMs = 0;

    try {
      const rep = await this.replicationStatus();
      dataLossMs = rep.lagMs;
      log("check_replication", rep.rpoMet, `lag ${Math.round(rep.lagMs / 1000)}s`);
      if (!rep.rpoMet) {
        try {
          await this.adapter.replicate();
          const after = await this.replicationStatus();
          dataLossMs = after.lagMs;
          log("catch_up_replication", after.rpoMet, `lag ${Math.round(after.lagMs / 1000)}s`);
        } catch (err) {
          log("catch_up_replication", false, String(err));
        }
      }

      await this.adapter.activate("dr");
      this.active = "dr";
      log("promote_dr", true);

      const drOk = await this.healthy("dr");
      log("health_check_dr", drOk);

      if (!drOk) {
        await this.adapter.activate("primary");
        this.active = "primary";
        rolledBack = true;
        log("rollback_to_primary", await this.healthy("primary"));
      } else if (opts.drill) {
        await this.adapter.activate("primary");
        this.active = "primary";
        log("drill_switch_back", await this.healthy("primary"));
      }
    } catch (err) {
      log("error", false, err instanceof Error ? err.message : String(err));
      try {
        await this.adapter.activate("primary");
        this.active = "primary";
        rolledBack = true;
        log("rollback_to_primary", true);
      } catch (rbErr) {
        log("rollback_to_primary", false, String(rbErr));
      }
    } finally {
      this.inProgress = false;
    }

    const durationMs = this.now() - start;
    const result: FailoverResult = {
      ok: !rolledBack && steps.every((s) => s.ok || s.step === "check_replication"),
      activeSite: this.active,
      rolledBack,
      drill: Boolean(opts.drill),
      durationMs,
      rtoMet: durationMs < RTO_MS,
      dataLossMs,
      rpoMet: dataLossMs < RPO_MS,
      steps,
    };
    this.history.push(result);
    return result;
  }

  /** Return traffic to the primary after it has been repaired. */
  async failback(): Promise<FailoverResult> {
    if (this.active !== "dr") throw new Error("not failed over");
    const start = this.now();
    const steps: FailoverStep[] = [];
    const primaryOk = await this.healthy("primary");
    steps.push({ step: "health_check_primary", ok: primaryOk, at: this.now() });
    if (primaryOk) {
      await this.adapter.activate("primary");
      this.active = "primary";
      steps.push({ step: "promote_primary", ok: true, at: this.now() });
    }
    const durationMs = this.now() - start;
    const result: FailoverResult = {
      ok: primaryOk,
      activeSite: this.active,
      rolledBack: false,
      drill: false,
      durationMs,
      rtoMet: durationMs < RTO_MS,
      dataLossMs: 0,
      rpoMet: true,
      steps,
    };
    this.history.push(result);
    return result;
  }
}

/** Adapter driven by env-configured health URLs and the scripts/dr-*.sh helpers. */
export function createDefaultAdapter(): DrAdapter {
  let last = Date.now();
  const urls: Record<Site, string | undefined> = {
    primary: process.env.DR_PRIMARY_HEALTH_URL,
    dr: process.env.DR_SITE_HEALTH_URL,
  };
  const run = async (script: string, ...args: string[]) => {
    const { execFile } = await import("node:child_process");
    await new Promise<void>((resolve, reject) =>
      execFile(script, args, { timeout: 10 * 60_000 }, (err) => (err ? reject(err) : resolve())),
    );
  };
  return {
    lastReplicatedAt: async () => last,
    replicate: async () => {
      await run("scripts/dr-replicate.sh");
      last = Date.now();
    },
    activate: (site) => run("scripts/dr-failover.sh", site),
    healthCheck: async (site) => {
      const url = urls[site];
      if (!url) return false;
      const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      return res.ok;
    },
  };
}
