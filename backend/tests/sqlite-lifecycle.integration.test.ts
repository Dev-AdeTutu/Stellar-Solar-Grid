import { afterEach, describe, expect, it } from "vitest";
import * as StellarSdk from "@stellar/stellar-sdk";

process.env.USAGE_EVENTS_DB_PATH = ":memory:";
process.env.ADMIN_SECRET_KEY = StellarSdk.Keypair.random().secret();
process.env.CONTRACT_ID = "CLOCALTEST";

const usageEvents = await import("../src/lib/usageEvents.js");

describe("SQLite lifecycle (#773)", () => {
  afterEach(() => {
    usageEvents.closeUsageEventStore();
  });

  it("closes the usage-event database handle during shutdown", () => {
    const database = usageEvents.initUsageEventStore() as { open: boolean };

    expect(database.open).toBe(true);
    usageEvents.closeUsageEventStore();
    expect(database.open).toBe(false);
  });
});
