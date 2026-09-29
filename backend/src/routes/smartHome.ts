/**
 * Smart home integration endpoints (#904). See docs/SMART_HOME.md.
 *
 * Owner auth (wallet signature → session):
 *   POST   /api/smart-home/auth/challenge     { address }                → challenge tx to sign
 *   POST   /api/smart-home/auth/session       { address, transaction }   → { token }
 *
 * OAuth 2.0 account linking (Google Home / Alexa):
 *   GET    /api/smart-home/oauth/authorize    → redirects to the web app consent page
 *   POST   /api/smart-home/oauth/consent      (session) { clientId, redirectUri, state, meters, scopes } → { redirectUrl }
 *   POST   /api/smart-home/oauth/token        authorization_code / refresh_token grants
 *
 * Platform fulfillment:
 *   POST   /api/smart-home/google/fulfillment (Bearer access token)
 *   POST   /api/smart-home/alexa/directive    (X-Smart-Home-Proxy-Secret, from the Lambda proxy)
 *   POST   /api/smart-home/alexa/custom       (X-Smart-Home-Proxy-Secret, from the Lambda proxy)
 *
 * Owner self-service (session):
 *   GET    /api/smart-home/links              DELETE /api/smart-home/links/:id
 *   GET    /api/smart-home/routines           POST   /api/smart-home/routines
 *   PATCH  /api/smart-home/routines/:id       DELETE /api/smart-home/routines/:id
 *   POST   /api/smart-home/routines/:id/run
 *   GET    /api/smart-home/activity           DELETE /api/smart-home/data
 */
import crypto from "node:crypto";
import express, { Router, type NextFunction, type Request, type Response } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { createChallenge, createSession, sessionAddress, verifyChallenge } from "../lib/walletAuth.js";
import { ownsMeter } from "../lib/meterOwnership.js";
import {
  SCOPES,
  authenticateClient,
  createRoutine,
  deleteLink,
  deleteRoutine,
  eraseOwnerData,
  exchangeAuthCode,
  findClient,
  getRoutine,
  issueAuthCode,
  linkFromAccessToken,
  listActivity,
  listLinks,
  listRoutines,
  refreshAccessToken,
  runRoutine,
  updateRoutine,
  validateRoutineInput,
  type LinkedMeter,
  type Scope,
} from "../lib/smartHome.js";
import { handleAlexaCustom, handleAlexaDirective, handleGoogleFulfillment } from "../lib/smartHomePlatforms.js";

export const smartHomeRouter = Router();

const STELLAR_ADDRESS_RE = /^G[A-Z2-7]{55}$/;
const APP_URL = () => (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");

type OwnerRequest = Request & { ownerAddress?: string };

function bearer(req: Request): string | undefined {
  const h = req.headers.authorization;
  return h?.startsWith("Bearer ") ? h.slice(7) : undefined;
}

function requireSession(req: OwnerRequest, res: Response, next: NextFunction) {
  const address = sessionAddress(bearer(req));
  if (!address) return res.status(401).json({ error: "Wallet session required", code: "UNAUTHORIZED" });
  req.ownerAddress = address;
  next();
}

function requireProxySecret(req: Request, res: Response, next: NextFunction) {
  const expected = process.env.SMART_HOME_ALEXA_PROXY_SECRET;
  const given = req.header("X-Smart-Home-Proxy-Secret") ?? "";
  if (!expected) return res.status(503).json({ error: "Alexa integration not configured" });
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  if (!crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: "Unauthorized" });
  next();
}

// ── Wallet auth ──────────────────────────────────────────────────────────────

smartHomeRouter.post("/auth/challenge", (req, res) => {
  const address = req.body?.address;
  if (typeof address !== "string" || !STELLAR_ADDRESS_RE.test(address)) {
    return res.status(400).json({ error: "address must be a valid Stellar public key" });
  }
  res.json(createChallenge(address));
});

smartHomeRouter.post("/auth/session", (req, res) => {
  const { address, transaction } = req.body ?? {};
  if (typeof address !== "string" || typeof transaction !== "string" || !verifyChallenge(address, transaction)) {
    return res.status(401).json({ error: "Invalid or expired signature", code: "UNAUTHORIZED" });
  }
  res.json(createSession(address));
});

// ── OAuth account linking ────────────────────────────────────────────────────

