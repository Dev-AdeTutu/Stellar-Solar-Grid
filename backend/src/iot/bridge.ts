/**
 * IoT Bridge — two responsibilities:
 *
 * Readings are buffered per flush interval and submitted as a single
 * batch_update_usage call to minimise transaction overhead.
 *
 * Expected MQTT topic:  solargrid/meters/{meter_id}/usage
 * Expected payload:     { "units": 100, "cost": 500000 }
 */

import mqtt from "mqtt";
import * as crypto from "crypto";
import { logger } from "../lib/logger.js";
import { persistAndSubmitUsageEvent, insertSubmittedUsageEvents, getKV, setKV } from "../lib/usageEvents.js";
import { getWebhookUrls, fireWebhook } from "../lib/webhookRegistry.js";
import { UsageUpdateSchema, MqttPayloadSchema } from "../lib/validation.js";
import {
  adminInvoke,
  contractQuery,
  server,
  CONTRACT_ID,
} from "../lib/stellar.js";
import * as StellarSdk from "@stellar/stellar-sdk";
import { mqttMessages, activeMeters, paymentVolume, mqttReconnectExhausted } from "../lib/metrics.js";

const BROKER = process.env.MQTT_BROKER ?? "mqtt://localhost:1883";
const TOPIC = "solargrid/meters/+/usage";
const MAX_REPLAY_LEDGERS = Number(process.env.MAX_REPLAY_LEDGERS ?? 1000);

let mqttClient: mqtt.MqttClient | null = null;
export function getMqttClient() { return mqttClient; }
const FLUSH_INTERVAL_MS = Number(process.env.BRIDGE_FLUSH_INTERVAL_MS ?? process.env.BATCH_FLUSH_MS ?? 5_000);
const EVENT_POLL_INTERVAL_MS = Number(
  process.env.EVENT_POLL_INTERVAL_MS ?? 5_000,
);

// Bridge initialization guards to prevent duplicate startup
let bridgeStarted = false;

const LOW_BALANCE_THRESHOLD = parseInt(
  process.env.LOW_BALANCE_THRESHOLD ?? "1000000",
); // 0.1 XLM in stroops

interface Reading {
  meterId: string;
  units: number;
  cost: number;
  /** balance/daily_limit ratio at receive time; lower = more urgent (Issue #601). */
  priority: number;
}

/**
 * Priority score for batch ordering: the meter's current balance/daily_limit
 * ratio. Meters near a zero balance relative to their daily budget get a
 * lower (more urgent) score and are processed first in the next batch.
 *
 * Meters with no daily limit configured (0 = unlimited) or that fail to
 * resolve have no meaningful ratio to prioritise on, so they sort last
 * rather than being assumed urgent.
 */
async function getPriority(meterId: string): Promise<number> {
  try {
    const result = await contractQuery("get_meter", [
      StellarSdk.nativeToScVal(meterId, { type: "symbol" }),
    ]);
    const meter = StellarSdk.scValToNative(result) as {
      balance: bigint;
      daily_limit: bigint;
      [key: string]: unknown;
    };
    const dailyLimit = Number(meter.daily_limit);
    if (dailyLimit <= 0) return Number.POSITIVE_INFINITY;
    return Number(meter.balance) / dailyLimit;
  } catch (err) {
    logger.warn("Failed to compute batch priority for meter, deprioritising", {
      meterId,
      err,
    });
    return Number.POSITIVE_INFINITY;
  }
}

/** Fire webhook notification when meter balance drops below threshold */
async function checkAndNotifyLowBalance(meterId: string) {
  // Read fresh each call — /api/webhooks/low-balance may register a URL
  // after this module was first loaded.
  const webhookUrl = process.env.PROVIDER_WEBHOOK_URL ?? WEBHOOK_URL;
  if (!webhookUrl) return;
  const urls = getWebhookUrls();
  if (urls.size === 0) return;

  try {
    const result = await contractQuery("get_meter", [
      StellarSdk.nativeToScVal(meterId, { type: "symbol" }),
    ]);
    const meter = StellarSdk.scValToNative(result) as {
      balance: bigint;
      [key: string]: unknown;
    };
    const balance = Number(meter.balance);

    if (balance <= LOW_BALANCE_THRESHOLD) {
      const body = JSON.stringify({
        event: "low_balance",
        meter_id: meterId,
        balance,
        threshold: LOW_BALANCE_THRESHOLD,
        timestamp: new Date().toISOString(),
      });

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      const secret = process.env.PROVIDER_WEBHOOK_SECRET;
      if (secret) {
        const signature = crypto
          .createHmac("sha256", secret)
          .update(body)
          .digest("hex");
        headers["X-SolarGrid-Signature"] = `sha256=${signature}`;
      }

      await fetch(webhookUrl, {
        method: "POST",
        headers,
        body,
      });

      // Fire webhooks with automatic retry
      await Promise.all(
        [...urls].map((url) => fireWebhook(url, body)),
      );

      logger.info("Low balance webhook fired", { meterId, balance });
    }
  } catch (err) {
    logger.error("Low balance webhook check failed", { meterId, err });
  }
}

