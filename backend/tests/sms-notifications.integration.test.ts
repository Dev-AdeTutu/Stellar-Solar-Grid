/**
 * SMS notifications for non-smartphone users (#997): opt-in preferences,
 * the daily rate limit, and the HTTP endpoints.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sg-sms-"));
process.env.SMS_PREFERENCES_DB_PATH = path.join(tmpDir, "sms-preferences.sqlite");
process.env.SMS_MAX_PER_DAY = "2";
process.env.SMS_PROVIDER = "log";

const PHONE = "+2348012345678";

let smsLib: typeof import("../src/lib/smsNotifications");
let smsRoutes: typeof import("../src/routes/smsNotifications");
let server: Server;
let base: string;

beforeAll(async () => {
  smsLib = await import("../src/lib/smsNotifications");
  smsRoutes = await import("../src/routes/smsNotifications");

  const app = express();
  app.use(express.json());
  app.use("/api/users", smsRoutes.smsPreferencesRouter);
  app.use("/api/sms-notifications", smsRoutes.smsNotificationsRouter);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("preferences", () => {
  it("defaults every event to disabled (opt-in)", () => {
    expect(smsLib.getSmsPreferences(PHONE)).toEqual({ low_balance: false, payment_received: false, meter_issue: false });
  });

  it("opts in to specific events", () => {
    const prefs = smsLib.setSmsPreferences(PHONE, { low_balance: true, meter_issue: true });
    expect(prefs).toEqual({ low_balance: true, payment_received: false, meter_issue: true });
  });
});

describe("sendSmsNotification", () => {
  it("refuses to send when the user has not opted in", async () => {
    const outcome = await smsLib.sendSmsNotification({ phone: PHONE, event: "payment_received", message: "You received a payment" });
    expect(outcome).toEqual({ ok: false, reason: "preference-disabled" });
  });

  it("sends via the configured provider when opted in, and enforces the daily cap", async () => {
    const first = await smsLib.sendSmsNotification({ phone: PHONE, event: "low_balance", message: "Your balance is low" });
    expect(first).toMatchObject({ ok: true, result: { delivered: false, provider: "log" } });

    await smsLib.sendSmsNotification({ phone: PHONE, event: "meter_issue", message: "Meter fault detected" });

    // SMS_MAX_PER_DAY is 2 and both have now been used.
    const third = await smsLib.sendSmsNotification({ phone: PHONE, event: "low_balance", message: "Still low" });
    expect(third).toEqual({ ok: false, reason: "rate-limited" });
  });
});

describe("HTTP endpoints", () => {
  const otherPhone = "+15551234567";

  it("rejects an invalid phone number", async () => {
    const res = await fetch(`${base}/api/users/sms-preferences?phone=not-a-phone`);
    expect(res.status).toBe(400);
  });

  it("sets and reads preferences", async () => {
    const put = await fetch(`${base}/api/users/sms-preferences`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: otherPhone, preferences: { payment_received: true } }),
    });
    expect(put.status).toBe(200);
    expect((await put.json()).preferences.payment_received).toBe(true);

    const get = await fetch(`${base}/api/users/sms-preferences?phone=${encodeURIComponent(otherPhone)}`);
    expect((await get.json()).preferences.payment_received).toBe(true);
  });

  it("sends a notification through the admin endpoint", async () => {
    const res = await fetch(`${base}/api/sms-notifications/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: otherPhone, event: "payment_received", message: "Payment received" }),
    });
    expect(res.status).toBe(202); // log provider does not "deliver"
    const body = await res.json();
    expect(body).toMatchObject({ accepted: true, provider: "log" });
  });

  it("validates the send payload", async () => {
    const res = await fetch(`${base}/api/sms-notifications/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: otherPhone, event: "not-a-real-event", message: "x" }),
    });
    expect(res.status).toBe(400);
  });
});
