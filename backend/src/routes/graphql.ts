/**
 * GraphQL API (#898), served alongside REST at /graphql and /api/graphql.
 *
 *  - Schema: src/graphql/typeDefs.ts (docs: `npm run docs:graphql` → docs/graphql/)
 *  - Playground: GET /graphql in a browser
 *  - Limits: depth / complexity enforced before execution (src/graphql/complexity.ts)
 *  - Optimisation: per-request memoisation so a query touching the same meter,
 *    balance or payment list many times hits the chain once; payment events
 *    are fetched once per request and grouped by meter.
 *  - Coverage: typed resolvers for meters, payments, usage, health, predictions,
 *    solar, devices, weather and staking; every other REST endpoint is reachable
 *    through the `rest` pass-through field with the caller's auth headers.
 */
import { Router } from "express";
import { GraphQLError, execute, parse, specifiedRules, validate } from "graphql";
import * as StellarSdk from "@stellar/stellar-sdk";
import { z } from "zod";
import {
  PersistedQueryCache,
  PersistedQueryError,
  type GraphQLRequest,
} from "../lib/apq.js";
import { getUsageHistory } from "../lib/usageEvents.js";
import { stellarService, server, CONTRACT_ID } from "../lib/stellar.js";
import { logger } from "../lib/logger.js";
import { schema } from "../graphql/typeDefs.js";
import { QueryLimitError, analyzeQuery } from "../graphql/complexity.js";
import { getAllMeterHealth, getMeterHealth, recordHeartbeat } from "../lib/meterHealth.js";
import { getPrediction } from "../lib/usagePrediction.js";
import { calcDailyKwh, computeSolarForecast, IRRADIANCE_ZONES } from "./solar.js";
import {
  addCertification,
  completeMaintenance,
  deleteDevice,
  getDevice,
  getPerformanceSummary,
  getStabilityReport,
  listCertifications,
  listDevices,
  listDueMaintenance,
  listExpiringCertifications,
  listMaintenance,
  listPerformance,
  recordPerformance,
  registerDevice,
  scheduleMaintenance,
  updateDevice,
  type Device,
} from "../lib/deviceRegistry.js";
import {
  certSchema,
  maintenanceSchema,
  performanceSchema,
  registerSchema,
  updateSchema,
} from "./devices.js";
import { deriveAlerts, forecastProduction, getWeather, recordObservation } from "../lib/weather.js";
import { getStakerInfo, getStakingStats, getVotingPower } from "../lib/staking.js";

export { schema };

// ── Per-request context / memoisation ───────────────────────────────────────

export type GraphQLContext = {
  memo: Map<string, Promise<unknown>>;
  /** Auth headers forwarded by the `rest` pass-through. */
  headers: Record<string, string>;
};

export function createContext(headers: Record<string, string> = {}): GraphQLContext {
  return { memo: new Map(), headers };
}

function memo<T>(ctx: GraphQLContext | undefined, key: string, load: () => Promise<T>): Promise<T> {
  if (!ctx?.memo) return load();
  let hit = ctx.memo.get(key) as Promise<T> | undefined;
  if (!hit) {
    hit = load();
    ctx.memo.set(key, hit);
  }
  return hit;
}

// ── Chain reads ─────────────────────────────────────────────────────────────

const persistedQueries = new PersistedQueryCache();

export async function fetchMeter(id: string) {
  try {
    const result = await stellarService.query("get_meter", [
      StellarSdk.nativeToScVal(id, { type: "symbol" }),
    ]);
    const native = StellarSdk.scValToNative(result);
    return native ?? null;
  } catch {
    return null;
  }
}

export async function fetchMeterBalance(id: string): Promise<string> {
  try {
    const result = await stellarService.query("get_meter_balance", [
      StellarSdk.nativeToScVal(id, { type: "symbol" }),
    ]);
    const native = StellarSdk.scValToNative(result);
    return String(native ?? 0);
  } catch {
    return "0";
  }
}

export async function fetchMetersByOwner(address: string) {
  try {
    const result = await stellarService.query("get_meters_by_owner", [
      StellarSdk.nativeToScVal(address, { type: "address" }),
    ]);
    const native = StellarSdk.scValToNative(result);
    return Array.isArray(native) ? native : [];
  } catch {
    return [];
  }
}

