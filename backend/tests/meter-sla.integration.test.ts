import { beforeEach, describe, expect, it, vi } from "vitest";
vi.hoisted(() => { process.env.METER_OPERATIONS_DB_PATH = ":memory:"; });
import { calculateSla, SlaTargetSchema, saveSlaTarget, meterSlaReport, evaluateSla, slaAlerts, slaTrends, sendSlaProbes, acknowledgeSlaProbe, type SlaProbe } from "../src/lib/meterSla.js";
import { operationsDb, type Observation } from "../src/lib/meterOperationsStore.js";
const target = () => SlaTargetSchema.parse({ heartbeatTimeoutMs: 1000, windowMs: 60_000, uptimePct: 90, mtbfMs: 1000 });
const observation = (time: number, sequence = time, available = 1): Observation => ({ meter_id: 'A', sequence, received_at: time, load_watts: 100, available, active: 1 });
const probe = (id: string, sent: number, ack: number | null): SlaProbe => ({ id, meter_id: 'A', sent_at: sent, deadline: sent + 500, acknowledged_at: ack, status: ack === null ? 'timeout' : 'acknowledged' });
function insert(o: Observation) { operationsDb().prepare("INSERT INTO meter_observations VALUES(?,?,?,?,?,?)").run(o.meter_id, o.sequence, o.received_at, o.load_watts, o.available, o.active); }

describe('durable meter SLA calculations', () => {
  beforeEach(() => {
    operationsDb().exec("DELETE FROM meter_observations; DELETE FROM sla_targets; DELETE FROM sla_reports; DELETE FROM sla_states; DELETE FROM sla_alerts");
    saveSlaTarget('TEMP', {}, 0); // initializes probe schema
    operationsDb().exec("DELETE FROM sla_targets; DELETE FROM sla_probes");
  });
  it('integrates clipped online intervals, stale gaps, and recovery rather than averaging samples', () => {
    const report = calculateSla([observation(0), observation(500), observation(2000)], [], target(), 0, 4000);
    expect(report.metrics).toMatchObject({ uptimeMs: 2500, downtimeMs: 1500, uptimePct: 62.5, failures: 2, mtbfMs: 1250 });
    expect(report.compliance).toMatchObject({ uptimePct: 'breached', mtbfMs: 'met', responseP95Ms: 'insufficient_data' });
  });
  it('respects explicit unavailable and inactive states, exact boundaries, and earlier overlapping evidence', () => {
    const report = calculateSla([observation(0), observation(500, 1, 0), observation(1000, 2)], [], target(), 250, 1500);
    expect(report.metrics.uptimeMs).toBe(750);
    expect(report.metrics.failures).toBe(1);
    expect(calculateSla([{ ...observation(0), active: 0 }], [], target(), 0, 1000).metrics.uptimePct).toBe(0);
    expect(calculateSla([observation(0)], [], target(), 0, 1000).metrics.failures).toBe(0); // censored at window end
    expect(() => calculateSla([], [], target(), 1, 1)).toThrow();
  });
  it('uses nearest-rank p95 of backend-measured successful RTT and includes timeouts in success rate', () => {
    const probes = Array.from({ length: 20 }, (_, i) => probe(String(i), 0, i + 1));
    probes.push(probe('timeout', 0, null));
    const report = calculateSla([], probes, target(), 0, 1000);
    expect(report.metrics.responseP95Ms).toBe(19);
    expect(report.metrics.responseSuccessPct).toBeCloseTo(20 * 100 / 21);
    expect(calculateSla([], [probe('timeout', 0, null)], target(), 0, 1000).compliance.responseSuccessPct).toBe('breached');
  });
  it('does not fabricate RTT/MTBF or count pending probes as completed', () => {
    const report = calculateSla([observation(0)], [{ ...probe('pending', 500, null), status: 'pending', deadline: 2000 }], target(), 0, 1000);
    expect(report.metrics).toMatchObject({ responseP95Ms: null, responseSuccessPct: null, mtbfMs: null });
    expect(report.compliance.mtbfMs).toBe('insufficient_data');
  });
  it('dedupes persistent breaches, records recovery, and keeps historical snapshots immutable', () => {
    saveSlaTarget('A', target(), 0);
    evaluateSla(1000); evaluateSla(1100);
    expect(slaAlerts('A').filter(a => a.metric === 'uptimePct' && a.event === 'sla_breach')).toHaveLength(1);
    for (let t = 1000; t <= 10000; t += 500) insert(observation(t));
    evaluateSla(10000);
    expect(slaAlerts('A').filter(a => a.metric === 'uptimePct' && a.event === 'sla_recovery')).toHaveLength(1);
    expect(slaTrends('A')).toHaveLength(1);
    expect(slaTrends('A')[0].report.until).toBe(1000);
    expect(meterSlaReport('A', 10000)?.report?.metrics.uptimePct).toBe(90);
  });
  it('correlates probe acknowledgements by meter and ID, rejects duplicates, late replies, and untrusted RTT fields', async () => {
    saveSlaTarget('A', { probeTimeoutMs: 1000 }, 0);
    const publish = vi.fn().mockResolvedValue(undefined);
    await sendSlaProbes(publish, 1000);
    const payload = JSON.parse(publish.mock.calls[0][1]);
    expect(publish.mock.calls[0][0]).toBe('solargrid/meters/A/control');
    expect(payload.cmd).toBe('SLA_PING');
    const ack = { version: 1, cmd: 'SLA_PONG', probeId: payload.probeId };
    expect(acknowledgeSlaProbe('B', ack, 1050)).toBe(false);
    expect(() => acknowledgeSlaProbe('A', { ...ack, responseTimeMs: 1 }, 1050)).toThrow();
    expect(acknowledgeSlaProbe('A', ack, 1050)).toBe(true);
    expect(acknowledgeSlaProbe('A', ack, 1060)).toBe(false);
    expect(meterSlaReport('A', 1200)?.report?.metrics.responseP95Ms).toBe(50);
    await sendSlaProbes(publish, 32000);
    const late = { ...ack, probeId: JSON.parse(publish.mock.calls[1][1]).probeId };
    expect(acknowledgeSlaProbe('A', late, 34000)).toBe(false);
  });
  it('validates targets, isolates meters, and makes reconfiguration a new epoch', () => {
    for (const patch of [{ uptimePct: 101 }, { responseP95Ms: 0 }, { mtbfMs: -1 }, { windowMs: 0 }]) expect(SlaTargetSchema.safeParse(patch).success).toBe(false);
    expect(meterSlaReport('missing')).toBeNull();
    saveSlaTarget('A', target(), 0); insert(observation(0));
    saveSlaTarget('A', target(), 10000);
    expect(meterSlaReport('A', 10000)?.report).toBeNull();
    expect(meterSlaReport('A', 11000)?.report?.metrics.uptimePct).toBe(0);
  });
});