/** Encode a batch of readings as a Soroban Vec<(Symbol, u64, i128)>. */
function encodeBatch(readings: Reading[]): StellarSdk.xdr.ScVal {
  const entries = readings.map(({ meterId, units, cost }) =>
    StellarSdk.xdr.ScVal.scvVec([
      StellarSdk.nativeToScVal(meterId, { type: "symbol" }),
      StellarSdk.nativeToScVal(BigInt(units), { type: "u64" }),
      StellarSdk.nativeToScVal(BigInt(cost), { type: "i128" }),
    ]),
  );
  return StellarSdk.xdr.ScVal.scvVec(entries);
}

export async function processMqttMessage(topic: string, payload: Buffer) {
  const meterId = topic.split("/")[2];
  const rawStr = payload.toString();

  let raw: unknown;
  try {
    raw = JSON.parse(rawStr);
  } catch (err) {
    // Include the raw payload to aid debugging; do not rethrow so the bridge keeps running
    logger.error('Malformed MQTT payload, skipping', { topic, raw: rawStr, err });
    return;
  }

  // Merge meterId from the topic so the full { meterId, units, cost } triple is validated together
  const parsed = MqttPayloadSchema.safeParse({ meterId, ...(raw as object) });
  if (!parsed.success) {
    logger.error("Invalid MQTT payload (schema validation failed)", {
      event: "mqtt_payload_invalid",
      topic,
      raw: rawStr,
      errors: parsed.error.flatten().fieldErrors,
    });
    return;
  }

  const { units, cost } = parsed.data;

  logger.info("Usage update received from IoT bridge", {
    meterId,
    units,
    cost,
  });

  const event = await persistAndSubmitUsageEvent({
    meterId,
    units,
    cost,
    sourceTopic: topic,
  });

  if (event.on_chain_tx_hash) {
    logger.info("Usage recorded on-chain", {
      meterId,
      eventId: event.id,
      txHash: event.on_chain_tx_hash,
    });
    // Check if balance is low after usage update
    void checkAndNotifyLowBalance(meterId);
  } else {
    logger.warn("Usage event queued for retry", {
      meterId,
      eventId: event.id,
    });
  }
}

export function startIoTBridge() {
  if (bridgeStarted) {
    logger.warn("IoT bridge already started, skipping duplicate initialization");
    return;
  }
  bridgeStarted = true;
  startMqttBridge();
  startContractEventListener();
}