/** Fetch recent payment events once and group them by meter id. */
export async function fetchAllPayments(): Promise<Map<string, any[]>> {
  const byMeter = new Map<string, any[]>();
  try {
    const EVT_NS = StellarSdk.xdr.ScVal.scvSymbol("solargrid").toXDR("base64");
    const ACTION = StellarSdk.xdr.ScVal.scvSymbol("payment").toXDR("base64");

    const response = await (server as any).getEvents({
      startLedger: 1,
      filters: [
        {
          type: "contract",
          contractIds: [CONTRACT_ID],
          topics: [[EVT_NS, ACTION]],
        },
      ],
      limit: 1000,
    });

    for (const event of response?.events ?? []) {
      try {
        const topics = (event.topic ?? []).map((t: string) =>
          StellarSdk.xdr.ScVal.fromXDR(t, "base64"),
        );
        if (topics.length < 3) continue;
        const mVal = topics[2];
        const mId =
          mVal.switch().name === "scvSymbol"
            ? mVal.sym().toString()
            : mVal.switch().name === "scvString"
            ? mVal.str().toString()
            : "unknown";
        const dataXdr = event.value ?? event.data;
        const dataVal = StellarSdk.xdr.ScVal.fromXDR(dataXdr, "base64");
        const native = StellarSdk.scValToNative(dataVal);
        const [payer, , amount, plan, memoText] = Array.isArray(native)
          ? native
          : [null, null, 0, "Daily", null];
        const amountXlm = Number(amount ?? 0) / 10_000_000;
        const planStr =
          typeof plan === "object" && plan !== null
            ? Object.keys(plan)[0]
            : String(plan ?? "Daily");
        const list = byMeter.get(mId) ?? [];
        list.push({
          txHash: event.txHash ?? event.id ?? "",
          address: String(payer ?? ""),
          meterId: mId,
          amountXlm,
          plan: planStr,
          status: "Completed",
          confirmedAt: event.ledgerClosedAt ?? new Date().toISOString(),
          date: event.ledgerClosedAt ?? new Date().toISOString(),
          memo: memoText ? String(memoText) : undefined,
        });
        byMeter.set(mId, list);
      } catch {
        // ignore malformed event
      }
    }
  } catch (err: any) {
    logger.warn({ err: err?.message }, "Failed to fetch payment events in GraphQL");
  }
  return byMeter;
}

export async function fetchPaymentsForMeter(meterId: string, ctx?: GraphQLContext): Promise<any[]> {
  const all = await memo(ctx, "payments:all", fetchAllPayments);
  return all.get(meterId) ?? [];
}

const loadMeter = (id: string, ctx?: GraphQLContext) => memo(ctx, `meter:${id}`, () => fetchMeter(id));
const loadBalance = (id: string, ctx?: GraphQLContext) =>
  memo(ctx, `balance:${id}`, () => fetchMeterBalance(id));

// ── Formatting ──────────────────────────────────────────────────────────────

export function formatMeter(id: string, m: any, balance = "0") {
  const meterId = id || String(m.id ?? m.meter_id ?? "");
  return {
    id: meterId,
    owner: String(m.owner ?? ""),
    active: Boolean(m.active),
    unitsUsed: Number(m.units_used ?? m.unitsUsed ?? 0),
    plan:
      typeof m.plan === "object" && m.plan !== null
        ? Object.keys(m.plan)[0]
        : String(m.plan ?? "Daily"),
    lastPayment: String(m.last_payment ?? m.lastPayment ?? ""),
    expiresAt: String(m.expires_at ?? m.expiresAt ?? ""),
    dailyLimit: Number(m.daily_limit ?? m.dailyLimit ?? 0),
    daySpent: Number(m.day_spent ?? m.daySpent ?? 0),
    balance: String(balance),
    payments: (_args: unknown, ctx?: GraphQLContext) => fetchPaymentsForMeter(meterId, ctx),
    usageHistory: ({ page = 1, pageSize = 20 }: { page?: number; pageSize?: number }) =>
      rootValue.usageHistory({ meterId, page, pageSize }),
    health: () => getMeterHealth(meterId) ?? null,
    prediction: () => getPrediction(meterId, Number(balance) || 0),
    devices: () => listDevices({ meterId }).map(formatDevice),
  };
}

