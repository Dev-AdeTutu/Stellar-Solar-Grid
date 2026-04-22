/**
 * IoT Bridge — subscribes to MQTT topics published by smart meters
 * and forwards usage data to the Soroban contract via the admin keypair.
 *
 * Expected MQTT topic:  solargrid/meters/{meter_id}/usage
 * Expected payload:     { "units": 100, "cost": 500000 }
 *
 * Implements exponential backoff reconnect and unreachability alerting (#28).
 */

import mqtt from "mqtt";
import { adminInvoke } from "../lib/stellar.js";
import * as StellarSdk from "@stellar/stellar-sdk";

const BROKER = process.env.MQTT_BROKER ?? "mqtt://localhost:1883";
const TOPIC = "solargrid/meters/+/usage";
const ALERT_THRESHOLD_MS = 60_000;

// Shared state exported for the health endpoint
export const mqttStatus = {
  connected: false,
  lastConnectedAt: null as Date | null,
  disconnectedSince: null as Date | null,
};

export function startIoTBridge() {
  const client = mqtt.connect(BROKER, {
    reconnectPeriod: 0, // disable built-in reconnect — we handle it manually
  });

  let retryCount = 0;
  let alertTimer: ReturnType<typeof setInterval> | null = null;

  function scheduleReconnect() {
    // Exponential backoff: 1s, 2s, 4s, 8s … capped at 60s
    const delay = Math.min(1000 * 2 ** retryCount, 60_000);
    retryCount++;
    console.warn(`🔄 MQTT reconnecting in ${delay / 1000}s (attempt ${retryCount})…`);
    setTimeout(() => client.reconnect(), delay);
  }

  function startAlertTimer() {
    if (alertTimer) return;
    alertTimer = setInterval(() => {
      if (!mqttStatus.connected && mqttStatus.disconnectedSince) {
        const downMs = Date.now() - mqttStatus.disconnectedSince.getTime();
        if (downMs >= ALERT_THRESHOLD_MS) {
          console.error(
            `🚨 ALERT: MQTT broker unreachable for ${Math.round(downMs / 1000)}s — usage events are being dropped!`
          );
        }
      }
    }, 15_000);
  }

  function stopAlertTimer() {
    if (alertTimer) {
      clearInterval(alertTimer);
      alertTimer = null;
    }
  }

  client.on("connect", () => {
    mqttStatus.connected = true;
    mqttStatus.lastConnectedAt = new Date();
    mqttStatus.disconnectedSince = null;
    retryCount = 0;
    stopAlertTimer();
    console.log(`📡 IoT bridge connected to ${BROKER}`);
    client.subscribe(TOPIC, (err) => {
      if (err) console.error("MQTT subscribe error:", err);
    });
  });

  client.on("disconnect", () => {
    mqttStatus.connected = false;
    mqttStatus.disconnectedSince ??= new Date();
    startAlertTimer();
    scheduleReconnect();
  });

  client.on("error", (err) => {
    console.warn("MQTT connection error:", err.message);
    mqttStatus.connected = false;
    mqttStatus.disconnectedSince ??= new Date();
    startAlertTimer();
    // mqtt.js emits 'close' after 'error', which triggers reconnect below
  });

  client.on("close", () => {
    if (!mqttStatus.connected) {
      mqttStatus.disconnectedSince ??= new Date();
      startAlertTimer();
      scheduleReconnect();
    }
  });

  client.on("message", async (topic, payload) => {
    try {
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
    } catch (err) {
      console.error("IoT bridge error:", err);
    }
  });
}
