import { describe, it, expect, beforeEach } from "vitest";
import { Request, Response } from "express";

process.env.USAGE_HISTORY_DB_PATH = ":memory:";

import { usageRouter } from "../src/routes/usage.js";
import { addUsageHistory, initUsageHistoryStore } from "../src/lib/usageHistory.js";

function getRouteHandler(router: any, path: string, method: string) {
  const route = router.stack.find(
    (layer: any) => layer.route?.path === path && layer.route?.methods[method],
  )?.route;
  if (!route) {
    throw new Error(`Route ${method.toUpperCase()} ${path} not found`);
  }
  return route.stack.slice(-1)[0]?.handle;
}

function invokeHandler(
  handler: (req: any, res: any, next: any) => void,
  req: Partial<Request>,
  resMocks: { jsonMock: any; statusMock: any },
) {
  return new Promise<void>((resolve, reject) => {
    const res = {
      json: (...args: unknown[]) => {
        resMocks.jsonMock(...args);
        resolve();
        return {};
      },
      status: (code: number) => {
        resMocks.statusMock(code);
        return {
          json: (...args: unknown[]) => {
            resMocks.jsonMock(...args);
            resolve();
            return {};
          },
        };
      },
    };
    try {
      handler(req, res, (err: unknown) => {
        if (err) reject(err);
      });
    } catch (err) {
      reject(err);
    }
  });
}

describe("Usage History API", () => {
  beforeEach(() => {
    const db = initUsageHistoryStore() as any;
    db.exec("DELETE FROM usage_history");
  });

  describe("POST /api/usage/:meterId", () => {
    it("rejects request if units is missing or negative", async () => {
      const handler = getRouteHandler(usageRouter, "/:meterId", "post");
      const jsonMock = vi.fn();
      const statusMock = vi.fn().mockReturnThis();

      const req: Partial<Request> = {
        params: { meterId: "METER001" },
        body: {
          balance_before: 1000,
          balance_after: 900,
        },
      };

      await invokeHandler(handler, req, { jsonMock, statusMock });
      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock.mock.calls[0][0].error).toContain("units");
    });

    it("rejects request if balance is missing", async () => {
      const handler = getRouteHandler(usageRouter, "/:meterId", "post");
      const jsonMock = vi.fn();
      const statusMock = vi.fn().mockReturnThis();

      const req: Partial<Request> = {
        params: { meterId: "METER001" },
        body: {
          units: 10,
        },
      };

      await invokeHandler(handler, req, { jsonMock, statusMock });
      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock.mock.calls[0][0].error).toContain("balance_before");
    });

    it("successfully logs a usage update and returns 201", async () => {
      const handler = getRouteHandler(usageRouter, "/:meterId", "post");
      const jsonMock = vi.fn();
      const statusMock = vi.fn().mockReturnThis();

      const req: Partial<Request> = {
        params: { meterId: "METER001" },
        body: {
          units: 50,
          balance_before: 5000000,
          balance_after: 4500000,
          timestamp: "2026-09-24T08:00:00.000Z",
        },
      };

      await invokeHandler(handler, req, { jsonMock, statusMock });
      expect(statusMock).toHaveBeenCalledWith(201);
      const resData = jsonMock.mock.calls[0][0];
      expect(resData.meter_id).toBe("METER001");
      expect(resData.units).toBe(50);
      expect(resData.balance_before).toBe(5000000);
      expect(resData.balance_after).toBe(4500000);
      expect(resData.timestamp).toBe("2026-09-24T08:00:00.000Z");
    });
  });

  describe("GET /api/usage/:meterId", () => {
    it("returns paginated usage history", async () => {
      addUsageHistory({
        meter_id: "METER001",
        units: 10,
        balance_before: 1000,
        balance_after: 900,
        timestamp: "2026-09-24T01:00:00.000Z",
      });
      addUsageHistory({
        meter_id: "METER001",
        units: 20,
        balance_before: 900,
        balance_after: 700,
        timestamp: "2026-09-24T02:00:00.000Z",
      });

      const handler = getRouteHandler(usageRouter, "/:meterId", "get");
      const jsonMock = vi.fn();
      const statusMock = vi.fn().mockReturnThis();

      const req: Partial<Request> = {
        params: { meterId: "METER001" },
        query: { limit: "1" },
      };

      await invokeHandler(handler, req, { jsonMock, statusMock });
      const resData = jsonMock.mock.calls[0][0];
      expect(resData.meterId).toBe("METER001");
      expect(resData.history).toHaveLength(1);
      expect(resData.pagination.total).toBe(2);
      expect(resData.pagination.pages).toBe(2);
      expect(resData.pagination.limit).toBe(1);
    });

    it("filters usage history by from and to timestamp", async () => {
      addUsageHistory({
        meter_id: "METER002",
        units: 10,
        balance_before: 1000,
        balance_after: 900,
        timestamp: "2026-09-20T00:00:00.000Z",
      });
      addUsageHistory({
        meter_id: "METER002",
        units: 20,
        balance_before: 900,
        balance_after: 700,
        timestamp: "2026-09-22T00:00:00.000Z",
      });
      addUsageHistory({
        meter_id: "METER002",
        units: 30,
        balance_before: 700,
        balance_after: 400,
        timestamp: "2026-09-24T00:00:00.000Z",
      });

      const handler = getRouteHandler(usageRouter, "/:meterId", "get");
      const jsonMock = vi.fn();
      const statusMock = vi.fn().mockReturnThis();

      const req: Partial<Request> = {
        params: { meterId: "METER002" },
        query: {
          from: "2026-09-21T00:00:00.000Z",
          to: "2026-09-23T00:00:00.000Z",
        },
      };

      await invokeHandler(handler, req, { jsonMock, statusMock });
      const resData = jsonMock.mock.calls[0][0];
      expect(resData.history).toHaveLength(1);
      expect(resData.history[0].units).toBe(20);
    });
  });
});
