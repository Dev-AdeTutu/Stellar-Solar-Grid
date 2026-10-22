import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import * as sdk from "@stellar/stellar-sdk";
import jwt from "jsonwebtoken";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
vi.hoisted(() => {
  process.env.ADMIN_API_KEY = 'test-key'; process.env.JWT_SECRET = 'test-jwt';
  process.env.USAGE_EVENTS_DB_PATH = ':memory:'; process.env.METER_OPERATIONS_DB_PATH = ':memory:';
  process.env.WEBHOOKS_DB_PATH = ':memory:';
});
vi.mock('../src/lib/stellar.js', () => ({ adminInvoke: vi.fn(), contractQuery: vi.fn(), server: {}, CONTRACT_ID: 'test' }));
import { createMeterOperationsRouter } from '../src/routes/meterOperations.js';
import { operationsDb, latestObservation } from '../src/lib/meterOperationsStore.js';
import { initUsageEventStore, recordUsageEvent } from '../src/lib/usageEvents.js';
import { processOperationalMessage } from '../src/iot/meterOperations.js';
import { contractQuery, type StellarService } from '../src/lib/stellar.js';
const query = vi.fn();
let server: Server; let base: string;
async function request(path: string, value?: unknown, credential = 'test-key') {
  return fetch(base + path, { method: value === undefined ? 'GET' : 'PUT', headers: { 'Content-Type': 'application/json', 'X-Admin-Key': credential }, body: value === undefined ? undefined : JSON.stringify(value) });
}
beforeAll(async () => {
  const app = express(); app.use(express.json()); app.use('/api', createMeterOperationsRouter({ query } as unknown as StellarService));
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});
afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));
beforeEach(() => {
  operationsDb().exec('DELETE FROM meter_observations; DELETE FROM load_rules; DELETE FROM load_commands; DELETE FROM sla_targets; DELETE FROM sla_reports; DELETE FROM sla_alerts; DELETE FROM sla_states');
  initUsageEventStore().exec('DELETE FROM usage_events');
  query.mockReset().mockResolvedValue(sdk.nativeToScVal({ active: true }));
  vi.mocked(contractQuery).mockReset().mockResolvedValue(sdk.nativeToScVal({ active: true }));
});
describe('meter operations API and transport boundaries', () => {
  it('serves real source percentages and validates windows and device existence', async () => {
    recordUsageEvent({ meterId: 'A', units: 100, cost: 1, readingId: 'r', energySources: { solar: 50, grid: 30, battery: 20 } });
    const response = await request('/meters/A/energy-mix');
    expect(response.status).toBe(200); expect((await response.json()).percentages).toEqual({ solar: 50, grid: 30, battery: 20, unknown: 0 });
    expect((await request('/meters/A/energy-mix?since=garbage')).status).toBe(400);
    expect((await request('/meters/A/energy-mix?since=2026-02-01T00:00:00.000Z&until=2026-01-01T00:00:00.000Z')).status).toBe(400);
    query.mockResolvedValueOnce(sdk.nativeToScVal(null)); expect((await request('/meters/MISSING/energy-mix')).status).toBe(404);
    query.mockRejectedValueOnce(new Error('not registered')); expect((await request('/meters/MISSING/energy-mix')).status).toBe(404);
  });
  it('rejects missing/invalid/expired admin credentials and accepts signed admin sessions', async () => {
    expect((await request('/load-balancing', undefined, 'wrong')).status).toBe(401);
    expect((await request('/sla', undefined, '')).status).toBe(401);
    const expired = jwt.sign({ role: 'admin' }, 'test-jwt', { expiresIn: -1 });
    expect((await fetch(base + '/sla', { headers: { Authorization: `Bearer ${expired}` } })).status).toBe(401);
    const token = jwt.sign({ role: 'admin' }, 'test-jwt', { expiresIn: 60 });
    expect((await fetch(base + '/sla', { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
  });
  it('stores explicitly disabled rules and rejects invalid topology, route mismatches and unknown controllers', async () => {
    const rule = { id: 'G', controllerId: 'CTRL', members: [{ meterId: 'A', capacityWatts: 1000 }, { meterId: 'B', capacityWatts: 1000 }], paths: [{ from: 'A', to: 'B' }], maxTransferWatts: 100 };
    const saved = await request('/load-balancing/rules/G', rule); expect(saved.status).toBe(200); expect((await saved.json()).enabled).toBe(false);
    expect((await request('/load-balancing/rules/G', { ...rule, targetRatio: .99 })).status).toBe(400);
    expect((await request('/load-balancing/rules/OTHER', rule)).status).toBe(400);
    query.mockResolvedValueOnce(sdk.nativeToScVal(null)); expect((await request('/load-balancing/rules/G', rule)).status).toBe(404);
    const report = await request('/load-balancing'); expect((await report.json()).groups[0].meters[0].stale).toBe(true);
  });
  it('requires registered meters for SLA configuration and exposes targets/reports/trends/alerts', async () => {
    expect((await request('/meters/A/sla', { uptimePct: 99, responseP95Ms: 100 })).status).toBe(200);
    expect((await request('/meters/A/sla', { uptimePct: 101 })).status).toBe(400);
    const response = await request('/meters/A/sla'); expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ meterId: 'A', trends: [], alerts: [] });
    expect((await (await request('/sla')).json()).meters[0].target.uptimePct).toBe(99);
    query.mockResolvedValueOnce(sdk.nativeToScVal(null)); expect((await request('/meters/X/sla', {})).status).toBe(404);
  });
  it('accepts registered live telemetry but retained/replayed/out-of-order data cannot refresh meter evidence', async () => {
    const topic = 'solargrid/meters/A/telemetry';
    const payload = Buffer.from(JSON.stringify({ version: 1, sequence: 2, loadWatts: 950, available: true }));
    await processOperationalMessage(topic, payload, true); expect(latestObservation('A')).toBeUndefined();
    await processOperationalMessage(topic, payload); const first = latestObservation('A')!;
    await processOperationalMessage(topic, payload); expect(latestObservation('A')?.received_at).toBe(first.received_at);
    await processOperationalMessage(topic, Buffer.from(JSON.stringify({ version: 1, sequence: 1, loadWatts: 0, available: true })));
    expect(latestObservation('A')?.load_watts).toBe(950);
    vi.mocked(contractQuery).mockResolvedValueOnce(sdk.nativeToScVal(null));
    await processOperationalMessage('solargrid/meters/UNKNOWN/telemetry', payload); expect(latestObservation('UNKNOWN')).toBeUndefined();
  });
});
