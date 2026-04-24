/**
 * IoT Bridge — subscribes to MQTT topics published by smart meters
 * and forwards usage data to the Soroban contract via the admin keypair.
 *
 * Expected MQTT topic:  solargrid/meters/{meter_id}/usage
 * Expected payload:     { "units": 100, "cost": 500000 }
 */

import mqtt from "mqtt";
import { adminInvoke } from "../lib/stellar.js";
import * as StellarSdk from "@stellar/stellar-sdk";

const BROKER = process.env.MQTT_BROKER ?? "mqtt://localhost:1883";
const TOPIC = "solargrid/meters/+/usage";

export function startIoTBridge() {
  const client = mqtt.connect(BROKER);

  client.on("connect", () => {
    console.log(`📡 IoT bridge connected to ${BROKER}`);
    client.subscribe(TOPIC, (err) => {
      if (err) console.error("MQTT subscribe error:", err);
    });
  });

  client.on("message", async (topic, payload) => {
    try {
      // Extract meter_id from topic: solargrid/meters/{meter_id}/usage
      const parts = topic.split("/");
      const meterId = parts[2];
      const { units, cost } = JSON.parse(payload.toString()) as {
        units: number;
        cost: number;
      };

      console.log(`⚡ Usage update — meter: ${meterId}, units: ${units}, cost: ${cost}`);

      const hash = await adminInvoke("update_usage", [
        StellarSdk.nativeToScVal(meterId, { type: "symbol" }),
        StellarSdk.nativeToScVal(BigInt(units), { type: "u64" }),
        StellarSdk.nativeToScVal(BigInt(cost), { type: "i128" }),
      ]);

      console.log(`✅ Usage recorded on-chain: ${hash}`);
    } catch (err: unknown) {
      console.error("IoT bridge error:", err instanceof Error ? err.message : String(err));
    }
  });

  client.on("error", (err) => {
    // Non-fatal — bridge will retry on reconnect
    console.warn("MQTT connection error (will retry):", err.message);
  });
}
