import { describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";

process.env.DEVICE_REGISTRY_DB_PATH = ":memory:";

vi.mock("mqtt", () => ({ default: { connect: vi.fn() } }));
vi.mock("../src/lib/stellar.js", () => ({
  CONTRACT_ID: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
  server: {},
  adminInvoke: vi.fn(),
  contractQuery: vi.fn(),
}));

const { getPerformanceSummary, registerDevice } = await import(
  "../src/lib/deviceRegistry.js"
);
const { handleDeviceTelemetryTopic } = await import("../src/iot/bridge.js");

describe("battery storage telemetry integration", () => {
  it("registers a battery and persists MQTT charge, discharge, and SoC metrics", () => {
    const battery = registerDevice({
      type: "battery",
      owner: "GOWNER",
      manufacturer: "GridCell",
      model: "Home 12",
      serialNumber: `BAT-${crypto.randomUUID()}`,
      specs: { capacityKwh: 12 },
    });

    const handled = handleDeviceTelemetryTopic(
      `solargrid/devices/${battery.id}/telemetry`,
      Buffer.from(JSON.stringify({
        timestamp: new Date().toISOString(),
        stateOfCharge: 0.75,
        chargedEnergyKwh: 4,
        dischargedEnergyKwh: 3.6,
      })),
    );

    expect(handled).toBe(true);
    const summary = getPerformanceSummary(battery.id);
    expect(summary.latestStateOfCharge).toBe(0.75);
    expect(summary.storageCapacityKwh).toBe(12);
    expect(summary.availableStorageKwh).toBe(9);
    expect(summary.totalChargedEnergyKwh).toBe(4);
    expect(summary.totalDischargedEnergyKwh).toBe(3.6);
    expect(summary.roundTripEfficiency).toBe(0.9);
  });

  it("does not route unrelated MQTT topics as device telemetry", () => {
    expect(handleDeviceTelemetryTopic("solargrid/meters/METER1/usage", Buffer.from("{}"))).toBe(false);
  });
});