function startMqttBridge() {
  mqttClient = mqtt.connect(BROKER, {
    reconnectPeriod: 1000,       // start at 1s
    connectTimeout: 10_000,
  });
  const client = mqttClient;

  const MAX_RECONNECT_ATTEMPTS = Number(process.env.MQTT_MAX_RECONNECT_ATTEMPTS ?? 10);
  let reconnectAttempts = 0;

  client.on('reconnect', () => {
    reconnectAttempts++;
    if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
      logger.error('Max MQTT reconnect attempts reached. IoT bridge stopped.', { maxAttempts: MAX_RECONNECT_ATTEMPTS });
      // #528: flip the Prometheus gauge so Grafana alerting can page on-call
      mqttReconnectExhausted.set(1);
      client.end(true, () => {
        // Exit the process so Docker's restart policy (restart: unless-stopped /
        // on-failure) can bring the service back cleanly rather than leaving it
        // in a permanently-broken, non-recovering state.
        logger.fatal('Exiting process after MQTT reconnect exhaustion — expecting Docker/supervisor restart');
        process.exit(1);
      });
      return;
    }
    const delay = Math.min(1000 * 2 ** reconnectAttempts, 30_000);
    client.options.reconnectPeriod = delay;
    logger.warn({ attempt: reconnectAttempts, nextDelayMs: delay }, 'MQTT reconnecting');
  });

  let pending: Reading[] = [];

  const flush = async () => {
    if (pending.length === 0) return;
    const batch = pending.splice(0);
    // Issue #601: submit near-zero-balance meters (lowest balance/daily_limit
    // ratio) first within the batch.
    batch.sort((a, b) => a.priority - b.priority);
    logger.info(`Flushing batch of ${batch.length} meter update(s)`);
    try {
      const hash = await adminInvoke("batch_update_usage", [
        encodeBatch(batch),
      ]);
      logger.info(`Batch recorded on-chain: ${hash}`);

      // Persist each reading locally with the on-chain tx hash for historical reporting
      try {
        insertSubmittedUsageEvents(
          batch.map((b) => ({ meterId: b.meterId, units: b.units, cost: b.cost, sourceTopic: null })),
          hash,
        );
      } catch (err) {
        logger.error("Failed to persist batch usage events to local DB", { err });
      }

      // Low-balance webhooks fire post-batch now that submission is batched
      // rather than per-reading.
      for (const reading of batch) {
        checkAndNotifyLowBalance(reading.meterId).catch((err) => {
          logger.error("Low balance check failed", { meterId: reading.meterId, err });
        });
      }
    } catch (err) {
      logger.error("Batch submission error", { err });
    }
  };

  setInterval(flush, FLUSH_INTERVAL_MS);

  client.on("connect", () => {
    reconnectAttempts = 0;
    client.options.reconnectPeriod = 1000;
    logger.info(`IoT bridge connected to ${BROKER}`);
    client.subscribe(TOPIC, (err) => {
      if (err) logger.error("MQTT subscribe error", { err });
    });
  });

  client.on("message", async (topic, payload) => {
    const segments = topic.split("/");
    const labelTopic = segments.slice(0, 2).join("/"); // e.g. "solargrid/meters"
    mqttMessages.inc({ topic: labelTopic });
    try {
      const meterId = topic.split("/")[2];

      let raw: unknown;
      try {
        raw = JSON.parse(payload.toString());
      } catch (err) {
        logger.error("Invalid MQTT payload (not JSON)", { topic, err });
        return;
      }

      const parsed = MqttPayloadSchema.safeParse({ meterId, ...(raw as object) });
      if (!parsed.success) {
        logger.error("Invalid MQTT payload (schema validation failed)", {
          event: "mqtt_payload_invalid",
          topic,
          errors: parsed.error.flatten().fieldErrors,
        });
        return;
      }
      const { units, cost } = parsed.data;

      logger.info("Usage update received from IoT bridge", {
        meterId,
        units,
        cost,
      });

      // Issue #601: queue for the next priority-ordered batch flush instead
      // of submitting immediately, so near-zero-balance meters can be
      // sequenced first within the batch.
      const priority = await getPriority(meterId);
      pending.push({ meterId, units, cost, priority });
    } catch (err) {
      // Catch any unexpected errors from processing to ensure the bridge keeps running
      logger.error("Unhandled error in MQTT message handler", { topic, raw: payload.toString(), err });
    }
  });

  client.on("error", (err) => {
    logger.error({ err }, "MQTT error");
  });
}

// ── Contract event listener ───────────────────────────────────────────────────

// Track the latest ledger sequence we've processed to avoid re-processing events
const saved = getKV('last_ledger');
let lastProcessedLedger = saved ? Number(saved) : 0;

function startContractEventListener() {
  logger.info("Contract event listener started");
  setInterval(pollContractEvents, EVENT_POLL_INTERVAL_MS);
}

async function pollContractEvents() {
  try {
    const latestLedger = await server.getLatestLedger();
    const currentLedger = latestLedger.sequence;

    if (lastProcessedLedger === 0) {
      // On first run, start from current ledger — don't replay history
      lastProcessedLedger = currentLedger;
      setKV('last_ledger', String(currentLedger));
      return;
    }

    if (currentLedger <= lastProcessedLedger) return;

    // Cap replay to avoid excessive RPC calls after long downtime
    const startLedger = Math.max(lastProcessedLedger + 1, currentLedger - MAX_REPLAY_LEDGERS);
    if (startLedger > lastProcessedLedger + 1) {
      logger.warn({ skippedFrom: lastProcessedLedger + 1, resumeAt: startLedger }, 'Replay capped at MAX_REPLAY_LEDGERS');
    }

    logger.info({ from: startLedger, to: currentLedger }, 'Replaying events from ledger');

    const response = await server.getEvents({
      startLedger,
      filters: [
        {
          type: "contract",
          contractIds: [CONTRACT_ID],
        },
      ],
      limit: 100,
    });

    for (const event of response.events) {
      await handleContractEvent(event);
    }

    lastProcessedLedger = currentLedger;
    setKV('last_ledger', String(currentLedger));
  } catch (err) {
    logger.error("Contract event poll error", { err });
  }
}

