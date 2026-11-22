/**
 * #1161: error responses must not be cached for as long as successful ones.
 *
 * The weather route and library do not cache errors (a failed provider call throws and nothing is
 * stored), which the second block pins. The defect is in the shared `cacheFor` middleware, which
 * cached every `res.json` for the full TTL whatever the status; that is fixed and tested here.
 */
import type { NextFunction, Request, Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { cacheFor, ERROR_CACHE_TTL_MS, _resetCacheForTests } = await import("../src/middleware/cache.js");

const TEN_MINUTES = 10 * 60 * 1000;

/** Runs the middleware for one request and reports what the client received. */
function call(middleware: ReturnType<typeof cacheFor>, url: string, handler: (res: Response) => void) {
  const headers: Record<string, string> = {};
  let sent: { status: number; body: unknown } | undefined;
  let handlerRan = false;
  const res = {
    statusCode: 200,
    setHeader(name: string, value: string) {
      headers[name] = value;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      sent = { status: this.statusCode, body };
      return this;
    },
  } as unknown as Response;

  middleware({ originalUrl: url } as Request, res, (() => {
    handlerRan = true;
    handler(res);
  }) as NextFunction);

  return { headers, sent, handlerRan };
}

const respondWith = (status: number, body: unknown) => (res: Response) => {
  res.status(status);
  res.json(body);
};

beforeEach(() => {
  vi.useFakeTimers();
  _resetCacheForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("cacheFor", () => {
  it("defaults the error TTL to 10 seconds", () => {
    expect(ERROR_CACHE_TTL_MS).toBe(10_000);
  });

  it("serves a successful response from cache for the full TTL", () => {
    const mw = cacheFor(TEN_MINUTES);
    call(mw, "/w?lat=1", respondWith(200, { ok: 1 }));

    vi.advanceTimersByTime(TEN_MINUTES - 1);
    const hit = call(mw, "/w?lat=1", respondWith(200, { ok: 2 }));

    expect(hit.handlerRan).toBe(false);
    expect(hit.sent).toEqual({ status: 200, body: { ok: 1 } });
    expect(hit.headers["Cache-Control"]).toBe("public, max-age=600");
  });

  it("expires a successful response after the TTL", () => {
    const mw = cacheFor(TEN_MINUTES);
    call(mw, "/w", respondWith(200, { ok: 1 }));

    vi.advanceTimersByTime(TEN_MINUTES);
    const next = call(mw, "/w", respondWith(200, { ok: 2 }));

    expect(next.handlerRan).toBe(true);
    expect(next.sent?.body).toEqual({ ok: 2 });
  });

  it("stops serving a 503 after 10 seconds, so a recovered upstream is picked up", () => {
    const mw = cacheFor(TEN_MINUTES);
    call(mw, "/w", respondWith(503, { error: "upstream down" }));

    vi.advanceTimersByTime(ERROR_CACHE_TTL_MS - 1);
    const stillCached = call(mw, "/w", respondWith(200, { ok: 1 }));
    expect(stillCached.handlerRan).toBe(false);

    vi.advanceTimersByTime(1);
    const recovered = call(mw, "/w", respondWith(200, { ok: 1 }));
    expect(recovered.handlerRan).toBe(true);
    expect(recovered.sent).toEqual({ status: 200, body: { ok: 1 } });
  });

  it("replays a cached error with its original status, and not as a public cacheable response", () => {
    const mw = cacheFor(TEN_MINUTES);
    const first = call(mw, "/w", respondWith(503, { error: "upstream down" }));
    const replay = call(mw, "/w", respondWith(200, { ok: 1 }));

    expect(first.headers["Cache-Control"]).toBe("no-store");
    expect(replay.sent).toEqual({ status: 503, body: { error: "upstream down" } });
    expect(replay.headers["Cache-Control"]).toBe("no-store");
  });

  it.each([400, 404, 429, 500, 502, 503, 504])("applies the short TTL to a %s", (status) => {
    const mw = cacheFor(TEN_MINUTES);
    call(mw, "/w", respondWith(status, { error: "x" }));

    vi.advanceTimersByTime(ERROR_CACHE_TTL_MS);

    expect(call(mw, "/w", respondWith(200, { ok: 1 })).handlerRan).toBe(true);
  });

  it("treats every 2xx as a success", () => {
    const mw = cacheFor(TEN_MINUTES);
    call(mw, "/created", respondWith(201, { id: 1 }));
    vi.advanceTimersByTime(ERROR_CACHE_TTL_MS + 1);

    expect(call(mw, "/created", respondWith(201, { id: 2 })).handlerRan).toBe(false);
  });

  it("never caches an error for longer than the success TTL", () => {
    const mw = cacheFor(5_000);
    call(mw, "/w", respondWith(503, { error: "x" }));

    vi.advanceTimersByTime(5_000);

    expect(call(mw, "/w", respondWith(200, { ok: 1 })).handlerRan).toBe(true);
  });

  it("accepts a custom error TTL", () => {
    const mw = cacheFor(TEN_MINUTES, 2_000);
    call(mw, "/w", respondWith(503, { error: "x" }));

    vi.advanceTimersByTime(2_000);

    expect(call(mw, "/w", respondWith(200, { ok: 1 })).handlerRan).toBe(true);
  });

  it("keeps different URLs apart, and a cached error does not hide a success elsewhere", () => {
    const mw = cacheFor(TEN_MINUTES);
    call(mw, "/w?lat=1", respondWith(503, { error: "x" }));
    call(mw, "/w?lat=2", respondWith(200, { ok: 2 }));

    expect(call(mw, "/w?lat=2", respondWith(200, { ok: 9 })).sent?.body).toEqual({ ok: 2 });
    expect(call(mw, "/w?lat=1", respondWith(200, { ok: 9 })).sent?.status).toBe(503);
  });
});

describe("weather: a failed provider call is not cached", () => {
  const original = { key: process.env.OPENWEATHERMAP_API_KEY };

  beforeEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    process.env.OPENWEATHERMAP_API_KEY = "test-key";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (original.key === undefined) delete process.env.OPENWEATHERMAP_API_KEY;
    else process.env.OPENWEATHERMAP_API_KEY = original.key;
  });

  it("asks the provider again on the next request after a 503, instead of replaying the error", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("down", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const { getWeather, getWeatherUsage, WeatherUnavailableError } = await import("../src/lib/weather.js");

    await expect(getWeather(52.5, 13.4)).rejects.toBeInstanceOf(WeatherUnavailableError);
    await expect(getWeather(52.5, 13.4)).rejects.toBeInstanceOf(WeatherUnavailableError);

    expect(fetchMock).toHaveBeenCalledTimes(2); // not served from a cached error
    expect(getWeatherUsage().cachedLocations).toBe(0);
  });
});
