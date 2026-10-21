import { describe, expect, it, vi, beforeEach } from "vitest";
import { graphql } from "graphql";
import { schema, rootValue } from "../src/routes/graphql.js";

// Mock stellar module
vi.mock("../src/lib/stellar.js", () => {
  return {
    stellarService: {
      contractId: "CDUMMYCONTRACTID",
      query: vi.fn(async (method: string, args: any[]) => {
        if (method === "get_meter") {
          return {
            owner: "GBEXAMPLEADDRESS1234567890123456789012345678901234567890",
            active: true,
            units_used: 120,
            plan: "Daily",
            last_payment: 1700000000,
            expires_at: 1700086400,
            daily_limit: 500,
            day_spent: 100,
          };
        }
        if (method === "get_meters_by_owner") {
          return [
            {
              id: "METER1",
              owner: "GBEXAMPLEADDRESS1234567890123456789012345678901234567890",
              active: true,
              units_used: 120,
              plan: "Daily",
              last_payment: 1700000000,
              expires_at: 1700086400,
            },
          ];
        }
        if (method === "get_meter_balance") {
          return BigInt(25000000);
        }
        return null;
      }),
    },
    server: {
      getEvents: vi.fn(async () => ({
        events: [],
      })),
    },
    CONTRACT_ID: "CDUMMYCONTRACTID",
  };
});

describe("GraphQL Resolvers (#810)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("queries health successfully", async () => {
    const result = await graphql({
      schema,
      source: "query { health }",
      rootValue,
    });
    expect(result.errors).toBeUndefined();
    expect(result.data?.health).toBe("ok");
  });

  it("queries meter(id) with resolver", async () => {
    const query = `
      query GetMeter($id: String!) {
        meter(id: $id) {
          id
          owner
          active
          unitsUsed
          plan
          dailyLimit
          balance
        }
      }
    `;
    const result = await graphql({
      schema,
      source: query,
      rootValue,
      variableValues: { id: "METER1" },
    });

    expect(result.errors).toBeUndefined();
    expect(result.data?.meter).toEqual({
      id: "METER1",
      owner: "GBEXAMPLEADDRESS1234567890123456789012345678901234567890",
      active: true,
      unitsUsed: 120,
      plan: "Daily",
      dailyLimit: 500,
      balance: "25000000",
    });
  });

  it("queries metersByOwner(address) with resolver", async () => {
    const query = `
      query GetMetersByOwner($address: String!) {
        metersByOwner(address: $address) {
          id
          owner
          active
          unitsUsed
          plan
        }
      }
    `;
    const result = await graphql({
      schema,
      source: query,
      rootValue,
      variableValues: {
        address: "GBEXAMPLEADDRESS1234567890123456789012345678901234567890",
      },
    });

    expect(result.errors).toBeUndefined();
    const meters = result.data?.metersByOwner as any[];
    expect(Array.isArray(meters)).toBe(true);
    expect(meters.length).toBe(1);
    expect(meters[0].id).toBe("METER1");
    expect(meters[0].active).toBe(true);
  });

  it("queries payments(meterId) with resolver", async () => {
    const query = `
      query GetPayments($meterId: String!) {
        payments(meterId: $meterId) {
          txHash
          amountXlm
          status
        }
      }
    `;
    const result = await graphql({
      schema,
      source: query,
      rootValue,
      variableValues: { meterId: "METER1" },
    });

    expect(result.errors).toBeUndefined();
    expect(Array.isArray(result.data?.payments)).toBe(true);
  });
});
