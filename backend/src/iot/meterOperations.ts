import * as StellarSdk from "@stellar/stellar-sdk";
import { contractQuery } from "../lib/stellar.js";
import { logger } from "../lib/logger.js";
import { operationsDb, latestObservation } from "../lib/meterOperationsStore.js";
import { DeviceIdSchema, TelemetrySchema, TransferAckSchema } from "./telemetrySchemas.js";
import { acknowledgeTransfer, runLoadBalancing, type Publisher } from "../lib/loadBalancing.js";
import { acknowledgeSlaProbe, evaluateSla, sendSlaProbes, SlaPongSchema } from "../lib/meterSla.js";
import { getWebhookUrls, fireWebhook } from "../lib/webhookRegistry.js";

/** Use the existing on-chain device registry; no shadow registry that can authorize unknown meters. */
export async function registeredMeter(meterId: string): Promise<{ active: boolean } | null> {
  DeviceIdSchema.parse(meterId);
  const result = await contractQuery("get_meter", [StellarSdk.nativeToScVal(meterId, { type: "string" })]);
  const meter = StellarSdk.scValToNative(result) as { active?: unknown } | null;
  return meter && typeof meter.active === "boolean" ? { active: meter.active } : null;
}

export async function processOperationalMessage(topic: string, payload: Buffer, retained = false) {
  if (retained) return; // A replayed retained heartbeat/ack is not live evidence.
  const match = /^solargrid\/meters\/([A-Za-z0-9_-]{1,64})\/(telemetry|ack)$/.exec(topic);
  if (!match) return;
  const [, meterId, kind] = match;
  const input: unknown = JSON.parse(payload.toString());
  if (kind === "ack") {
    if (SlaPongSchema.safeParse(input).success) acknowledgeSlaProbe(meterId, input);
    else if (TransferAckSchema.safeParse(input).success) acknowledgeTransfer(meterId, input);
    return;
  }
  const telemetry = TelemetrySchema.parse(input);
  const meter = await registeredMeter(meterId);
  if (!meter) return;
  // Sequence must increase across device reboots; out-of-order/QoS replays cannot refresh freshness.
  const latest = latestObservation(meterId);
  if (latest && telemetry.sequence <= latest.sequence) return;
  operationsDb().prepare("INSERT OR IGNORE INTO meter_observations(meter_id,sequence,received_at,load_watts,available,active) VALUES(?,?,?,?,?,?)")
    .run(meterId, telemetry.sequence, Date.now(), telemetry.loadWatts, Number(telemetry.available), Number(meter.active));
}

let timer: NodeJS.Timeout | undefined;
let inFlight = false;
export function startMeterOperations(publish: Publisher) {
  if (timer) return;
  operationsDb();
  const tick = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      // Refresh active state immediately before automated decisions. Registry failure fails closed.
      const { loadRules } = await import("../lib/loadBalancing.js");
      const ids = new Set(loadRules().filter(r => r.enabled).flatMap(r => [r.controllerId, ...r.members.map(m => m.meterId)]));
      const blocked = new Set<string>();
      for (const meterId of ids) {
        let active = false;
        try { active = Boolean((await registeredMeter(meterId))?.active); } catch { /* fail closed */ }
        if (!active) blocked.add(meterId);
      }
      await runLoadBalancing(publish, undefined, blocked);
      for (const alert of evaluateSla()) {
        logger.warn(alert, "Meter SLA state transition");
        // Reuse registered webhooks and their delivery logs, timeout, retry, circuit breaker.
        for (const url of getWebhookUrls()) void fireWebhook(url, JSON.stringify(alert)).catch(err => logger.error({ err }, "SLA webhook error"));
      }
      await sendSlaProbes(publish);
    } catch (err) { logger.error({ err }, "Meter operations cycle failed"); }
    finally { inFlight = false; }
  };
  timer = setInterval(() => { void tick(); }, 10_000);
  timer.unref();
}
export function stopMeterOperations() { if (timer) clearInterval(timer); timer = undefined; }
