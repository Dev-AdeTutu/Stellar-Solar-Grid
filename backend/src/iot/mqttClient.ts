import mqtt, { MqttClient } from 'mqtt';
import { logger } from '../lib/logger.js';

const BROKER = process.env.MQTT_BROKER ?? 'mqtt://localhost:1883';

let client: MqttClient | null = null;

const BRIDGE_STATUS_TOPIC = 'solargrid/bridge/status';

export function getMqttClient(): MqttClient {
  if (!client) {
    client = mqtt.connect(BROKER, {
      reconnectPeriod: 1000,
      // Issue #600: last-will-and-testament — the broker publishes this on
      // our behalf if we disconnect uncleanly (crash, network loss) without
      // sending an explicit DISCONNECT, so subscribers can detect the
      // bridge went offline instead of just seeing silence.
      will: {
        topic: BRIDGE_STATUS_TOPIC,
        payload: JSON.stringify({ status: 'offline' }),
        qos: 1,
        retain: true,
      },
    });
    client.on('connect', () => {
      client?.publish(
        BRIDGE_STATUS_TOPIC,
        JSON.stringify({ status: 'online' }),
        { qos: 1, retain: true },
      );
    });
    client.on('error', (err) => logger.error('MQTT client error', { err }));
  }
  return client;
}
