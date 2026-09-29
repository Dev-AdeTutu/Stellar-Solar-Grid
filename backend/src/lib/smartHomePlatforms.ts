/**
 * Google Home and Alexa protocol adapters (#904).
 *
 * Linked meters appear as smart plugs with an on/off switch; enabled energy
 * routines appear as scenes ("Hey Google, activate Night Saver" / "Alexa,
 * turn on Night Saver"). The Alexa custom skill adds spoken balance and
 * usage queries ("Alexa, ask Solar Grid what's my balance").
 */
import crypto from "node:crypto";
import {
  deleteLink,
  executeCommand,
  getMeterState,
  getRoutine,
  linkFromAccessToken,
  logActivity,
  runRoutine,
  voiceRoutines,
  type LinkedMeter,
  type MeterState,
  type SmartHomeLink,
} from "./smartHome.js";
import { getUsageTotals, STROOPS_PER_XLM } from "./billing.js";

const xlm = (stroops: number) => {
  const v = stroops / STROOPS_PER_XLM;
  return `${v.toFixed(v >= 100 ? 0 : 2).replace(/\.00$/, "")} X L M`;
};

/** Stable, non-reversible per-owner id so platforms never see a wallet address. */
function agentUserId(link: SmartHomeLink): string {
  return crypto.createHash("sha256").update(`solargrid:${link.owner_address}`).digest("hex").slice(0, 32);
}

const meterName = (m: LinkedMeter) => m.nickname ?? `Solar meter ${m.meterId}`;
const canControl = (link: SmartHomeLink) => link.scopes.includes("control");

function findMeter(link: SmartHomeLink, meterId: string): LinkedMeter | undefined {
  return link.meters.find((m) => m.meterId === meterId);
}

/** Routines are only exposed when every meter they touch is part of this link. */
function linkRoutines(link: SmartHomeLink) {
  if (!canControl(link)) return [];
  const allowed = new Set(link.meters.map((m) => m.meterId));
  return voiceRoutines(link.owner_address).filter((r) => r.actions.every((a) => allowed.has(a.meterId)));
}

// ── Google Home (Smart Home fulfillment) ────────────────────────────────────

type GoogleRequest = {
  requestId: string;
  inputs: { intent: string; payload?: any }[];
};

const G_METER = "meter:";
const G_ROUTINE = "routine:";

export async function handleGoogleFulfillment(link: SmartHomeLink, body: GoogleRequest): Promise<unknown> {
  const input = body.inputs?.[0];
  const requestId = body.requestId;
  switch (input?.intent) {
    case "action.devices.SYNC": {
      logActivity(link.owner_address, "google", "sync", null, "ok");
      const meters = link.meters.map((m) => ({
        id: `${G_METER}${m.meterId}`,
        type: "action.devices.types.OUTLET",
        traits: ["action.devices.traits.OnOff"],
        name: { name: meterName(m), defaultNames: ["SolarGrid meter"], nicknames: [meterName(m)] },
        willReportState: false,
        attributes: canControl(link) ? {} : { queryOnlyOnOff: true },
        deviceInfo: { manufacturer: "SolarGrid", model: "Prepaid solar meter" },
      }));
      const scenes = linkRoutines(link).map((r) => ({
        id: `${G_ROUTINE}${r.id}`,
        type: "action.devices.types.SCENE",
        traits: ["action.devices.traits.Scene"],
        name: { name: r.name },
        willReportState: false,
        attributes: { sceneReversible: false },
      }));
      return { requestId, payload: { agentUserId: agentUserId(link), devices: [...meters, ...scenes] } };
    }

    case "action.devices.QUERY": {
      const ids: string[] = (input.payload?.devices ?? []).map((d: { id: string }) => d.id);
      const entries = await Promise.all(
        ids.map(async (id): Promise<[string, unknown]> => {
          if (id.startsWith(G_ROUTINE)) return [id, { online: true, status: "SUCCESS" }];
          const meterId = id.slice(G_METER.length);
          if (!findMeter(link, meterId)) return [id, { status: "ERROR", errorCode: "deviceNotFound" }];
          const s = await getMeterState(meterId);
          return [id, s.online ? { online: true, on: s.on, status: "SUCCESS" } : { online: false, status: "OFFLINE", errorCode: "deviceOffline" }];
        }),
      );
      logActivity(link.owner_address, "google", "query", null, "ok");
      return { requestId, payload: { devices: Object.fromEntries(entries) } };
    }

    case "action.devices.EXECUTE": {
      const results: unknown[] = [];
      for (const cmd of input.payload?.commands ?? []) {
        for (const device of cmd.devices ?? []) {
          for (const exec of cmd.execution ?? []) {
            results.push(await googleExecute(link, device.id, exec));
          }
        }
      }
      return { requestId, payload: { commands: results } };
    }

    case "action.devices.DISCONNECT":
      deleteLink(link.id);
      return {};

    default:
      return { requestId, payload: { errorCode: "notSupported" } };
  }
}

