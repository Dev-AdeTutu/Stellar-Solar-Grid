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
import { logger } from "../lib/logger.js";
import { persistAndSubmitUsageEvent, insertSubmittedUsageEvents } from "../lib/usageEvents.js";
import { UsageUpdateSchema } from "../lib/validation.js";
import {
  adminInvoke,
  contractQuery,
  server,
  CONTRACT_ID,
} from "../lib/stellar.js";
import * as StellarSdk from "@stellar/stellar-sdk";
import { mqttMessages } from "../lib/metrics.js";

const BROKER = process.env.MQTT_BROKER ?? "mqtt://localhost:1883";
const TOPIC = "solargrid/meters/+/usage";
const FLUSH_INTERVAL_MS = Number(process.env.BATCH_FLUSH_MS ?? 5_000);
const EVENT_POLL_INTERVAL_MS = Number(
  process.env.EVENT_POLL_INTERVAL_MS ?? 5_000,
);
// The on-chain `batch_update_usage` call rejects batches larger than 50
// entries (see contracts/solar_grid/src/lib.rs). Large in-memory queues
// (e.g. after MQTT broker downtime) are chunked to this size before being
// submitted so we never build a single oversized payload or hold the whole
// backlog in memory at once. Configurable, but capped at the contract limit.
const MAX_BATCH_SIZE = Math.min(
  Number(process.env.MAX_BATCH_SIZE ?? 50),
  50,
);

// Low balance webhook configuration
const WEBHOOK_URL = process.env.PROVIDER_WEBHOOK_URL;
const LOW_BALANCE_THRESHOLD = parseInt(
  process.env.LOW_BALANCE_THRESHOLD ?? "1000000",
); // 0.1 XLM in stroops

interface Reading {
  meterId: string;
  units: number;
  cost: number;
}

/** Fire webhook notification when meter balance drops below threshold */
async function checkAndNotifyLowBalance(meterId: string) {
  if (!WEBHOOK_URL) return;

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
      await fetch(WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "low_balance",
          meter_id: meterId,
          balance,
          threshold: LOW_BALANCE_THRESHOLD,
          timestamp: new Date().toISOString(),
        }),
      });
      logger.info("Low balance webhook fired", { meterId, balance });
    }
  } catch (err) {
    logger.error("Low balance webhook failed", { meterId, err });
    // Log but do not crash the bridge
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

export function startIoTBridge() {
  startMqttBridge();
  startContractEventListener();
}

function startMqttBridge() {
  const client = mqtt.connect(BROKER, {
    reconnectPeriod: 1000,       // start at 1s
    connectTimeout: 10_000,
  });

  const MAX_RECONNECT_ATTEMPTS = Number(process.env.MQTT_MAX_RECONNECT_ATTEMPTS ?? 10);
  let reconnectAttempts = 0;

  client.on('reconnect', () => {
    reconnectAttempts++;
    if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
      logger.error('MQTT reconnect attempts exhausted', { maxAttempts: MAX_RECONNECT_ATTEMPTS });
      client.end(); // stop reconnecting
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
    logger.info(`Flushing batch of ${batch.length} meter update(s)`);

    // Process in fixed-size chunks so a large backlog (e.g. built up during
    // MQTT broker downtime) never produces a single oversized on-chain call
    // or keeps the entire backlog referenced in memory at once — each chunk
    // is submitted and released before the next one is sliced off.
    for (let offset = 0; offset < batch.length; offset += MAX_BATCH_SIZE) {
      const chunk = batch.slice(offset, offset + MAX_BATCH_SIZE);
      try {
        const hash = await adminInvoke("batch_update_usage", [
          encodeBatch(chunk),
        ]);
        logger.info(`Batch chunk recorded on-chain: ${hash}`, {
          chunkSize: chunk.length,
          offset,
          totalBatchSize: batch.length,
        });

        // Persist each reading locally with the on-chain tx hash for historical reporting
        try {
          insertSubmittedUsageEvents(
            chunk.map((b) => ({ meterId: b.meterId, units: b.units, cost: b.cost, sourceTopic: null })),
            hash,
          );
        } catch (err) {
          logger.error("Failed to persist batch usage events to local DB", { err });
        }
      } catch (err) {
        logger.error("Batch submission error", { err, offset, chunkSize: chunk.length });
      }
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
    mqttMessages.inc();
    try {
      const meterId = topic.split("/")[2];

      let raw: unknown;
      try {
        raw = JSON.parse(payload.toString());
      } catch (err) {
        logger.error("Invalid MQTT payload (not JSON)", { topic, err });
        return;
      }

      const parsed = UsageUpdateSchema.safeParse(raw);
      if (!parsed.success) {
        logger.error("Invalid MQTT payload (schema validation failed)", {
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
        checkAndNotifyLowBalance(meterId);
      } else {
        logger.warn("Usage event queued for retry", {
          meterId,
          eventId: event.id,
        });
      }
    } catch (err) {
      logger.error("IoT bridge parse error", { err });
    }
  });

  client.on("error", (err) => {
    logger.error({ err }, "MQTT error");
  });
}

// ── Contract event listener ───────────────────────────────────────────────────

// Track the latest ledger sequence we've processed to avoid re-processing events
let lastProcessedLedger = 0;

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
      return;
    }

    if (currentLedger <= lastProcessedLedger) return;

    const response = await server.getEvents({
      startLedger: lastProcessedLedger + 1,
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
  } catch (err) {
    logger.error("Contract event poll error", { err });
  }
}

async function handleContractEvent(
  event: StellarSdk.SorobanRpc.Api.EventResponse,
) {
  try {
    const topics = event.topic;

    if (topics.length < 2) return;

    const ns = topics[0].sym()?.toString(); // e.g. "payment" or "meter"
    const name = topics[1].sym()?.toString(); // e.g. "received", "activated", "deactivated"

    if (!ns || !name) return;

    const eventKey = `${ns}:${name}`;

    switch (eventKey) {
      case "payment:received": {
        const data = event.value;
        const native = StellarSdk.scValToNative(data) as [
          string,
          bigint,
          unknown,
        ];
        const [meterId, amount] = native;
        logger.info("payment_received contract event", {
          meterId: String(meterId),
          amountXlm: Number(amount) / 10_000_000,
        });
        await onPaymentReceived(String(meterId), Number(amount));
        break;
      }

      case "meter:activated": {
        const data = event.value;
        const meterId = String(StellarSdk.scValToNative(data));
        logger.info("meter_activated contract event", { meterId });
        await onMeterActivated(meterId);
        break;
      }

      case "meter:deactivated": {
        const data = event.value;
        const meterId = String(StellarSdk.scValToNative(data));
        logger.info("meter_deactivated contract event", { meterId });
        await onMeterDeactivated(meterId);
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
  // Send ON signal to the physical smart meter via MQTT or HTTP
  logger.info("Sending ON signal to meter", { meterId });
  // e.g. mqttClient.publish(`solargrid/meters/${meterId}/control`, JSON.stringify({ cmd: "ON" }));
}

async function onMeterDeactivated(meterId: string) {
  // Send OFF signal to the physical smart meter via MQTT or HTTP
  logger.info("Sending OFF signal to meter", { meterId });
  // e.g. mqttClient.publish(`solargrid/meters/${meterId}/control`, JSON.stringify({ cmd: "OFF" }));
}
