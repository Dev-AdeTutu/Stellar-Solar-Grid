import type { MqttClient } from 'mqtt';
import { logger } from '../../lib/logger.js';
import type { MeshNode } from './MeshNode.js';
import type { BeaconMessage } from './types.js';
import { MeshMessageType } from './types.js';

const BEACON_INTERVAL_MS = 30000; // 30 seconds
const NEIGHBOR_TIMEOUT_MS = 90000; // 90 seconds

/**
 * NeighborDiscovery handles beacon broadcasting and neighbor discovery.
 * Publishes periodic beacons and listens for beacons from other nodes.
 */
export class NeighborDiscovery {
  private meshNode: MeshNode;
  private mqttClient: MqttClient;
  private beaconInterval: NodeJS.Timeout | null = null;
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(meshNode: MeshNode, mqttClient: MqttClient) {
    this.meshNode = meshNode;
    this.mqttClient = mqttClient;
  }

  /**
   * Start neighbor discovery: publish beacons and subscribe to peer beacons.
   */
  public start(): void {
    // Subscribe to all beacon messages
    const beaconTopic = 'solargrid/mesh/+/beacon';
    this.mqttClient.subscribe(beaconTopic, { qos: 1 }, (err) => {
      if (err) {
        logger.error('Failed to subscribe to beacon topic', { topic: beaconTopic, err });
      } else {
        logger.info('Subscribed to beacon topic', { topic: beaconTopic });
      }
    });

    // Handle incoming messages
    this.mqttClient.on('message', (topic, payload) => {
      if (topic.includes('/mesh/') && topic.endsWith('/beacon')) {
        this.handleBeacon(topic, payload);
      }
    });

    // Start publishing own beacons
    this.beaconInterval = setInterval(() => {
      this.publishBeacon();
    }, BEACON_INTERVAL_MS);

    // Start cleanup of stale neighbors
    this.cleanupInterval = setInterval(() => {
      this.cleanupStaleNeighbors();
    }, NEIGHBOR_TIMEOUT_MS / 3); // Check every 30 seconds

    // Publish initial beacon immediately
    this.publishBeacon();

    logger.info('NeighborDiscovery started', {
      meterId: this.meshNode.meterId,
      beaconIntervalMs: BEACON_INTERVAL_MS,
      neighborTimeoutMs: NEIGHBOR_TIMEOUT_MS,
    });
  }

  /**
   * Stop neighbor discovery and clean up timers.
   */
  public stop(): void {
    if (this.beaconInterval) {
      clearInterval(this.beaconInterval);
      this.beaconInterval = null;
    }
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    logger.info('NeighborDiscovery stopped', { meterId: this.meshNode.meterId });
  }

  /**
   * Publish own beacon message.
   */
  private publishBeacon(): void {
    const beacon: BeaconMessage = {
      type: MeshMessageType.BEACON,
      meterId: this.meshNode.meterId,
      position: this.meshNode.position,
      timestamp: Date.now(),
    };

    const topic = `solargrid/mesh/${this.meshNode.meterId}/beacon`;
    const payload = JSON.stringify(beacon);

    this.mqttClient.publish(topic, payload, { qos: 1 }, (err) => {
      if (err) {
        logger.error('Failed to publish beacon', {
          meterId: this.meshNode.meterId,
          err,
        });
      } else {
        logger.debug('Published beacon', {
          meterId: this.meshNode.meterId,
          topic,
        });
      }
    });
  }

  /**
   * Handle incoming beacon from a peer node.
   */
  private handleBeacon(topic: string, payload: Buffer): void {
    try {
      const beacon = JSON.parse(payload.toString()) as BeaconMessage;

      // Ignore our own beacons
      if (beacon.meterId === this.meshNode.meterId) {
        return;
      }

      // Validate beacon structure
      if (!beacon.meterId || !beacon.position || typeof beacon.timestamp !== 'number') {
        logger.warn('Invalid beacon message', { topic, beacon });
        return;
      }

      const existingNeighbor = this.meshNode.getNeighbor(beacon.meterId);

      if (existingNeighbor) {
        // Update existing neighbor
        this.meshNode.updateNeighbor(beacon.meterId, {
          lastSeen: Date.now(),
          position: beacon.position,
          // Keep existing RSSI or default to -50 dBm
          rssi: existingNeighbor.rssi,
        });
      } else {
        // Add new neighbor
        this.meshNode.addNeighbor({
          meterId: beacon.meterId,
          position: beacon.position,
          lastSeen: Date.now(),
          rssi: -50, // Default RSSI value (moderate signal strength)
        });
      }

      logger.debug('Processed beacon from neighbor', {
        meterId: this.meshNode.meterId,
        neighborId: beacon.meterId,
        neighborCount: this.meshNode.getNeighborCount(),
      });
    } catch (err) {
      logger.error('Failed to parse beacon message', { topic, err });
    }
  }

  /**
   * Remove stale neighbors that haven't sent beacons recently.
   */
  private cleanupStaleNeighbors(): void {
    const neighbors = this.meshNode.getNeighbors();
    let removedCount = 0;

    for (const neighbor of neighbors) {
      if (!this.meshNode.isNeighborAlive(neighbor.meterId, NEIGHBOR_TIMEOUT_MS)) {
        this.meshNode.removeNeighbor(neighbor.meterId);
        removedCount++;
      }
    }

    if (removedCount > 0) {
      logger.info('Cleaned up stale neighbors', {
        meterId: this.meshNode.meterId,
        removedCount,
        remainingNeighbors: this.meshNode.getNeighborCount(),
      });
    }
  }
}
