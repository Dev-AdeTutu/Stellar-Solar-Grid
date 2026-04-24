/**
 * IoT Bridge — subscribes to MQTT topics published by smart meters
 * and forwards usage data to the Soroban contract via the admin keypair.
 *
 * Expected MQTT topic:  solargrid/meters/{meter_id}/usage
 * Expected payload:     { "units": 100, "cost": 500000 }
 */

import mqtt from "mqtt";
import { adminInvoke } from "../lib/stellar.js";
import { logger } from "../lib/logger.js";
import { mqttMessages } from "../lib/metrics.js";
import * as StellarSdk from "@stellar/stellar-sdk";

const BROKER = process.env.MQTT_BROKER ?? "mqtt://localhost:1883";
const TOPIC = "solargrid/meters/+/usage";

export function startIoTBridge() {
  const client = mqtt.connect(BROKER);

  client.on("connect", () => {
    logger.info(`IoT bridge connected to ${BROKER}`);
    client.subscribe(TOPIC, (err) => {
      if (err) logger.error("MQTT subscribe error", { err });
    });
  });

  client.on("message", async (topic, payload) => {
    mqttMessages.inc();
    try {
      const parts = topic.split("/");
      const meterId = parts[2];
      const { units, cost } = JSON.parse(payload.toString()) as {
        units: number;
        cost: number;
      };

      logger.info("Usage update", { meterId, units, cost });

      const hash = await adminInvoke("update_usage", [
        StellarSdk.nativeToScVal(meterId, { type: "symbol" }),
        StellarSdk.nativeToScVal(BigInt(units), { type: "u64" }),
        StellarSdk.nativeToScVal(BigInt(cost), { type: "i128" }),
      ]);

      logger.info("Usage recorded on-chain", { hash });
    } catch (err) {
      logger.error("IoT bridge error", { err });
    }
  });

  client.on("error", (err) => {
    logger.warn("MQTT connection error (will retry)", { message: err.message });
  });
}
