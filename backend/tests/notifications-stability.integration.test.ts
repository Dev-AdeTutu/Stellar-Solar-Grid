import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let temporaryDirectory: string;
let emailNotifications: typeof import("../src/lib/emailNotifications.js");
let deviceRegistry: typeof import("../src/lib/deviceRegistry.js");

beforeAll(async () => {
  temporaryDirectory = mkdtempSync(path.join(tmpdir(), "solargrid-monitor-tests-"));
  process.env.EMAIL_PREFERENCES_DB_PATH = path.join(temporaryDirectory, "email.sqlite");
  process.env.EMAIL_PREFERENCES_SECRET = "test-only-preferences-secret";
  process.env.DEVICE_REGISTRY_DB_PATH = path.join(temporaryDirectory, "devices.sqlite");
  process.env.WEBHOOKS_DB_PATH = path.join(temporaryDirectory, "webhooks.sqlite");
  [emailNotifications, deviceRegistry] = await Promise.all([
    import("../src/lib/emailNotifications.js"),
    import("../src/lib/deviceRegistry.js"),
  ]);
});

afterAll(() => {
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe("email preferences and grid stability", () => {
  it("supports signed preference links, per-event choices, and unsubscribe", () => {
    const email = "operator@example.test";
    const token = emailNotifications.createEmailPreferenceToken(email);
    expect(emailNotifications.verifyEmailPreferenceToken(token)).toBe(email);
    expect(emailNotifications.verifyEmailPreferenceToken(`${token}x`)).toBeUndefined();
    expect(emailNotifications.getEmailPreferences(email).trades).toBe(true);

    emailNotifications.setEmailPreference(email, "trades", false);
    expect(emailNotifications.getEmailPreferences(email).trades).toBe(false);
    expect(emailNotifications.getEmailPreferences(email).billing).toBe(true);

    emailNotifications.unsubscribeEmail(email);
    expect(Object.values(emailNotifications.getEmailPreferences(email)).every((enabled) => !enabled)).toBe(true);
  });

  it("persists voltage/frequency anomalies and reports a stability score", () => {
    const device = deviceRegistry.registerDevice({
      type: "meter",
      owner: "test-owner",
      manufacturer: "Test",
      model: "Grid monitor",
      serialNumber: `stability-${Date.now()}`,
    });
    const now = Date.now();
    deviceRegistry.recordPerformance(device.id, {
      recordedAt: new Date(now - 2_000).toISOString(),
      voltageV: 230,
      frequencyHz: 50,
    });
    deviceRegistry.recordPerformance(device.id, {
      recordedAt: new Date(now - 1_000).toISOString(),
      voltageV: 258,
      frequencyHz: 50,
    });
    deviceRegistry.recordPerformance(device.id, {
      recordedAt: new Date(now).toISOString(),
      voltageV: 230,
      frequencyHz: 49,
    });

    const report = deviceRegistry.getStabilityReport(device.id);
    expect(report.readings).toBe(3);
    expect(report.stabilityScore).toBe(33);
    expect(report.anomalies.map((anomaly) => anomaly.metric).sort()).toEqual(["frequency", "voltage"]);
  });
});