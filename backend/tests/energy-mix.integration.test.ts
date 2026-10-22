import { beforeEach, describe, expect, it, vi } from "vitest";
import * as sdk from "@stellar/stellar-sdk";

vi.hoisted(() => {
  process.env.USAGE_EVENTS_DB_PATH = ":memory:";
  process.env.METER_OPERATIONS_DB_PATH = ":memory:";
  process.env.WEBHOOKS_DB_PATH = ":memory:";
});
vi.mock("../src/lib/stellar.js", () => ({
  adminInvoke: vi.fn().mockResolvedValue("tx"), contractQuery: vi.fn(),
  server: {}, CONTRACT_ID: "test",
}));
import { processMqttMessage } from "../src/iot/bridge.js";
import { getEnergyMix, initUsageEventStore, recordUsageEvent } from "../src/lib/usageEvents.js";
import { adminInvoke, contractQuery } from "../src/lib/stellar.js";
import { SourceUsageSchema } from "../src/iot/telemetrySchemas.js";

const topic = "solargrid/meters/SOLAR1/usage";
let sequence = 0;
function sourcePayload(source: string, units = 100) {
  return Buffer.from(JSON.stringify({ readingId: `reading-${++sequence}`, units, cost: 10, energySource: source }));
}
describe("durable energy source attribution", () => {
  beforeEach(() => {
    initUsageEventStore().exec("DELETE FROM usage_events");
    vi.mocked(adminInvoke).mockClear().mockResolvedValue("tx");
    vi.mocked(contractQuery).mockReset().mockResolvedValue(sdk.nativeToScVal({ active: true }));
  });
  it("ingests sources, weights by energy, preserves unknown legacy energy, and bills once", async () => {
    await processMqttMessage(topic, sourcePayload("solar", 300));
    await processMqttMessage(topic, sourcePayload("grid", 100));
    await processMqttMessage(topic, sourcePayload("battery", 100));
    recordUsageEvent({ meterId: "SOLAR1", units: 500, cost: 10 });
    const mix = getEnergyMix("SOLAR1", undefined, new Date(Date.now() + 1000).toISOString());
    expect(mix.percentages).toEqual({ solar: 30, grid: 10, battery: 10, unknown: 50 });
    expect(mix.unit).toBe("milli-kWh");
    expect(adminInvoke).toHaveBeenCalledTimes(3);
    expect(sdk.scValToNative(vi.mocked(contractQuery).mock.calls[0][1][0])).toBe("SOLAR1");
  });
  it("uses stable readingId across different wire formatting; submitted retries cannot bill or attribute twice", async () => {
    const data = { readingId: `reading-${++sequence}`, units: 100, cost: 10, energySources: { solar: 80, grid: 20, battery: 0 } };
    await processMqttMessage(topic, Buffer.from(JSON.stringify(data)));
    await processMqttMessage(topic, Buffer.from(JSON.stringify(data, null, 2)));
    expect(adminInvoke).toHaveBeenCalledTimes(1);
    expect(getEnergyMix("SOLAR1", undefined, new Date(Date.now() + 1000).toISOString()).readings).toBe(1);
    expect(() => recordUsageEvent({ meterId: "SOLAR1", units: 200, cost: 10, readingId: data.readingId, energySources: { solar: 200, grid: 0, battery: 0 } })).toThrow("Conflicting");
  });
  it("retains attribution when chain submission fails, without labeling it settled", async () => {
    vi.mocked(adminInvoke).mockRejectedValueOnce(new Error("offline"));
    await processMqttMessage(topic, sourcePayload("solar"));
    expect(getEnergyMix("SOLAR1", undefined, new Date(Date.now() + 1000).toISOString()).units.solar).toBe(100);
    expect(initUsageEventStore().prepare("SELECT status FROM usage_events").get()).toEqual({ status: "pending" });
  });
  it("keeps a replay tombstone when history is purged", async () => {
    const data = { readingId: `reading-${++sequence}`, units: 100, cost: 10, energySource: "solar" };
    await processMqttMessage(topic, Buffer.from(JSON.stringify(data)));
    initUsageEventStore().exec("DELETE FROM usage_events");
    await expect(processMqttMessage(topic, Buffer.from(JSON.stringify(data)))).rejects.toThrow("already processed");
    expect(adminInvoke).toHaveBeenCalledTimes(1);
  });
  it("rejects unregistered devices and malformed attribution without charging", async () => {
    vi.mocked(contractQuery).mockResolvedValue(sdk.nativeToScVal(null));
    await processMqttMessage(topic, sourcePayload("solar"));
    await processMqttMessage(topic, sourcePayload("coal"));
    expect(adminInvoke).not.toHaveBeenCalled();
  });
  it("validates exactly one source representation and exact integer conservation", () => {
    const base = { readingId: "x", units: 10, cost: 1 };
    expect(SourceUsageSchema.safeParse({ ...base, energySources: { solar: 6, grid: 4, battery: 0 } }).success).toBe(true);
    for (const invalid of [
      { ...base, energySource: "coal" }, { ...base, energySource: "solar", energySources: { solar: 10, grid: 0, battery: 0 } },
      { ...base, energySources: { solar: 6, grid: 3, battery: 0 } }, { ...base, energySources: { solar: -1, grid: 11, battery: 0 } },
      { ...base, units: 1.5, energySource: "solar" }, { units: 10, cost: 1, energySource: "solar" },
    ]) expect(SourceUsageSchema.safeParse(invalid).success).toBe(false);
  });
  it("reports zero/no data honestly and isolates meters and receipt-time windows", () => {
    expect(getEnergyMix("empty").hasData).toBe(false);
    expect(getEnergyMix("empty").percentages).toEqual({ solar: 0, grid: 0, battery: 0, unknown: 0 });
    recordUsageEvent({ meterId: "OTHER", units: 50, cost: 1 });
    expect(getEnergyMix("SOLAR1").totalUnits).toBe(0);
    expect(getEnergyMix("OTHER", "1970-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z").totalUnits).toBe(0);
  });
});