async function googleExecute(link: SmartHomeLink, id: string, exec: { command: string; params?: any }) {
  if (!canControl(link)) return { ids: [id], status: "ERROR", errorCode: "authFailure" };

  if (exec.command === "action.devices.commands.ActivateScene" && id.startsWith(G_ROUTINE)) {
    const routine = linkRoutines(link).find((r) => r.id === id.slice(G_ROUTINE.length));
    if (!routine) return { ids: [id], status: "ERROR", errorCode: "deviceNotFound" };
    const results = await runRoutine(routine, "google");
    return results.every((r) => r.ok)
      ? { ids: [id], status: "SUCCESS", states: { online: true } }
      : { ids: [id], status: "ERROR", errorCode: "actionNotAvailable" };
  }

  if (exec.command === "action.devices.commands.OnOff" && id.startsWith(G_METER)) {
    const meterId = id.slice(G_METER.length);
    if (!findMeter(link, meterId)) return { ids: [id], status: "ERROR", errorCode: "deviceNotFound" };
    const r = await executeCommand(link.owner_address, meterId, exec.params?.on ? "on" : "off", "google");
    if (r.ok) return { ids: [id], status: "SUCCESS", states: { online: true, on: r.state.on } };
    // No credit: the meter cannot be switched on until it is topped up.
    return { ids: [id], status: r.error === "offline" ? "OFFLINE" : "ERROR", errorCode: r.error === "offline" ? "deviceOffline" : "actionNotAvailable" };
  }

  return { ids: [id], status: "ERROR", errorCode: "functionNotSupported" };
}

// ── Alexa Smart Home (payload v3) ────────────────────────────────────────────

type AlexaDirective = {
  directive: {
    header: { namespace: string; name: string; messageId: string; correlationToken?: string; payloadVersion: string };
    endpoint?: { endpointId: string; scope?: { token?: string } };
    payload?: { scope?: { token?: string }; grantee?: { token?: string } };
  };
};

// Alexa endpoint ids allow a limited charset, so meter/routine ids are base64url-encoded.
const enc = (v: string) => Buffer.from(v, "utf8").toString("base64url");
const dec = (v: string) => Buffer.from(v, "base64url").toString("utf8");
const A_METER = "meter-";
const A_ROUTINE = "routine-";

function alexaHeader(namespace: string, name: string, correlationToken?: string) {
  return { namespace, name, payloadVersion: "3", messageId: crypto.randomUUID(), ...(correlationToken ? { correlationToken } : {}) };
}

function alexaError(d: AlexaDirective["directive"], type: string, message: string, extra: Record<string, unknown> = {}) {
  return {
    event: {
      header: alexaHeader("Alexa", "ErrorResponse", d.header.correlationToken),
      ...(d.endpoint ? { endpoint: { endpointId: d.endpoint.endpointId } } : {}),
      payload: { type, message, ...extra },
    },
  };
}

function alexaProperties(state: MeterState) {
  const timeOfSample = new Date().toISOString();
  return [
    { namespace: "Alexa.PowerController", name: "powerState", value: state.on ? "ON" : "OFF", timeOfSample, uncertaintyInMilliseconds: 500 },
    { namespace: "Alexa.EndpointHealth", name: "connectivity", value: { value: state.online ? "OK" : "UNREACHABLE" }, timeOfSample, uncertaintyInMilliseconds: 0 },
  ];
}

export function alexaToken(body: AlexaDirective): string | undefined {
  const d = body.directive;
  return d?.endpoint?.scope?.token ?? d?.payload?.scope?.token ?? d?.payload?.grantee?.token;
}

