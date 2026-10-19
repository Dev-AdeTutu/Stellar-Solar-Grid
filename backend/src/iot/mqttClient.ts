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

// Issue #1069: edge computing runtime needs to know when connectivity
// returns so it can flush buffered inference results to the cloud.
let connected = false;
const reconnectCallbacks: Array<() => void> = [];

/**
 * Returns true when the MQTT client is currently connected to the broker.
 */
export function isMqttConnected(): boolean {
  return connected;
}

/**
 * Register a callback invoked whenever the MQTT client (re)connects to the
 * broker. Used by the edge runtime to flush its offline buffer.
 * Returns an unsubscribe function.
 */
export function onMqttReconnect(callback: () => void): () => void {
  reconnectCallbacks.push(callback);
  return () => {
    const idx = reconnectCallbacks.indexOf(callback);
    if (idx !== -1) reconnectCallbacks.splice(idx, 1);
  };
}

/**
 * Publish edge inference results for a meter to its dedicated topic.
 * Topic: solargrid/meters/{id}/edge-results
 */
export function publishEdgeResults(meterId: string, results: unknown): void {
  const topic = `solargrid/meters/${meterId}/edge-results`;
  const mqttClient = getMqttClient();
  mqttClient.publish(topic, JSON.stringify(results), { qos: 1 }, (err) => {
    if (err) {
      logger.error('Failed to publish edge results', { meterId, err });
    } else {
      logger.debug('Published edge results', { meterId, topic });
    }
  });
}

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

// Issue #990: bidirectional meters report both grid import and grid export
// readings. Normalise the direction so the bridge can distinguish the two
// without misclassifying export readings as imports (or vice versa).
export type MeterReadingDirection = 'import' | 'export';

/**
 * Determine the direction of a meter reading from an inbound MQTT payload.
 * Supports an explicit `direction` field as well as an `export` boolean
 * flag. Anything that is not clearly an export is treated as an import,
 * which preserves the existing behaviour for unidirectional meters.
 */
export function getReadingDirection(data: unknown): MeterReadingDirection {
  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>;
    const direction = record.direction;
    if (typeof direction === 'string' && direction.toLowerCase() === 'export') {
      return 'export';
    }
    if (record.export === true || record.export === 'true') {
      return 'export';
    }
  }
  return 'import';
}

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
      connected = true;
      logger.info('MQTT client connected to broker', { broker: BROKER });
      client?.publish(
        BRIDGE_STATUS_TOPIC,
        JSON.stringify({ status: 'online', timestamp: Date.now() }),
        { qos: 1, retain: true },
      );
      // Issue #1069: notify edge runtime so it can flush offline buffer.
      for (const cb of reconnectCallbacks) {
        try {
          cb();
        } catch (err) {
          logger.error('MQTT reconnect callback failed', { err });
        }
      }
    });

    // Issue #853: update last_seen on every inbound MQTT message so offline
    // detection has an up-to-date view of meter connectivity.
    // Issue #990: bidirectional meters publish both import and export
    // readings; both must still refresh last_seen and be tagged with their
    // direction so the bridge can route export readings to credit tracking.
    client.on('message', (topic, payload) => {
      try {
        const data = JSON.parse(payload.toString());
        const meterId = data?.meterId ?? data?.meter_id ?? topic.split('/').pop();
        if (meterId) {
          recordMeterLastSeen(String(meterId));
          const direction = getReadingDirection(data);
          logger.debug('Recorded meter reading', {
            meterId: String(meterId),
            direction,
            topic,
          });
        }
      } catch (err) {
        logger.warn('Failed to parse MQTT message for last_seen tracking', { topic, err });
      }
    });

    client.on('disconnect', () => {
      connected = false;
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
      connected = false;
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
      connected = false;
      logger.warn('MQTT client went offline');
    });
  }
  return client;
}

/**
 * Publish MQTT command to control individual circuit state on an IoT meter (#977).
 */
export async function publishCircuitControl(
  meterId: string,
  circuitId: number,
  state: 'shed' | 'restore'
): Promise<void> {
  const mqtt = getMqttClient();
  const topic = `solargrid/meters/${meterId}/circuits/${circuitId}/command`;
  const payload = JSON.stringify({
    action: state,
    circuitId,
    meterId,
    timestamp: Date.now(),
  });

  return new Promise((resolve, reject) => {
    mqtt.publish(topic, payload, { qos: 1 }, (err) => {
      if (err) {
        logger.error('Failed to publish circuit command over MQTT', { meterId, circuitId, state, err });
        return reject(err);
      }
      logger.info('Published circuit command over MQTT', { meterId, circuitId, state, topic });
      resolve();
    });
  });
}

