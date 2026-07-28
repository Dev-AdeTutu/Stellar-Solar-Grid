import { describe, it, expect, beforeEach, vi } from "vitest";
import { Request, Response } from "express";
import { usageEventsRouter } from "../src/routes/usageEvents";
import {
  purgeSubmittedUsageEvents,
  getFailedUsageEvents,
  replayFailedUsageEvent,
} from "../src/lib/usageEvents";

vi.mock("../src/lib/usageEvents", () => ({
  purgeSubmittedUsageEvents: vi.fn(),
  getFailedUsageEvents: vi.fn(),
  replayFailedUsageEvent: vi.fn(),
}));

describe("usageEventsRouter - admin authentication", () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let jsonMock: any;
  let statusMock: any;
  let nextMock: any;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ADMIN_API_KEY = "test-admin-key";

    jsonMock = vi.fn().mockReturnValue({});
    statusMock = vi.fn().mockReturnValue({ json: jsonMock });
    nextMock = vi.fn();

    req = {
      headers: {},
      query: {},
      params: {},
    };
    res = {
      json: jsonMock,
      status: statusMock,
    };
  });

  const getHandler = (method: "get" | "post" | "delete", path: string) => {
    const layer = usageEventsRouter.stack.find(
      (l: any) => l.route?.path === path && l.route?.methods[method]
    );
    if (!layer) throw new Error(`Handler for ${method.toUpperCase()} ${path} not found`);
    return {
      auth: usageEventsRouter.stack.find((l: any) => l.name === "adminAuth")?.handle,
      handler: layer.route.stack[1].handle,
    };
  };

  it("should block unauthenticated requests when ADMIN_API_KEY is set", async () => {
    const { auth } = getHandler("delete", "/");
    expect(auth).toBeDefined();

    req.headers = {};
    await auth!(req as any, res as any, nextMock);

    expect(statusMock).toHaveBeenCalledWith(401);
    expect(jsonMock).toHaveBeenCalledWith({ error: "Unauthorized", code: "UNAUTHORIZED" });
    expect(nextMock).not.toHaveBeenCalled();
  });

  it("should allow authenticated requests with valid Bearer token", async () => {
    const { auth } = getHandler("delete", "/");
    req.headers = { authorization: "Bearer test-admin-key" };

    await auth!(req as any, res as any, nextMock);

    expect(nextMock).toHaveBeenCalled();
    expect(statusMock).not.toHaveBeenCalled();
  });
});

describe("usageEventsRouter - DELETE /api/usage-events", () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let jsonMock: any;
  let statusMock: any;

  beforeEach(() => {
    vi.clearAllMocks();
    jsonMock = vi.fn().mockReturnValue({});
    statusMock = vi.fn().mockReturnValue({ json: jsonMock });

    req = { query: {} };
    res = { json: jsonMock, status: statusMock };
  });

  const getDeleteHandler = () => {
    const layer = usageEventsRouter.stack.find(
      (l: any) => l.route?.path === "/" && l.route?.methods.delete
    );
    return layer.route.stack[1].handle;
  };

  it("should purge events with default 90 days if olderThanDays query param is omitted", async () => {
    (purgeSubmittedUsageEvents as any).mockReturnValueOnce(5);
    const handler = getDeleteHandler();

    await handler(req as any, res as any, () => {});

    expect(purgeSubmittedUsageEvents).toHaveBeenCalledWith(90);
    expect(jsonMock).toHaveBeenCalledWith({ deletedCount: 5 });
  });

  it("should use provided olderThanDays query param", async () => {
    (purgeSubmittedUsageEvents as any).mockReturnValueOnce(10);
    req.query = { olderThanDays: "30" };
    const handler = getDeleteHandler();

    await handler(req as any, res as any, () => {});

    expect(purgeSubmittedUsageEvents).toHaveBeenCalledWith(30);
    expect(jsonMock).toHaveBeenCalledWith({ deletedCount: 10 });
  });

  it("should return 400 if olderThanDays query param is invalid", async () => {
    req.query = { olderThanDays: "invalid-number" };
    const handler = getDeleteHandler();

    await handler(req as any, res as any, () => {});

    expect(statusMock).toHaveBeenCalledWith(400);
    expect(jsonMock).toHaveBeenCalledWith({ error: "Invalid olderThanDays parameter", code: "VALIDATION_ERROR" });
  });
});

describe("usageEventsRouter - GET /api/usage-events/failed", () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let jsonMock: any;
  let statusMock: any;

  beforeEach(() => {
    vi.clearAllMocks();
    jsonMock = vi.fn().mockReturnValue({});
    statusMock = vi.fn().mockReturnValue({ json: jsonMock });

    req = { query: {} };
    res = { json: jsonMock, status: statusMock };
  });

  const getFailedHandler = () => {
    const layer = usageEventsRouter.stack.find(
      (l: any) => l.route?.path === "/failed" && l.route?.methods.get
    );
    return layer.route.stack[1].handle;
  };

  it("should return paginated list of failed events", async () => {
    const mockEvents = [
      { id: 1, meter_id: "M1", units: 100, status: "failed", attempt_count: 5 },
    ];
    (getFailedUsageEvents as any).mockReturnValueOnce({ events: mockEvents, total: 1 });
    req.query = { page: "2", pageSize: "5" };
    const handler = getFailedHandler();

    await handler(req as any, res as any, () => {});

    expect(getFailedUsageEvents).toHaveBeenCalledWith(2, 5);
    expect(jsonMock).toHaveBeenCalledWith({
      events: mockEvents,
      pagination: {
        page: 2,
        pageSize: 5,
        total: 1,
        pages: 1,
      },
    });
  });
});

describe("usageEventsRouter - POST /api/usage-events/:id/replay", () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let jsonMock: any;
  let statusMock: any;

  beforeEach(() => {
    vi.clearAllMocks();
    jsonMock = vi.fn().mockReturnValue({});
    statusMock = vi.fn().mockReturnValue({ json: jsonMock });

    req = { params: {} };
    res = { json: jsonMock, status: statusMock };
  });

  const getReplayHandler = () => {
    const layer = usageEventsRouter.stack.find(
      (l: any) => l.route?.path === "/:id/replay" && l.route?.methods.post
    );
    return layer.route.stack[1].handle;
  };

  it("should replay event and return updated record", async () => {
    const mockEvent = { id: 42, meter_id: "M1", units: 50, status: "pending", attempt_count: 0 };
    (replayFailedUsageEvent as any).mockReturnValueOnce(mockEvent);
    req.params = { id: "42" };
    const handler = getReplayHandler();

    await handler(req as any, res as any, () => {});

    expect(replayFailedUsageEvent).toHaveBeenCalledWith(42);
    expect(jsonMock).toHaveBeenCalledWith(mockEvent);
  });

  it("should return 404 if event is not found or not in failed state", async () => {
    (replayFailedUsageEvent as any).mockReturnValueOnce(undefined);
    req.params = { id: "99" };
    const handler = getReplayHandler();

    await handler(req as any, res as any, () => {});

    expect(replayFailedUsageEvent).toHaveBeenCalledWith(99);
    expect(statusMock).toHaveBeenCalledWith(404);
    expect(jsonMock).toHaveBeenCalledWith({ error: "Failed usage event not found", code: "NOT_FOUND" });
  });
});