smartHomeRouter.get("/oauth/authorize", (req, res) => {
  const { client_id, redirect_uri, state, response_type } = req.query as Record<string, string | undefined>;
  const client = findClient(client_id);
  if (!client) return res.status(400).json({ error: "unknown client_id" });
  if (!redirect_uri || !client.redirectUris.includes(redirect_uri)) {
    return res.status(400).json({ error: "redirect_uri is not registered for this client" });
  }
  if (response_type && response_type !== "code") {
    const url = new URL(redirect_uri);
    url.searchParams.set("error", "unsupported_response_type");
    if (state) url.searchParams.set("state", state);
    return res.redirect(url.toString());
  }
  const params = new URLSearchParams({ client_id: client.clientId, redirect_uri, platform: client.platform });
  if (state) params.set("state", state);
  res.redirect(`${APP_URL()}/smart-home/link?${params.toString()}`);
});

smartHomeRouter.post(
  "/oauth/consent",
  requireSession,
  asyncHandler(async (req: OwnerRequest, res) => {
    const { clientId, redirectUri, state, meters, scopes } = req.body ?? {};
    const client = findClient(clientId);
    if (!client || typeof redirectUri !== "string" || !client.redirectUris.includes(redirectUri)) {
      return res.status(400).json({ error: "invalid client or redirect URI" });
    }
    if (!Array.isArray(meters) || !meters.length || meters.length > 50) {
      return res.status(400).json({ error: "select between 1 and 50 meters" });
    }
    const selected: LinkedMeter[] = [];
    for (const m of meters) {
      if (!m || typeof m.meterId !== "string" || !m.meterId) return res.status(400).json({ error: "each meter needs a meterId" });
      selected.push({ meterId: m.meterId, nickname: typeof m.nickname === "string" && m.nickname.trim() ? m.nickname.trim().slice(0, 40) : null });
    }
    const granted: Scope[] = Array.isArray(scopes) && scopes.length ? scopes : ["read", "control"];
    if (!granted.every((s) => SCOPES.includes(s)) || !granted.includes("read")) {
      return res.status(400).json({ error: "scopes must include read and may include control" });
    }

    try {
      for (const m of selected) {
        if (!(await ownsMeter(m.meterId, req.ownerAddress!))) {
          return res.status(403).json({ error: `You are not the owner of meter ${m.meterId}` });
        }
      }
    } catch {
      return res.status(502).json({ error: "Could not verify meter ownership", code: "CONTRACT_ERROR" });
    }

    const code = issueAuthCode({ clientId: client.clientId, redirectUri, ownerAddress: req.ownerAddress!, meters: selected, scopes: [...new Set(granted)] });
    const url = new URL(redirectUri);
    url.searchParams.set("code", code);
    if (typeof state === "string") url.searchParams.set("state", state);
    res.json({ redirectUrl: url.toString() });
  }),
);

smartHomeRouter.post("/oauth/token", express.urlencoded({ extended: false }), (req, res) => {
  let clientId = req.body?.client_id as string | undefined;
  let clientSecret = req.body?.client_secret as string | undefined;
  const basic = req.headers.authorization?.startsWith("Basic ") ? req.headers.authorization.slice(6) : undefined;
  if (basic) {
    const [id, secret] = Buffer.from(basic, "base64").toString("utf8").split(":");
    clientId = decodeURIComponent(id ?? "");
    clientSecret = decodeURIComponent(secret ?? "");
  }
  const client = authenticateClient(clientId, clientSecret);
  if (!client) return res.status(401).json({ error: "invalid_client" });

  res.setHeader("Cache-Control", "no-store");
  const grant = req.body?.grant_type;
  if (grant === "authorization_code") {
    const tokens = exchangeAuthCode(client, String(req.body.code ?? ""), req.body.redirect_uri);
    return tokens ? res.json(tokens) : res.status(400).json({ error: "invalid_grant" });
  }
  if (grant === "refresh_token") {
    const tokens = refreshAccessToken(client, String(req.body.refresh_token ?? ""));
    return tokens ? res.json(tokens) : res.status(400).json({ error: "invalid_grant" });
  }
  res.status(400).json({ error: "unsupported_grant_type" });
});

// ── Platform fulfillment ─────────────────────────────────────────────────────

smartHomeRouter.post(
  "/google/fulfillment",
  asyncHandler(async (req, res) => {
    const link = linkFromAccessToken(bearer(req));
    if (!link || link.platform !== "google") return res.status(401).json({ error: "invalid_token" });
    res.json(await handleGoogleFulfillment(link, req.body));
  }),
);

