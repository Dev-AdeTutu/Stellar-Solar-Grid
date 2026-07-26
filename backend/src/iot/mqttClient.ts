import mqtt, { MqttClient } from 'mqtt';
import { logger } from '../lib/logger.js';

const BROKER = process.env.MQTT_BROKER ?? 'mqtt://localhost:1883';

let client: MqttClient | null = null;

export function getMqttClient(): MqttClient {
  if (!client) {
    client = mqtt.connect(BROKER, { reconnectPeriod: 1000 });
    client.on('error', (err) => logger.error('MQTT client error', { err }));
  }
  return client;
}
