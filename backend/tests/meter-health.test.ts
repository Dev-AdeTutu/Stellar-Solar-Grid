import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  recordHeartbeat,
  handleHeartbeatMessage,
  getMeterHealth,
  getAllMeterHealth,
  checkStaleMeters,
  _resetMeterHealth,
} from "../src/lib/meterHealth";
import {
  triggerDiagnostic,
  recordDiagnosticResult,
  listDiagnosticLogs,
  getSuggestedFix,
  _resetDiagnostics,
} from "../src/lib/meterDiagnostics";

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

describe("meter remote diagnostics (#993)", () => {
  beforeEach(() => {
    _resetMeterHealth();
    _resetDiagnostics();
  });

  it("publishes the correct MQTT command for each diagnostic type", () => {
    const publish = vi.fn();
    for (const command of ["reboot", "self_test", "check_connectivity"] as const) {
      const result = triggerDiagnostic("M1", command, { publish });
      expect(publish).toHaveBeenCalledWith(
        `meters/M1/diagnostics`,
        expect.objectContaining({ command }),
      );
      expect(result.command).toBe(command);
      expect(result.status).toBe("pending");
    }
  });

  it("records a pending diagnostic when triggered", () => {
    const publish = vi.fn();
    const result = triggerDiagnostic("M2", "reboot", { publish });
    const logs = listDiagnosticLogs("M2");
    expect(logs).toHaveLength(1);
    expect(logs[0].id).toBe(result.id);
    expect(logs[0].status).toBe("pending");
    expect(logs[0].command).toBe("reboot");
  });

  it("persists diagnostic results and returns them from listDiagnosticLogs", () => {
    const publish = vi.fn();
    const { id } = triggerDiagnostic("M3", "self_test", { publish });
    recordDiagnosticResult("M3", {
      id,
      status: "failed",
      signature: "ERR_SENSOR_TIMEOUT",
      details: "sensor did not respond",
    });
    const logs = listDiagnosticLogs("M3");
    expect(logs).toHaveLength(1);
    expect(logs[0].status).toBe("failed");
    expect(logs[0].signature).toBe("ERR_SENSOR_TIMEOUT");
    expect(logs[0].details).toBe("sensor did not respond");
  });

  it("maps known failure signatures to suggested fixes", () => {
    expect(getSuggestedFix("ERR_SENSOR_TIMEOUT")).toMatch(/sensor/i);
    expect(getSuggestedFix("ERR_COMMS_LOST")).toMatch(/connect|network|signal/i);
    expect(getSuggestedFix("ERR_LOW_BATTERY")).toMatch(/battery|power/i);
    expect(getSuggestedFix("ERR_UNKNOWN_SIGNATURE")).toBeUndefined();
  });

  it("validates the command and 404s for unknown meters", async () => {
    const { default: app } = await import("../src/index");
    const request = (await import("supertest")).default;

    const bad = await request(app)
      .post("/api/meters/M1/diagnostics")
      .send({ command: "explode" });
    expect(bad.status).toBe(400);

    const missing = await request(app)
      .post("/api/meters/does-not-exist/diagnostics")
      .send({ command: "reboot" });
    expect(missing.status).toBe(404);
  });

  it("returns diagnostic logs with suggested fixes", async () => {
    const publish = vi.fn();
    const { id } = triggerDiagnostic("M4", "check_connectivity", { publish });
    recordDiagnosticResult("M4", {
      id,
      status: "failed",
      signature: "ERR_COMMS_LOST",
    });

    const { default: app } = await import("../src/index");
    const request = (await import("supertest")).default;

    const res = await request(app).get("/api/meters/M4/diagnostic-logs");
    expect(res.status).toBe(200);
    expect(res.body.logs).toHaveLength(1);
    expect(res.body.logs[0].signature).toBe("ERR_COMMS_LOST");
    expect(res.body.logs[0].suggestedFix).toMatch(/connect|network|signal/i);
  });
});
