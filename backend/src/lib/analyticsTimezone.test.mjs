import test from "node:test";
import assert from "node:assert/strict";
import {
  createBucketFormatter,
  isValidTimezone,
  resolveTimezone,
} from "./analyticsTimezone.ts";

test("isValidTimezone accepts IANA zones and rejects garbage", () => {
  assert.equal(isValidTimezone("UTC"), true);
  assert.equal(isValidTimezone("America/New_York"), true);
  assert.equal(isValidTimezone("Africa/Lagos"), true);
  assert.equal(isValidTimezone("Not/AZone"), false);
  assert.equal(isValidTimezone(""), false);
});

test("resolveTimezone defaults empty values to UTC and rejects invalid ones", () => {
  assert.equal(resolveTimezone(undefined), "UTC");
  assert.equal(resolveTimezone(null), "UTC");
  assert.equal(resolveTimezone(""), "UTC");
  assert.equal(resolveTimezone("   "), "UTC");
  assert.equal(resolveTimezone("UTC"), "UTC");
  assert.equal(resolveTimezone(" America/New_York "), "America/New_York");
  assert.equal(resolveTimezone("Mars/Olympus"), null);
  assert.equal(resolveTimezone(42), null);
});

test("daily buckets use the requested timezone calendar day", () => {
  const utc = createBucketFormatter("UTC");
  const ny = createBucketFormatter("America/New_York");

  // 2025-01-01T03:30:00Z is still 2024-12-31 in New York.
  const instant = new Date("2025-01-01T03:30:00.000Z");
  assert.equal(utc(instant, "daily"), "2025-01-01");
  assert.equal(ny(instant, "daily"), "2024-12-31");

  // A late-evening event stays on its local day instead of spilling to UTC tomorrow.
  const late = new Date("2025-06-15T23:30:00.000Z");
  assert.equal(ny(late, "daily"), "2025-06-15");
});

test("weekly buckets start on Monday in the requested timezone", () => {
  const bucket = createBucketFormatter("UTC");
  // 2025-01-09 is a Thursday; its ISO week starts Monday 2025-01-06.
  assert.equal(bucket(new Date("2025-01-09T12:00:00.000Z"), "weekly"), "2025-01-06");
  // A Sunday belongs to the preceding Monday.
  assert.equal(bucket(new Date("2025-01-12T12:00:00.000Z"), "weekly"), "2025-01-06");
});

test("monthly buckets use the local year and month", () => {
  const bucket = createBucketFormatter("UTC");
  assert.equal(bucket(new Date("2025-02-20T12:00:00.000Z"), "monthly"), "2025-02");

  const ny = createBucketFormatter("America/New_York");
  // 2025-03-01T01:00Z is still February in New York.
  assert.equal(ny(new Date("2025-03-01T01:00:00.000Z"), "monthly"), "2025-02");
});
