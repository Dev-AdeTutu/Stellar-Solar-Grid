import express from "express";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getNextQuizAttemptNumbers,
  getQuizAttempt,
  resetEducationAttemptsStoreForTests,
  setEducationAttemptsDatabasePathForTests,
} from "../src/lib/educationAttempts.js";
import { educationRouter } from "../src/routes/education.js";

let testDirectory: string;
let server: Server;
let baseUrl: string;

beforeEach(async () => {
  testDirectory = mkdtempSync(join(tmpdir(), "education-attempts-"));
  setEducationAttemptsDatabasePathForTests(join(testDirectory, "education.db"));

  const app = express();
  app.use(express.json());
  app.use("/api/education", educationRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  resetEducationAttemptsStoreForTests();
  rmSync(testDirectory, { recursive: true, force: true });
});

describe("education quiz attempt idempotency (#1191)", () => {
  it("updates the same attempt on retry and reserves a new number only after it advances", async () => {
    const endpoint = `${baseUrl}/api/education/user-1/solar/submit`;
    const submit = (answers: number[], attempt_number: number) => fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answers, attempt_number }),
    });

    const first = await submit([0], 1);
    expect(first.status).toBe(200);
    expect((await first.json()).attemptNumber).toBe(1);

    const retry = await submit([1], 1);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ score: 0, attemptNumber: 1 });
    expect(getQuizAttempt("user-1", "solar", 1)).toMatchObject({
      score: 0,
      answers: [1],
    });
    expect(getNextQuizAttemptNumbers("user-1")).toEqual({ solar: 2 });

    const nextAttempt = await submit([0], 2);
    expect(nextAttempt.status).toBe(200);
    expect(getNextQuizAttemptNumbers("user-1")).toEqual({ solar: 3 });
  });

  it("rejects invalid attempt numbers", async () => {
    const response = await fetch(`${baseUrl}/api/education/user-1/solar/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answers: [0], attempt_number: 0 }),
    });
    expect(response.status).toBe(400);
  });

  it("requires an explicit attempt number to prevent accidental reuse of attempt one", async () => {
    const response = await fetch(`${baseUrl}/api/education/user-1/solar/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answers: [0] }),
    });
    expect(response.status).toBe(400);
  });
});