export async function handleAlexaDirective(body: AlexaDirective): Promise<unknown> {
  const d = body.directive;
  if (!d?.header) return { error: "invalid directive" };

  // AcceptGrant arrives right after linking; we don't send proactive events, so just acknowledge.
  if (d.header.namespace === "Alexa.Authorization" && d.header.name === "AcceptGrant") {
    return { event: { header: alexaHeader("Alexa.Authorization", "AcceptGrant.Response"), payload: {} } };
  }

  const link = linkFromAccessToken(alexaToken(body));
  if (!link) return alexaError(d, "INVALID_AUTHORIZATION_CREDENTIAL", "Account link is invalid or expired");

  if (d.header.namespace === "Alexa.Discovery" && d.header.name === "Discover") {
    logActivity(link.owner_address, "alexa", "sync", null, "ok");
    const meters = link.meters.map((m) => ({
      endpointId: `${A_METER}${enc(m.meterId)}`,
      manufacturerName: "SolarGrid",
      description: "Prepaid solar meter",
      friendlyName: meterName(m),
      displayCategories: ["SMARTPLUG"],
      capabilities: [
        { type: "AlexaInterface", interface: "Alexa", version: "3" },
        {
          type: "AlexaInterface",
          interface: "Alexa.PowerController",
          version: "3",
          properties: { supported: [{ name: "powerState" }], retrievable: true, proactivelyReported: false, nonControllable: !canControl(link) },
        },
        {
          type: "AlexaInterface",
          interface: "Alexa.EndpointHealth",
          version: "3",
          properties: { supported: [{ name: "connectivity" }], retrievable: true, proactivelyReported: false },
        },
      ],
    }));
    const scenes = linkRoutines(link).map((r) => ({
      endpointId: `${A_ROUTINE}${enc(r.id)}`,
      manufacturerName: "SolarGrid",
      description: "SolarGrid energy routine",
      friendlyName: r.name,
      displayCategories: ["SCENE_TRIGGER"],
      capabilities: [
        { type: "AlexaInterface", interface: "Alexa", version: "3" },
        { type: "AlexaInterface", interface: "Alexa.SceneController", version: "3", supportsDeactivation: false },
      ],
    }));
    return { event: { header: alexaHeader("Alexa.Discovery", "Discover.Response"), payload: { endpoints: [...meters, ...scenes] } } };
  }

  const endpointId = d.endpoint?.endpointId ?? "";

  if (d.header.namespace === "Alexa.SceneController" && d.header.name === "Activate") {
    if (!endpointId.startsWith(A_ROUTINE)) return alexaError(d, "NO_SUCH_ENDPOINT", "Unknown scene");
    const routine = linkRoutines(link).find((r) => r.id === dec(endpointId.slice(A_ROUTINE.length)));
    if (!routine) return alexaError(d, "NO_SUCH_ENDPOINT", "Unknown scene");
    const results = await runRoutine(routine, "alexa");
    if (!results.every((r) => r.ok)) return alexaError(d, "ENDPOINT_UNREACHABLE", "Some meters could not be switched");
    return {
      event: {
        header: alexaHeader("Alexa.SceneController", "ActivationStarted", d.header.correlationToken),
        endpoint: { endpointId },
        payload: { cause: { type: "VOICE_INTERACTION" }, timestamp: new Date().toISOString() },
      },
      context: {},
    };
  }

  if (!endpointId.startsWith(A_METER)) return alexaError(d, "NO_SUCH_ENDPOINT", "Unknown device");
  const meterId = dec(endpointId.slice(A_METER.length));
  if (!findMeter(link, meterId)) return alexaError(d, "NO_SUCH_ENDPOINT", "Unknown device");

  if (d.header.namespace === "Alexa" && d.header.name === "ReportState") {
    const state = await getMeterState(meterId);
    return {
      event: { header: alexaHeader("Alexa", "StateReport", d.header.correlationToken), endpoint: { endpointId }, payload: {} },
      context: { properties: alexaProperties(state) },
    };
  }

  if (d.header.namespace === "Alexa.PowerController" && (d.header.name === "TurnOn" || d.header.name === "TurnOff")) {
    if (!canControl(link)) return alexaError(d, "INSUFFICIENT_PERMISSIONS", "This link is read-only");
    const r = await executeCommand(link.owner_address, meterId, d.header.name === "TurnOn" ? "on" : "off", "alexa");
    if (!r.ok) {
      return r.error === "noCredit"
        ? alexaError(d, "NOT_SUPPORTED_IN_CURRENT_MODE", "Meter has no credit; top up to turn it on", { currentDeviceMode: "OTHER" })
        : alexaError(d, "ENDPOINT_UNREACHABLE", "Meter is offline");
    }
    return {
      event: { header: alexaHeader("Alexa", "Response", d.header.correlationToken), endpoint: { endpointId }, payload: {} },
      context: { properties: alexaProperties(r.state) },
    };
  }

  return alexaError(d, "INVALID_DIRECTIVE", `${d.header.namespace}.${d.header.name} is not supported`);
}

