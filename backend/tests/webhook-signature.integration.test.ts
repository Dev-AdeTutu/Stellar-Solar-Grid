import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as crypto from "crypto";
import type { AddressInfo } from "net";
import type { Server } from "http";
import express from "express";

vi.hoisted(() => {
  process.env.ADMIN_API_KEY = "test-admin-key";
  process.env.TELECOM_WEBHOOK_SECRET = "telecom-test-secret";
});

const invoke = vi.hoisted(() => vi.fn().mockResolvedValue("tx-hash"));
vi.mock("../src/lib/stellar", () => ({ stellarService: { invoke } }));

import { webhookRouter } from "../src/routes/webhooks";

const sign = (body: string) =>
  "sha256=" +
  crypto.createHmac("sha256", "telecom-test-secret").update(body).digest("hex");

describe("POST /api/webhooks/sms-payment signature validation", () => {
  let server: Server;
  let url: string;

  beforeAll(async () => {
    const app = express();
    app.use(
      express.json({
        verify: (req, _res, buf) => {
          (req as unknown as { rawBody?: Buffer }).rawBody = buf;
        },
      }),
    );
    app.use("/api/webhooks", webhookRouter);
    server = app.listen(0);
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/webhooks/sms-payment`;
  });
  afterAll(() => server.close());

  const post = (body: string | undefined, headers: Record<string, string> = {}) =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    });

  it("returns 400 for an empty body with a signature header", async () => {
    const res = await post("", { "x-webhook-signature": sign("") });
    expect(res.status).toBe(400);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("returns 400 for an empty body without a signature header", async () => {
    expect((await post(undefined)).status).toBe(400);
  });

  it("returns 401 for a missing signature", async () => {
    const res = await post(JSON.stringify({ meter_id: "METER1", amount_xlm: 5 }));
    expect(res.status).toBe(401);
  });

  it("returns 401 (not 500) for a wrong-length signature", async () => {
    const res = await post(JSON.stringify({ meter_id: "METER1", amount_xlm: 5 }), {
      "x-webhook-signature": "sha256=abc",
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 for a signature over a different body", async () => {
    const res = await post(JSON.stringify({ meter_id: "METER1", amount_xlm: 5 }), {
      "x-webhook-signature": sign("{}"),
    });
    expect(res.status).toBe(401);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("accepts a correctly signed body, verified against the raw bytes", async () => {
    const body = '{ "meter_id":"METER1",  "amount_xlm": 5 }'; // non-canonical spacing
    const res = await post(body, { "x-webhook-signature": sign(body) });
    expect(res.status).toBe(200);
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
