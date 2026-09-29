import { describe, it, expect, beforeEach } from "vitest";
import {
  recordHeartbeat,
  handleHeartbeatMessage,
  getMeterHealth,
  getAllMeterHealth,
  checkStaleMeters,
  _resetMeterHealth,
} from "../src/lib/meterHealth";

const HOUR = 60 * 60 * 1000;

describe("meter health monitoring (#834)", () => {
  beforeEach(() => _resetMeterHealth());

  it("tracks last heartbeat, response time and status", () => {
    const t0 = Date.now();
    recordHeartbeat("M1", { responseTimeMs: 100, receivedAt: t0 });
    recordHeartbeat("M1", { responseTimeMs: 300, receivedAt: t0 });
    const h = getMeterHealth("M1", t0)!;
    expect(h.status).toBe("green");
    expect(h.avgResponseTimeMs).toBe(200);
    expect(h.heartbeatCount).toBe(2);
    expect(h.lastHeartbeat).toBe(new Date(t0).toISOString());
  });

  it("classifies yellow after 1h and red after 24h", () => {
    const t0 = Date.now();
    recordHeartbeat("M2", { receivedAt: t0 });
    expect(getMeterHealth("M2", t0 + 2 * HOUR)!.status).toBe("yellow");
    expect(getMeterHealth("M2", t0 + 25 * HOUR)!.status).toBe("red");
  });

  it("marks high error rates yellow", () => {
    recordHeartbeat("M3", { error: true });
    expect(getMeterHealth("M3")!.status).toBe("yellow");
  });

  it("alerts once for meters silent for 24h", () => {
    const t0 = Date.now();
    recordHeartbeat("M4", { receivedAt: t0 });
    recordHeartbeat("M5", { receivedAt: t0 + 24 * HOUR });
    expect(checkStaleMeters(t0 + 25 * HOUR)).toEqual(["M4"]);
    expect(checkStaleMeters(t0 + 26 * HOUR)).toEqual([]);
  });

  it("parses MQTT heartbeat payloads and builds a dashboard summary", () => {
    handleHeartbeatMessage("M6", Buffer.from(JSON.stringify({ responseTimeMs: 50 })));
    handleHeartbeatMessage("M7", Buffer.from("not json"));
    const { summary, meters } = getAllMeterHealth();
    expect(meters).toHaveLength(2);
    expect(summary.green).toBe(2);
    expect(getMeterHealth("unknown")).toBeUndefined();
  });
});