// ── Alexa custom skill (spoken queries) ──────────────────────────────────────

type AlexaCustomRequest = {
  context?: { System?: { user?: { accessToken?: string } } };
  request: { type: string; intent?: { name: string; slots?: Record<string, { value?: string }> } };
};

function speak(text: string, endSession = true, extra: Record<string, unknown> = {}) {
  return { version: "1.0", response: { outputSpeech: { type: "PlainText", text }, shouldEndSession: endSession, ...extra } };
}

/** Match a spoken meter/routine name loosely against nickname or id. */
function matchByName<T>(items: T[], spoken: string | undefined, names: (t: T) => string[]): T | undefined {
  if (!spoken) return items.length === 1 ? items[0] : undefined;
  const norm = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, "");
  const s = norm(spoken);
  return items.find((i) => names(i).some((n) => norm(n) === s)) ?? items.find((i) => names(i).some((n) => norm(n).includes(s)));
}

export async function handleAlexaCustom(body: AlexaCustomRequest): Promise<unknown> {
  const req = body.request;
  const token = body.context?.System?.user?.accessToken;

  if (req.type === "AlexaSkillEvent.SkillDisabled" || req.type === "AlexaSkillEvent.SkillAccountLinkRemoved") {
    const link = linkFromAccessToken(token);
    if (link) deleteLink(link.id);
    return {};
  }
  if (req.type === "SessionEndedRequest") return { version: "1.0", response: {} };

  const link = linkFromAccessToken(token);
  if (!link) {
    return speak("Please link your Solar Grid account in the Alexa app to use this skill.", true, { card: { type: "LinkAccount" } });
  }

  if (req.type === "LaunchRequest") {
    return speak("Welcome to Solar Grid. You can ask for your balance, today's usage, or to run a routine.", false);
  }

  const intent = req.intent?.name;
  const slot = (name: string) => req.intent?.slots?.[name]?.value;
  const meterNames = (m: LinkedMeter) => [m.nickname ?? "", m.meterId];

  switch (intent) {
    case "GetBalanceIntent": {
      const meter = matchByName(link.meters, slot("meter"), meterNames);
      if (!meter) return speak(`Which meter? You have ${link.meters.map(meterName).join(", ")}.`, false);
      const s = await getMeterState(meter.meterId);
      logActivity(link.owner_address, "alexa", "get_balance", meter.meterId, s.online ? "ok" : "offline");
      if (!s.online) return speak(`I couldn't reach ${meterName(meter)} right now. Please try again shortly.`);
      return speak(`${meterName(meter)} has ${xlm(s.balance)} of credit and is ${s.on ? "on" : "off"}.`);
    }
    case "GetUsageIntent": {
      const meter = matchByName(link.meters, slot("meter"), meterNames);
      if (!meter) return speak(`Which meter? You have ${link.meters.map(meterName).join(", ")}.`, false);
      const now = new Date();
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      const { units } = getUsageTotals(meter.meterId, start, now);
      logActivity(link.owner_address, "alexa", "get_usage", meter.meterId, "ok");
      return speak(`${meterName(meter)} has used ${units} units so far today.`);
    }
    case "RunRoutineIntent": {
      if (!canControl(link)) return speak("Your linked account only allows reading meter status.");
      const routines = linkRoutines(link);
      const routine = matchByName(routines, slot("routine"), (r) => [r.name]);
      if (!routine) {
        return speak(routines.length ? `Which routine? You have ${routines.map((r) => r.name).join(", ")}.` : "You don't have any routines yet. Create one in the Solar Grid app.", !routines.length);
      }
      const fresh = getRoutine(routine.id)!;
      const results = await runRoutine(fresh, "alexa");
      const failed = results.filter((r) => !r.ok).length;
      return speak(failed ? `I ran ${routine.name}, but ${failed} meter${failed > 1 ? "s" : ""} couldn't be switched.` : `Done. ${routine.name} is running.`);
    }
    case "AMAZON.HelpIntent":
      return speak("Try saying: what's my balance, how much energy have I used today, or run Night Saver.", false);
    case "AMAZON.StopIntent":
    case "AMAZON.CancelIntent":
      return speak("Goodbye.");
    default:
      return speak("Sorry, I didn't catch that. You can ask for your balance or usage, or run a routine.", false);
  }
}
