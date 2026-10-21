import { afterAll, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
vi.mock('../src/lib/stellar.js', () => ({ adminInvoke: vi.fn().mockResolvedValue('tx') }));
vi.mock('../src/lib/metrics.js', () => ({
  incrementUsageEvent: vi.fn(),
  incrementContractCall: vi.fn(),
  incrementMqtt: vi.fn(),
  incrementDeadLetter: vi.fn(),
  usageEvents: { inc: vi.fn() },
  register: { metrics: vi.fn() },
}));
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'solar-durability-'));
afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));

it('reopens actual WAL files without losing readings, unresolved control reservations or alert dedupe', async () => {
  process.env.METER_OPERATIONS_DB_PATH = path.join(directory, 'operations.sqlite');
  process.env.USAGE_EVENTS_DB_PATH = path.join(directory, 'usage.sqlite');
  const store = await import('../src/lib/meterOperationsStore.js');
  const load = await import('../src/lib/loadBalancing.js');
  const sla = await import('../src/lib/meterSla.js');
  const usage = await import('../src/lib/usageEvents.js');
  const now = 100000;
  for (const [id, watts] of [['A', 950], ['B', 200], ['CTRL', 0]] as const) {
    store.operationsDb().prepare('INSERT INTO meter_observations VALUES(?,?,?,?,?,?)').run(id, 1, now, watts, 1, 1);
  }
  load.saveLoadRule({ id: 'G', controllerId: 'CTRL', enabled: true,
    members: [{ meterId: 'A', capacityWatts: 1000 }, { meterId: 'B', capacityWatts: 1000 }],
    paths: [{ from: 'A', to: 'B' }], maxTransferWatts: 100 });
  await load.runLoadBalancing(vi.fn().mockResolvedValue(undefined), now);
  sla.saveSlaTarget('A', { heartbeatTimeoutMs: 1000, uptimePct: 99 }, now);
  sla.evaluateSla(now + 10000);
  const alerts = sla.slaAlerts('A'); expect(alerts.length).toBeGreaterThan(0);
  const reading = { meterId: 'A', units: 100, cost: 1, readingId: 'persisted-r1', energySources: { solar: 60, grid: 40, battery: 0 } };
  await usage.persistAndSubmitUsageEvent(reading);
  const id = load.loadCommands()[0].id;

  vi.resetModules(); // new backend module instances, using the same durable files
  const reopenedLoad = await import('../src/lib/loadBalancing.js');
  const reopenedSla = await import('../src/lib/meterSla.js');
  const reopenedStore = await import('../src/lib/meterOperationsStore.js');
  const reopenedUsage = await import('../src/lib/usageEvents.js');
  expect(reopenedStore.latestObservation('A')?.sequence).toBe(1);
  expect(reopenedLoad.loadRules()[0].id).toBe('G');
  expect(reopenedLoad.loadCommands()[0]).toMatchObject({ id, status: 'pending' });
  const publish = vi.fn().mockResolvedValue(undefined);
  await reopenedLoad.runLoadBalancing(publish, now + 2000);
  expect(publish).not.toHaveBeenCalled();
  reopenedSla.evaluateSla(now + 11000);
  expect(reopenedSla.slaAlerts('A').map(a => a.id)).toEqual(alerts.map(a => a.id));
  expect(reopenedSla.slaTrends('A')).toHaveLength(1);
  expect(reopenedUsage.recordUsageEvent(reading).status).toBe('submitted');
  expect(reopenedUsage.getEnergyMix('A', undefined, new Date(Date.now() + 1000).toISOString()).units).toEqual({ solar: 60, grid: 40, battery: 0, unknown: 0 });
  reopenedUsage.initUsageEventStore().exec('DELETE FROM usage_events');
  expect(() => reopenedUsage.recordUsageEvent(reading)).toThrow('already processed');
});