smartHomeRouter.post(
  "/alexa/directive",
  requireProxySecret,
  asyncHandler(async (req, res) => {
    res.json(await handleAlexaDirective(req.body));
  }),
);

smartHomeRouter.post(
  "/alexa/custom",
  requireProxySecret,
  asyncHandler(async (req, res) => {
    res.json(await handleAlexaCustom(req.body));
  }),
);

// ── Owner self-service ───────────────────────────────────────────────────────

smartHomeRouter.get("/links", requireSession, (req: OwnerRequest, res) => {
  res.json({ links: listLinks(req.ownerAddress!) });
});

smartHomeRouter.delete("/links/:id", requireSession, (req: OwnerRequest, res) => {
  if (!deleteLink(req.params.id, req.ownerAddress)) return res.status(404).json({ error: "Link not found" });
  res.status(204).end();
});

smartHomeRouter.get("/routines", requireSession, (req: OwnerRequest, res) => {
  res.json({ routines: listRoutines(req.ownerAddress!) });
});

async function checkRoutineMeters(owner: string, meterIds: string[]): Promise<string | null> {
  for (const id of new Set(meterIds)) {
    if (!(await ownsMeter(id, owner))) return `You are not the owner of meter ${id}`;
  }
  return null;
}

function routineMeterIds(input: { trigger: { type: string; meterId?: string }; actions: { meterId: string }[] }): string[] {
  return [...input.actions.map((a) => a.meterId), ...(input.trigger.type === "balance_below" ? [input.trigger.meterId!] : [])];
}

smartHomeRouter.post(
  "/routines",
  requireSession,
  asyncHandler(async (req: OwnerRequest, res) => {
    const input = validateRoutineInput(req.body);
    if (typeof input === "string") return res.status(400).json({ error: input });
    if (listRoutines(req.ownerAddress!).length >= 50) return res.status(409).json({ error: "Routine limit (50) reached" });
    const ownershipError = await checkRoutineMeters(req.ownerAddress!, routineMeterIds(input));
    if (ownershipError) return res.status(403).json({ error: ownershipError });
    res.status(201).json(createRoutine(req.ownerAddress!, input));
  }),
);

smartHomeRouter.patch(
  "/routines/:id",
  requireSession,
  asyncHandler(async (req: OwnerRequest, res) => {
    const existing = getRoutine(req.params.id);
    if (!existing || existing.owner_address !== req.ownerAddress) return res.status(404).json({ error: "Routine not found" });
    const body = req.body ?? {};
    const merged = validateRoutineInput({
      name: body.name ?? existing.name,
      trigger: body.trigger ?? existing.trigger,
      actions: body.actions ?? existing.actions,
    });
    if (typeof merged === "string") return res.status(400).json({ error: merged });
    if (body.enabled !== undefined && typeof body.enabled !== "boolean") return res.status(400).json({ error: "enabled must be boolean" });
    if (body.trigger || body.actions) {
      const ownershipError = await checkRoutineMeters(req.ownerAddress!, routineMeterIds(merged));
      if (ownershipError) return res.status(403).json({ error: ownershipError });
    }
    res.json(updateRoutine(existing.id, { ...merged, enabled: body.enabled }));
  }),
);

smartHomeRouter.delete("/routines/:id", requireSession, (req: OwnerRequest, res) => {
  const existing = getRoutine(req.params.id);
  if (!existing || existing.owner_address !== req.ownerAddress) return res.status(404).json({ error: "Routine not found" });
  deleteRoutine(existing.id);
  res.status(204).end();
});

smartHomeRouter.post(
  "/routines/:id/run",
  requireSession,
  asyncHandler(async (req: OwnerRequest, res) => {
    const existing = getRoutine(req.params.id);
    if (!existing || existing.owner_address !== req.ownerAddress) return res.status(404).json({ error: "Routine not found" });
    res.json({ results: await runRoutine(existing, "app") });
  }),
);

smartHomeRouter.get("/activity", requireSession, (req: OwnerRequest, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit ?? 100) || 100, 1), 500);
  res.json({ activity: listActivity(req.ownerAddress!, limit) });
});

smartHomeRouter.delete("/data", requireSession, (req: OwnerRequest, res) => {
  res.json({ deleted: eraseOwnerData(req.ownerAddress!) });
});