export function formatDevice(d: Device) {
  return {
    ...d,
    certifications: () => listCertifications(d.id),
    maintenance: () => listMaintenance(d.id),
    performance: ({ days = 7 }: { days?: number }) => getPerformanceSummary(d.id, clampDays(days, 90)),
    performanceReadings: ({ days = 7 }: { days?: number }) => listPerformance(d.id, clampDays(days, 90)),
    stability: ({ days = 7 }: { days?: number }) => getStabilityReport(d.id, clampDays(days, 90)),
  };
}

const clampDays = (d: number, max: number) => Math.min(max, Math.max(1, Math.trunc(d)));

/** Validate input with the same zod schema as REST; surface field errors in `extensions`. */
function check<T>(schemaDef: z.ZodType<T>, input: unknown): T {
  const parsed = schemaDef.safeParse(input);
  if (!parsed.success) {
    throw new GraphQLError("Validation failed", {
      extensions: { code: "BAD_USER_INPUT", details: z.flattenError(parsed.error).fieldErrors },
    });
  }
  return parsed.data;
}

// ── REST pass-through ───────────────────────────────────────────────────────

const LOOPBACK_BASE = `http://127.0.0.1:${Number(process.env.PORT) || 3000}`;
const FORWARDED_HEADERS = ["authorization", "x-admin-key", "x-api-key", "x-request-id"];

async function restCall(
  ctx: GraphQLContext | undefined,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  if (!/^\/api\/[A-Za-z0-9\-._~/%?=&:,+]*$/.test(path) || path.includes("..") || path.startsWith("/api/graphql")) {
    throw new GraphQLError("path must be an /api/... REST path (GraphQL itself excluded)", {
      extensions: { code: "BAD_USER_INPUT" },
    });
  }
  const headers: Record<string, string> = { accept: "application/json" };
  for (const h of FORWARDED_HEADERS) if (ctx?.headers[h]) headers[h] = ctx.headers[h];
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(LOOPBACK_BASE + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // non-JSON body (e.g. CSV export) returned as a string
  }
  return { status: res.status, body: parsed };
}

// ── Resolvers ───────────────────────────────────────────────────────────────

type Ctx = GraphQLContext | undefined;

