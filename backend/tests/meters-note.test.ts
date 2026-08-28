import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Request } from "express";

vi.mock("../src/lib/stellar", () => ({
  stellarService: {
    invoke: vi.fn(),
    query: vi.fn(),
    contractId: "C123",
    server: {},
    adminKeypair: {},
    networkPassphrase: "test",
  },
}));

process.env.METER_NOTES_DB_PATH = ":memory:";

import { createMeterRouter } from "../src/routes/meters";
import { stellarService } from "../src/lib/stellar";
import {
  addMeterNote,
  getLatestMeterNotes,
  getAllMeterNotes,
  initMeterNotesStore,
} from "../src/lib/meterNotes";
import * as StellarSdk from "@stellar/stellar-sdk";

function getRouteHandler(router: any, path: string, method: string) {
  const route = router.stack.find(
    (layer: any) => layer.route?.path === path && layer.route?.methods[method],
  )?.route;
  if (!route) {
    throw new Error(`Route ${method.toUpperCase()} ${path} not found`);
  }
  return {
    route,
    handler: route.stack.slice(-1)[0]?.handle,
  };
}

/** asyncHandler does not return its promise — wait until res.json/status fires. */
function invokeHandler(
  handler: (req: any, res: any, next: any) => void,
  req: Partial<Request>,
  resMocks: { jsonMock: ReturnType<typeof vi.fn>; statusMock: ReturnType<typeof vi.fn> },
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
      setHeader: vi.fn(),
      end: () => resolve(),
    };
    try {
      handler(req, res, (err?: unknown) => (err ? reject(err) : resolve()));
    } catch (err) {
      reject(err);
    }
  });
}

