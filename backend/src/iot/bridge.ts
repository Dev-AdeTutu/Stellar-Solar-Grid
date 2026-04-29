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
import { persistAndSubmitUsageEvent } from "../lib/usageEvents.js";

const BROKER = process.env.MQTT_BROKER ?? "mqtt://localhost:1883";
const TOPIC = "solargrid/meters/+/usage";
const FLUSH_INTERVAL_MS = Number(process.env.BATCH_FLUSH_MS ?? 5_000);
const EVENT_POLL_INTERVAL_MS = Number(process.env.EVENT_POLL_INTERVAL_MS ?? 5_000);

interface Reading {
  meterId: string;
  units: number;
  cost: number;
}

/** Encode a batch of readings as a Soroban Vec<(Symbol, u64, i128)>. */
function encodeBatch(readings: Reading[]): StellarSdk.xdr.ScVal {
  const entries = readings.map(({ meterId, units, cost }) =>
    StellarSdk.xdr.ScVal.scvVec([
      StellarSdk.nativeToScVal(meterId, { type: "symbol" }),
      StellarSdk.nativeToScVal(BigInt(units), { type: "u64" }),
      StellarSdk.nativeToScVal(BigInt(cost), { type: "i128" }),
    ])
  );
  return StellarSdk.xdr.ScVal.scvVec(entries);
}

export function startIoTBridge() {
  startMqttBridge();
  startContractEventListener();
}

function startMqttBridge() {
  const client = mqtt.connect(BROKER);
  let pending: Reading[] = [];

  const flush = async () => {
    if (pending.length === 0) return;
    const batch = pending.splice(0);
    logger.info(`Flushing batch of ${batch.length} meter update(s)`);
    try {
      const hash = await adminInvoke("batch_update_usage", [encodeBatch(batch)]);
      logger.info(`Batch recorded on-chain: ${hash}`);
    } catch (err) {
      logger.error("Batch submission error", { err });
    }
  };

  setInterval(flush, FLUSH_INTERVAL_MS);

  client.on("connect", () => {
    logger.info(`IoT bridge connected to ${BROKER}`);
    client.subscribe(TOPIC, (err) => {
      if (err) logger.error("MQTT subscribe error", { err });
    });
  });

  client.on("message", (topic, payload) => {
    mqttMessages.inc();
    try {
      const meterId = topic.split("/")[2];
      const { units, cost } = JSON.parse(payload.toString()) as {
        units: number;
        cost: number;
      };

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
    logger.warn("MQTT connection error (will retry)", { message: err.message });
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

    const ns = topics[0].sym()?.toString();   // e.g. "payment" or "meter"
    const name = topics[1].sym()?.toString(); // e.g. "received", "activated", "deactivated"

    if (!ns || !name) return;

    const eventKey = `${ns}:${name}`;

    switch (eventKey) {
      case "payment:received": {
        const data = event.value;
        const native = StellarSdk.scValToNative(data) as [string, bigint, unknown];
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
