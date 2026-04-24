/**
 * IoT Bridge — subscribes to MQTT topics published by smart meters
 * and forwards usage data to the Soroban contract via the admin keypair.
 *
 * Readings are buffered per flush interval and submitted as a single
 * batch_update_usage call to minimise transaction overhead.
 *
 * Expected MQTT topic:  solargrid/meters/{meter_id}/usage
 * Expected payload:     { "units": 100, "cost": 500000 }
 *
 * Readings are buffered for BATCH_INTERVAL_MS and flushed as a single
 * batch_update_usage call to reduce on-chain transaction fees.
 */

import mqtt from "mqtt";
import { adminInvoke } from "../lib/stellar.js";
import * as StellarSdk from "@stellar/stellar-sdk";

const BROKER = process.env.MQTT_BROKER ?? "mqtt://localhost:1883";
const TOPIC = "solargrid/meters/+/usage";
const FLUSH_INTERVAL_MS = Number(process.env.BATCH_FLUSH_MS ?? 5_000);

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
  const client = mqtt.connect(BROKER);
  let pending: Reading[] = [];

  const flush = async () => {
    if (pending.length === 0) return;
    const batch = pending.splice(0);
    console.log(`📦 Flushing batch of ${batch.length} meter update(s)`);
    try {
      const hash = await adminInvoke("batch_update_usage", [encodeBatch(batch)]);
      console.log(`✅ Batch recorded on-chain: ${hash}`);
    } catch (err) {
      console.error("Batch submission error:", err);
    }
  };

  setInterval(flush, FLUSH_INTERVAL_MS);

  setInterval(flushBatch, BATCH_INTERVAL_MS);

  client.on("connect", () => {
    console.log(`📡 IoT bridge connected to ${BROKER}`);
    client.subscribe(TOPIC, (err) => {
      if (err) console.error("MQTT subscribe error:", err instanceof Error ? err.message : String(err));
    });
  });

  client.on("message", (topic, payload) => {
    try {
      const meterId = topic.split("/")[2];
      const { units, cost } = JSON.parse(payload.toString()) as {
        units: number;
        cost: number;
      };
      pending.push({ meterId, units, cost });
    } catch (err) {
      console.error("IoT bridge parse error:", err);
    }
  });

  client.on("error", (err) => {
    console.warn("MQTT connection error (will retry):", err.message);
  });
}