export async function handleContractEvent(
  event: StellarSdk.SorobanRpc.Api.EventResponse,
) {
  try {
    const topics = event.topic;

    if (topics.length < 3) return;

    const ns = topics[0].sym()?.toString(); // namespace, e.g. "solargrid"
    const action = topics[1].sym()?.toString(); // action, e.g. "payment", "mtr_actv"
    const subject = topics[2].sym()?.toString() ?? topics[2].str()?.toString();

    if (!ns || !action) return;

    const eventKey = `${ns}:${action}`;

    switch (eventKey) {
      case "solargrid:payment": {
        const data = event.value;
        let amountXlm = 0;
        let planName = "Unknown";

        if (data) {
          try {
            const native = StellarSdk.scValToNative(data) as any[];
            if (Array.isArray(native) && native.length >= 4) {
              amountXlm = Number(native[2]) / 10_000_000;
              const planRaw = native[3];
              if (planRaw) {
                if (typeof planRaw === "string") {
                  planName = planRaw;
                } else if (typeof planRaw === "object") {
                  planName = Object.keys(planRaw)[0] ?? "Unknown";
                }
              }
            }
          } catch (err) {
            logger.error("Failed to parse payment event data", { err });
          }
        }

        const meterId = subject;
        logger.info("payment contract event received", {
          meterId,
          amountXlm,
          plan: planName,
        });

        // Increment XLM payment volume with plan label
        paymentVolume.inc({ plan: planName }, amountXlm);

        await onPaymentReceived(meterId, amountXlm * 10_000_000);
        break;
      }

      case "solargrid:mtr_actv": {
        const meterId = subject;
        logger.info("meter_activated contract event", { meterId });
        await onMeterActivated(meterId);
        break;
      }

      case "solargrid:mtr_deact": {
        const meterId = subject;
        logger.info("meter_deactivated contract event", { meterId });
        await onMeterDeactivated(meterId);
        break;
      }

      case "solargrid:limit_hit": {
        const meterId = subject;
        logger.info("limit_hit contract event received", { meterId });
        await onMeterDeactivated(meterId);
        break;
      }

      case "solargrid:mtr_reg": {
        const owner = String(StellarSdk.scValToNative(event.value));
        const meterId = subject;
        logger.info("meter_registered contract event", { meterId, owner });
        mqttClient?.publish(
          "meters/new",
          JSON.stringify({ meterId, owner }),
          { qos: 1 },
          (err) => { if (err) logger.error({ meterId, err }, "Failed to publish meters/new"); },
        );
        break;
      }

      case "solargrid:mtr_xfr": {
        const [oldOwner, newOwner] = StellarSdk.scValToNative(event.value) as [
          string,
          string,
        ];
        const meterId = subject;
        logger.info("meter_ownership_transferred contract event", {
          meterId,
          oldOwner,
          newOwner,
        });
        mqttClient?.publish(
          "meters/transfer",
          JSON.stringify({ meterId, oldOwner, newOwner }),
          { qos: 1 },
          (err) => {
            if (err) logger.error({ meterId, err }, "Failed to publish meters/transfer");
          },
        );
        break;
      }

      case "solargrid:lmt_set": {
        const [oldLimit, newLimit] = StellarSdk.scValToNative(event.value) as [bigint, bigint];
        logger.info("lmt_set contract event", {
          meterId: subject,
          oldLimit: Number(oldLimit),
          newLimit: Number(newLimit),
        });
        break;
      }

      default:
        break;
    }
  } catch (err) {
    logger.error("Error handling contract event", { err });
  }
}

// ── Event handlers ────────────────────────────────────────────────────────────

async function onPaymentReceived(meterId: string, amountStroops: number) {
  // Placeholder: notify downstream services, update a cache, send a push
  // notification, etc.
  logger.info("Payment received handler", {
    meterId,
    amountXlm: amountStroops / 10_000_000,
  });
}

async function onMeterActivated(meterId: string) {
  const topic = `solargrid/meters/${meterId}/control`;
  const command = 'ON';
  logger.info({
    event: 'relay_command',
    meterId,
    command,
    topic,
    ts: new Date().toISOString(),
  }, 'Sending ON signal to meter relay');
  activeMeters.set({ meter_id: meterId }, 1);
  mqttClient?.publish(
    topic,
    JSON.stringify({ cmd: command, timestamp: new Date().toISOString() }),
    { qos: 1 },
    (err) => { if (err) logger.error({ meterId, err }, 'Failed to publish ON command'); },
  );
}

async function onMeterDeactivated(meterId: string) {
  const topic = `solargrid/meters/${meterId}/control`;
  const command = 'OFF';
  logger.warn({
    event: 'relay_command',
    meterId,
    command,
    topic,
    ts: new Date().toISOString(),
  }, 'Sending OFF signal to meter relay');
  activeMeters.set({ meter_id: meterId }, 0);
  mqttClient?.publish(
    topic,
    JSON.stringify({ cmd: command, timestamp: new Date().toISOString() }),
    { qos: 1 },
    (err) => { if (err) logger.error({ meterId, err }, 'Failed to publish OFF command'); },
  );
}