describe("meter notes", () => {
  let router: ReturnType<typeof createMeterRouter>;
  let db: ReturnType<typeof initMeterNotesStore>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ADMIN_API_KEY = "test-admin-key";
    router = createMeterRouter(stellarService);
    db = initMeterNotesStore();
    db.exec("DELETE FROM meter_notes");
  });

  describe("meterNotes store", () => {
    it("persists notes and returns latest 5 newest-first", () => {
      for (let i = 1; i <= 6; i++) {
        addMeterNote("meter1", `note-${i}`);
      }

      const notes = getLatestMeterNotes("meter1", 5);
      expect(notes).toHaveLength(5);
      expect(notes.map((n) => n.text)).toEqual([
        "note-6",
        "note-5",
        "note-4",
        "note-3",
        "note-2",
      ]);
      expect(getLatestMeterNotes("other", 5)).toEqual([]);
    });

    it("treats SQL-like meter IDs as data across every query", () => {
      const injectedId = "meter-1' OR 1=1 --";
      addMeterNote(injectedId, "quoted meter note");
      addMeterNote("meter-2", "unrelated note");

      const latest = getLatestMeterNotes(injectedId, 5);
      expect(latest).toHaveLength(1);
      expect(latest[0]).toEqual(
        expect.objectContaining({ meter_id: injectedId, text: "quoted meter note" }),
      );

      const page = getAllMeterNotes(injectedId, 1, 5);
      expect(page.total).toBe(1);
      expect(page.notes).toHaveLength(1);
      expect(page.notes[0].meter_id).toBe(injectedId);
      expect(getAllMeterNotes("meter-2", 1, 5).total).toBe(1);
    });

    it("sanitizes HTML/JS before storage and returns encoded text (Issue #738)", () => {
      const injection =
        "<script>alert('XSS')</script><img src=x onerror=alert(document.cookie)>";
      const note = addMeterNote("meter1", injection);

      // Stored + returned text must never contain raw markup.
      expect(note.text).not.toContain("<script>");
      expect(note.text).not.toContain("<img");
      expect(note.text).toContain("&lt;script&gt;");

      const latest = getLatestMeterNotes("meter1", 5);
      expect(latest[0].text).toBe(note.text);

      const page = getAllMeterNotes("meter1", 1, 5);
      expect(page.notes[0].text).toBe(note.text);
    });

    it("encodes each HTML-significant character and round-trips on read", () => {
      const raw = `a & b < c > d "e" 'f'`;
      const note = addMeterNote("meter1", raw);

      expect(note.text).toBe("a &amp; b &lt; c &gt; d &quot;e&quot; &#39;f&#39;");

      // Read-time sanitization is a stable round-trip (no double-encoding).
      const latest = getLatestMeterNotes("meter1", 5);
      expect(latest[0].text).toBe(note.text);
    });

    it("re-sanitizes legacy raw rows that predate the fix on read (Issue #738)", () => {
      db.prepare(
        `INSERT INTO meter_notes (meter_id, author_ip, text, created_at) VALUES (?, ?, ?, ?)`,
      ).run("meterLegacy", null, "<script>legacy()</script>", new Date().toISOString());

      const latest = getLatestMeterNotes("meterLegacy", 5);
      expect(latest).toHaveLength(1);
      expect(latest[0].text).not.toContain("<script>");
      expect(latest[0].text).toContain("&lt;script&gt;");
    });
  });

  describe("POST /api/meters/:id/note", () => {
    it("registers requireAdminKey middleware", () => {
      const { route } = getRouteHandler(router, "/:id/note", "post");
      const middlewareNames = route.stack.map((layer: any) => layer.name);
      expect(middlewareNames).toContain("requireAdminKey");
    });

    it("creates a note when the meter exists", async () => {
      (stellarService.query as any).mockResolvedValue(
        StellarSdk.nativeToScVal({ active: true }),
      );

      const { handler } = getRouteHandler(router, "/:id/note", "post");
      const jsonMock = vi.fn();
      const statusMock = vi.fn();
      await invokeHandler(
        handler,
        {
          params: { id: "meter123" },
          body: { text: "Checked on-site; panel clean" },
          headers: { "x-admin-key": "test-admin-key" },
        },
        { jsonMock, statusMock },
      );

      expect(statusMock).toHaveBeenCalledWith(201);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          meter_id: "meter123",
          text: "Checked on-site; panel clean",
          id: expect.any(Number),
          created_at: expect.any(String),
        }),
      );
      expect(getLatestMeterNotes("meter123", 5)).toHaveLength(1);
    });

    it("returns 404 when meter does not exist", async () => {
      (stellarService.query as any).mockRejectedValue(new Error("not found"));

      const { handler } = getRouteHandler(router, "/:id/note", "post");
      const jsonMock = vi.fn();
      const statusMock = vi.fn();
      await invokeHandler(
        handler,
        {
          params: { id: "missing" },
          body: { text: "orphan note" },
          headers: { "x-admin-key": "test-admin-key" },
        },
        { jsonMock, statusMock },
      );

      expect(statusMock).toHaveBeenCalledWith(404);
      expect(jsonMock).toHaveBeenCalledWith({
        error: "Meter not found",
        code: "NOT_FOUND",
      });
      expect(getLatestMeterNotes("missing", 5)).toHaveLength(0);
    });
  });

  describe("GET /api/meters/:id", () => {
    it("includes latest 5 notes in the response", async () => {
      for (let i = 1; i <= 3; i++) {
        addMeterNote("meter123", `annotation-${i}`);
      }

      (stellarService.query as any).mockResolvedValue(
        StellarSdk.nativeToScVal({ active: true, owner: "GTEST" }),
      );

      const { handler } = getRouteHandler(router, "/:id", "get");
      const jsonMock = vi.fn();
      const statusMock = vi.fn();
      await invokeHandler(
        handler,
        { params: { id: "meter123" }, headers: {} },
        { jsonMock, statusMock },
      );

      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          meter: expect.objectContaining({ active: true }),
          notes: expect.arrayContaining([
            expect.objectContaining({ text: "annotation-3" }),
            expect.objectContaining({ text: "annotation-2" }),
            expect.objectContaining({ text: "annotation-1" }),
          ]),
        }),
      );
      const payload = jsonMock.mock.calls[0][0];
      expect(payload.notes).toHaveLength(3);
    });
  });
});
