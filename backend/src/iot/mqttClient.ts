import mqtt, { MqttClient } from 'mqtt';
import { logger } from '../lib/logger.js';

const BROKER = process.env.MQTT_BROKER ?? 'mqtt://localhost:1883';

let client: MqttClient | null = null;

const BRIDGE_STATUS_TOPIC = 'solargrid/bridge/status';

// Exponential backoff configuration for reconnection
const INITIAL_RECONNECT_DELAY = 1000; // 1 second
const MAX_RECONNECT_DELAY = 32000; // 32 seconds
const BACKOFF_MULTIPLIER = 2;

let reconnectAttempts = 0;

function getReconnectDelay(): number {
  const delay = Math.min(
    INITIAL_RECONNECT_DELAY * Math.pow(BACKOFF_MULTIPLIER, reconnectAttempts),
    MAX_RECONNECT_DELAY
  );
  reconnectAttempts++;
  return delay;
}

function resetReconnectAttempts(): void {
  reconnectAttempts = 0;
}

// Issue #853: track the last time each meter reported so offline detection
// can flag meters that have gone silent due to connectivity issues.
const lastSeenByMeter = new Map<string, number>();

/**
 * Record that a meter has just reported. Called on every inbound MQTT
 * message so `last_seen` stays current for offline detection.
 */
export function recordMeterLastSeen(meterId: string, timestamp: number = Date.now()): void {
  lastSeenByMeter.set(meterId, timestamp);
}

/**
 * Return the last-seen timestamp for a meter, or undefined if it has
 * never reported.
 */
export function getMeterLastSeen(meterId: string): number | undefined {
  return lastSeenByMeter.get(meterId);
}

/**
 * List meters whose last-seen timestamp is older than the given threshold.
 * Meters that have never reported are treated as offline.
 */
export function getOfflineMeters(thresholdMs: number = 60 * 60 * 1000): string[] {
  const cutoff = Date.now() - thresholdMs;
  const offline: string[] = [];
  for (const [meterId, lastSeen] of lastSeenByMeter) {
    if (lastSeen < cutoff) offline.push(meterId);
  }
  return offline;
}

export function getMqttClient(): MqttClient {
  if (!client) {
    client = mqtt.connect(BROKER, {
      reconnectPeriod: 0, // Disable automatic reconnection to implement custom backoff
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
      resetReconnectAttempts();
      logger.info('MQTT client connected to broker', { broker: BROKER });
      client?.publish(
        BRIDGE_STATUS_TOPIC,
        JSON.stringify({ status: 'online', timestamp: Date.now() }),
        { qos: 1, retain: true },
      );
    });

    // Issue #853: update last_seen on every inbound MQTT message so offline
    // detection has an up-to-date view of meter connectivity.
    client.on('message', (topic, payload) => {
      try {
        const data = JSON.parse(payload.toString());
        const meterId = data?.meterId ?? data?.meter_id ?? topic.split('/').pop();
        if (meterId) {
          recordMeterLastSeen(String(meterId));
        }
      } catch (err) {
        logger.warn('Failed to parse MQTT message for last_seen tracking', { topic, err });
      }
    });

    client.on('disconnect', () => {
      logger.info('MQTT client disconnected from broker');
      client?.publish(
        BRIDGE_STATUS_TOPIC,
        JSON.stringify({ status: 'offline', timestamp: Date.now() }),
        { qos: 1, retain: true },
        (err) => {
          if (err) logger.error('Failed to publish offline status', { err });
        }
      );
    });

    // Issue #693: Implement exponential backoff reconnection logic
    client.on('error', (err) => {
      logger.error('MQTT client error', { err });
    });

    client.on('close', () => {
      logger.warn('MQTT connection closed, attempting reconnect with exponential backoff');
      const delay = getReconnectDelay();
      logger.info('Scheduling reconnect attempt', {
        attempt: reconnectAttempts,
        delayMs: delay,
      });
      setTimeout(() => {
        logger.info('Attempting to reconnect to MQTT broker', {
          broker: BROKER,
          attempt: reconnectAttempts,
        });
        client?.reconnect();
      }, delay);
    });

    client.on('offline', () => {
      logger.warn('MQTT client went offline');
    });
  }
  return client;
}