export const rootValue = {
  health: () => "ok",

  meter: async ({ id }: { id: string }, ctx?: Ctx) => {
    const meterData = await loadMeter(id, ctx);
    if (!meterData) return null;
    const balance = await loadBalance(id, ctx);
    return formatMeter(id, meterData, balance);
  },
  metersByOwner: async ({ address }: { address: string }, ctx?: Ctx) => {
    const list = await fetchMetersByOwner(address);
    return Promise.all(
      list.map(async (item: any) => {
        const id = typeof item === "string" ? item : String(item.id ?? item.meter_id ?? "");
        const meterData = typeof item === "object" && item !== null ? item : await loadMeter(id, ctx);
        const balance = await loadBalance(id, ctx);
        return formatMeter(id, meterData ?? {}, balance);
      }),
    );
  },
  payments: ({ meterId }: { meterId: string }, ctx?: Ctx) => fetchPaymentsForMeter(meterId, ctx),
  usageHistory: ({
    meterId,
    page = 1,
    pageSize = 20,
  }: {
    meterId: string;
    page?: number;
    pageSize?: number;
  }) => {
    const safePage = Math.max(1, Math.trunc(page));
    const safePageSize = Math.min(100, Math.max(1, Math.trunc(pageSize)));
    const history = getUsageHistory(meterId, safePage, safePageSize);
    return {
      ...history,
      events: history.events.map((event) => ({
        id: event.id,
        meterId: event.meter_id,
        units: event.units,
        cost: event.cost,
        receivedAt: event.received_at,
        transactionHash: event.on_chain_tx_hash,
      })),
    };
  },
  meterHealth: ({ meterId }: { meterId: string }) => getMeterHealth(meterId) ?? null,
  meterHealthDashboard: () => getAllMeterHealth(),
  prediction: async ({ meterId, balance }: { meterId: string; balance?: number | null }, ctx?: Ctx) => {
    if (balance != null) {
      if (!Number.isFinite(balance) || balance < 0) {
        throw new GraphQLError("balance must be a non-negative number", { extensions: { code: "BAD_USER_INPUT" } });
      }
      return getPrediction(meterId, balance);
    }
    const meter: any = await loadMeter(meterId, ctx);
    if (!meter) return null;
    return getPrediction(meterId, Number(meter.balance ?? 0));
  },

  solarForecast: (args: {
    capacityKw: number;
    peakSunHours: number;
    efficiency: number;
    panelAgeYears: number;
    ratePerKwh: number;
  }) => {
    const bad =
      !(args.capacityKw > 0 && args.capacityKw <= 10_000) ||
      !(args.peakSunHours > 0 && args.peakSunHours <= 24) ||
      !(args.efficiency > 0 && args.efficiency <= 1) ||
      !(args.panelAgeYears >= 0) ||
      !(args.ratePerKwh >= 0);
    if (bad) throw new GraphQLError("Invalid solar forecast parameters", { extensions: { code: "BAD_USER_INPUT" } });
    return computeSolarForecast(args);
  },
  irradianceZones: () => IRRADIANCE_ZONES,

  // Devices (#897)
  device: ({ id }: { id: string }) => {
    const d = getDevice(id);
    return d ? formatDevice(d) : null;
  },
  devices: (args: { owner?: string; type?: any; status?: any; meterId?: string; limit?: number; offset?: number }) =>
    listDevices({ ...args, limit: Math.min(100, args.limit ?? 50) }).map(formatDevice),
  dueMaintenance: ({ withinDays = 7 }: { withinDays?: number }) => listDueMaintenance(clampDays(withinDays, 365)),
  expiringCertifications: ({ withinDays = 30 }: { withinDays?: number }) =>
    listExpiringCertifications(clampDays(withinDays, 365)),

  // Weather (#900) — one cached upstream call per location backs every sub-field.
  weather: async ({ lat, lon }: { lat: number; lon: number }) => {
    const report = await getWeather(lat, lon);
    recordObservation(report);
    return {
      location: report.location,
      current: report.current,
      fetchedAt: report.fetchedAt,
      stale: report.stale,
      forecast: ({ days = 7 }: { days?: number }) => report.daily.slice(0, clampDays(days, 8)),
      alerts: () => deriveAlerts(report),
      productionForecast: (a: { capacityKw: number; peakSunHours: number; efficiency: number; panelAgeYears: number }) => {
        if (!(a.capacityKw > 0 && a.peakSunHours > 0 && a.peakSunHours <= 24 && a.efficiency > 0 && a.efficiency <= 1)) {
          throw new GraphQLError("Invalid production forecast parameters", { extensions: { code: "BAD_USER_INPUT" } });
        }
        return forecastProduction(
          report.daily,
          calcDailyKwh(a.capacityKw, a.peakSunHours, a.efficiency, Math.max(0, a.panelAgeYears)),
        );
      },
    };
  },

  // Staking (#899)
  stakingStats: (_a: unknown, ctx?: Ctx) => memo(ctx, "staking:stats", getStakingStats),
  staker: ({ address }: { address: string }) => getStakerInfo(address),
  votingPower: ({ address }: { address: string }) => getVotingPower(address),

  rest: (args: { path: string; method?: string; body?: unknown }, ctx?: Ctx) =>
    // On Query this is GET-only; the Mutation variant supplies `method`.
    restCall(ctx, args.method ?? "GET", args.path, args.method && args.method !== "GET" ? args.body : undefined),

  // ── Mutations ──
  registerDevice: ({ input }: { input: unknown }) => formatDevice(registerDevice(check(registerSchema, input))),
  updateDevice: ({ id, input }: { id: string; input: unknown }) => {
    const d = updateDevice(id, check(updateSchema, input));
    return d ? formatDevice(d) : null;
  },
  deleteDevice: ({ id }: { id: string }) => deleteDevice(id),
  addCertification: ({ deviceId, input }: { deviceId: string; input: unknown }) => {
    if (!getDevice(deviceId)) throw new GraphQLError("Device not found", { extensions: { code: "NOT_FOUND" } });
    return addCertification(deviceId, check(certSchema, input));
  },
  scheduleMaintenance: ({ deviceId, input }: { deviceId: string; input: unknown }) => {
    if (!getDevice(deviceId)) throw new GraphQLError("Device not found", { extensions: { code: "NOT_FOUND" } });
    return scheduleMaintenance(deviceId, check(maintenanceSchema, input));
  },
  completeMaintenance: ({ deviceId, scheduleId, performedAt }: { deviceId: string; scheduleId: string; performedAt?: string }) => {
    if (performedAt && Number.isNaN(Date.parse(performedAt))) {
      throw new GraphQLError("performedAt must be an ISO-8601 date", { extensions: { code: "BAD_USER_INPUT" } });
    }
    return completeMaintenance(deviceId, scheduleId, performedAt ?? undefined) ?? null;
  },
  recordDevicePerformance: ({ deviceId, input }: { deviceId: string; input: unknown }) => {
    if (!getDevice(deviceId)) throw new GraphQLError("Device not found", { extensions: { code: "NOT_FOUND" } });
    recordPerformance(deviceId, check(performanceSchema, input));
    return true;
  },
  recordHeartbeat: ({ meterId, responseTimeMs, error }: { meterId: string; responseTimeMs?: number; error?: boolean }) => {
    recordHeartbeat(meterId, { responseTimeMs: responseTimeMs ?? undefined, error: error === true });
    return getMeterHealth(meterId) ?? null;
  },
};

