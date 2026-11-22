/**
 * SMS config phone registration (#1152): posting the same number twice must
 * upsert rather than append a duplicate.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";

import { resetSmsConfigForTests } from "../src/lib/smsConfig.js";
import { smsConfigRouter } from "../src/routes/smsConfig.js";

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/sms-config", smsConfigRouter);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  resetSmsConfigForTests();
});

describe("registering phone numbers", () => {
  it("reports the first post as created", async () => {
    const res = await fetch(`${base}/api/sms-config/phones`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: "+2348012345678" }),
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ phone: "+2348012345678", created: true });
  });

  it("upserts a repeated number instead of appending a duplicate", async () => {
    const body = JSON.stringify({ phone: "+2348012345678" });
    const options = { method: "POST", headers: { "content-type": "application/json" }, body };
    await fetch(`${base}/api/sms-config/phones`, options);
    const second = await fetch(`${base}/api/sms-config/phones`, options);

    await expect(second.json()).resolves.toEqual({
      phone: "+2348012345678",
      created: false,
      phones: ["+2348012345678"],
    });
  });

  it("rejects an invalid E.164 number", async () => {
    const res = await fetch(`${base}/api/sms-config/phones`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: "not-a-phone" }),
    });
    expect(res.status).toBe(400);
  });

  it("lists each registered number exactly once", async () => {
    const phone = "+15551234567";
    for (let i = 0; i < 3; i += 1) {
      await fetch(`${base}/api/sms-config/phones`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone }),
      });
    }
    const res = await fetch(`${base}/api/sms-config/phones`);
    await expect(res.json()).resolves.toEqual({ phones: [phone] });
  });
});
