import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

process.env.SUPPORT_TICKETS_DB_PATH = ":memory:";
process.env.EMAIL_PROVIDER = "log";
process.env.SUPPORT_EMAIL = "support@example.test";

const sessions = new Map<string, string>();
vi.mock("../src/lib/walletAuth.js", () => ({
  createSession: (address: string) => { const token = `test-${address}`; sessions.set(token, address); return { token, expiresAt: new Date(Date.now() + 60_000).toISOString() }; },
  sessionAddress: (token: string | undefined) => (token ? sessions.get(token) : undefined),
}));

const { supportTicketsRouter } = await import("../src/routes/supportTickets.js");
const { createSession } = await import("../src/lib/walletAuth.js");

const USER_A = "GUSERA";
const USER_B = "GUSERB";
const tokenA = createSession(USER_A).token;
const tokenB = createSession(USER_B).token;
let server: Server;
let base: string;

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

describe("support ticket API", () => {
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use("/api/tickets", supportTicketsRouter);
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/tickets`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("requires a wallet session", async () => {
    const response = await fetch(base);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("creates and lists only the authenticated user's tickets", async () => {
    const created = await fetch(base, {
      method: "POST",
      headers: { ...auth(tokenA), "Content-Type": "application/json" },
      body: JSON.stringify({
        subject: "Meter is offline",
        description: "The meter has not reported for two hours.",
        priority: "high",
        email: "user@example.test",
      }),
    });
    expect(created.status).toBe(201);
    const ticket = (await created.json()).ticket;
    expect(ticket).toMatchObject({ user: USER_A, subject: "Meter is offline", status: "open", priority: "high" });
    expect(ticket.id).toEqual(expect.any(Number));

    const own = await fetch(base, { headers: auth(tokenA) });
    expect(own.status).toBe(200);
    expect((await own.json()).tickets).toHaveLength(1);

    const other = await fetch(base, { headers: auth(tokenB) });
    expect(other.status).toBe(200);
    expect((await other.json()).tickets).toHaveLength(0);
  });

  it("rejects malformed ticket payloads", async () => {
    const response = await fetch(base, {
      method: "POST",
      headers: { ...auth(tokenA), "Content-Type": "application/json" },
      body: JSON.stringify({ subject: "", description: "short", priority: "critical" }),
    });
    expect(response.status).toBe(400);
  });

  it("updates status for the owner and prevents cross-user updates", async () => {
    const forbidden = await fetch(`${base}/1`, {
      method: "PATCH",
      headers: { ...auth(tokenB), "Content-Type": "application/json" },
      body: JSON.stringify({ status: "resolved" }),
    });
    expect(forbidden.status).toBe(404);

    const updated = await fetch(`${base}/1`, {
      method: "PATCH",
      headers: { ...auth(tokenA), "Content-Type": "application/json" },
      body: JSON.stringify({ status: "in_progress" }),
    });
    expect(updated.status).toBe(200);
    expect((await updated.json()).ticket.status).toBe("in_progress");
  });
});