// ── HTTP handler ────────────────────────────────────────────────────────────

function renderGraphQLPlayground(): string {
  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>SolarGrid GraphQL Playground</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/graphql-playground-react/build/static/css/index.css" />
    <link rel="shortcut icon" href="https://cdn.jsdelivr.net/npm/graphql-playground-react/build/favicon.png" />
    <script src="https://cdn.jsdelivr.net/npm/graphql-playground-react/build/static/js/middleware.js"></script>
  </head>
  <body>
    <div id="root"></div>
    <script>
      window.addEventListener('load', function (event) {
        GraphQLPlayground.init(document.getElementById('root'), {
          endpoint: '/graphql',
          subscriptionEndpoint: '/api/graphql'
        });
      });
    </script>
  </body>
</html>`;
}

export const graphqlRouter = Router();

graphqlRouter.get("/", (req, res) => {
  const isDev = process.env.NODE_ENV !== "production";
  const acceptsHtml = req.accepts("html");
  if (isDev || acceptsHtml) {
    return res.status(200).type("html").send(renderGraphQLPlayground());
  }
  return res.status(405).json({
    error: "GET not supported for GraphQL endpoint in production. Use POST.",
  });
});

graphqlRouter.post("/", async (req, res) => {
  const request = (req.body ?? {}) as GraphQLRequest;
  try {
    const query = persistedQueries.resolve(request);
    const document = parse(query);
    const validationErrors = validate(schema, document, specifiedRules);
    if (validationErrors.length > 0) {
      return res.status(400).json({ errors: validationErrors.map((e) => e.toJSON()) });
    }

    const variables = (request.variables ?? {}) as Record<string, unknown>;
    const cost = analyzeQuery(schema, document, request.operationName, variables);

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers[k] = v;

    const result = await execute({
      schema,
      document,
      rootValue,
      contextValue: createContext(headers),
      variableValues: variables,
      operationName: request.operationName,
    });
    return res.status(200).json({ ...result, extensions: { ...(result as any).extensions, cost } });
  } catch (error) {
    if (error instanceof PersistedQueryError) {
      return res.status(200).json({
        errors: [{ message: error.message, extensions: { code: error.code } }],
      });
    }
    if (error instanceof QueryLimitError) {
      return res.status(400).json({ errors: [{ message: error.message, extensions: { code: error.code } }] });
    }
    const message = error instanceof Error ? error.message : "Invalid GraphQL request";
    return res.status(400).json({ errors: [{ message }] });
  }
});

export function clearPersistedQueriesForTests(): void {
  persistedQueries.clear();
}
