import type { MqttClient } from 'mqtt';
import { logger } from '../../lib/logger.js';
import type { MeshNode } from './MeshNode.js';
import type { RoutingProtocol } from './RoutingProtocol.js';
import type { DataMessage } from './types.js';
import { MeshMessageType } from './types.js';

/**
 * MessageForwarder handles multi-hop message forwarding in the mesh network.
 * Routes data messages through intermediate nodes to reach distant destinations.
 */
export class MessageForwarder {
  private meshNode: MeshNode;
  private mqttClient: MqttClient;
  private routingProtocol: RoutingProtocol;
  private processedMessages: Set<string>; // Deduplication: originId-timestamp

  constructor(
    meshNode: MeshNode,
    mqttClient: MqttClient,
    routingProtocol: RoutingProtocol
  ) {
    this.meshNode = meshNode;
    this.mqttClient = mqttClient;
    this.routingProtocol = routingProtocol;
    this.processedMessages = new Set();
  }

  /**
   * Start the message forwarder: subscribe to data messages.
   */
  public start(): void {
    this.mqttClient.subscribe('solargrid/mesh/data', { qos: 1 }, (err) => {
      if (err) {
        logger.error('Failed to subscribe to data topic', { err });
      } else {
        logger.info('Subscribed to data topic');
      }
    });

    this.mqttClient.on('message', (topic, payload) => {
      if (topic === 'solargrid/mesh/data') {
        this.handleDataMessage(payload);
      }
    });

    logger.info('MessageForwarder started', { meterId: this.meshNode.meterId });
  }

  /**
   * Send a data message to a destination meter.
   * Automatically discovers routes if needed and handles multi-hop forwarding.
   */
  public async sendMessage(destMeterId: string, payload: unknown): Promise<boolean> {
    const route = this.routingProtocol.findRoute(destMeterId);

    if (!route) {
      logger.warn('No route available to destination', {
        meterId: this.meshNode.meterId,
        destMeterId,
      });
      return false;
    }

    const dataMessage: DataMessage = {
      type: MeshMessageType.DATA,
      originId: this.meshNode.meterId,
      destId: destMeterId,
      payload,
      timestamp: Date.now(),
    };

    return this.forwardMessage(dataMessage);
  }

  /**
   * Forward a data message to the next hop.
   */
  private forwardMessage(message: DataMessage): boolean {
    const payload = JSON.stringify(message);

    return new Promise<boolean>((resolve) => {
      this.mqttClient.publish('solargrid/mesh/data', payload, { qos: 1 }, (err) => {
        if (err) {
          logger.error('Failed to forward message', {
            meterId: this.meshNode.meterId,
            message,
            err,
          });
          resolve(false);
        } else {
          logger.debug('Message forwarded', {
            meterId: this.meshNode.meterId,
            originId: message.originId,
            destId: message.destId,
          });
          resolve(true);
        }
      });
    }) as unknown as boolean;
  }

  /**
   * Handle incoming data message: deliver or forward.
   */
  private handleDataMessage(payload: Buffer): void {
    try {
      const message = JSON.parse(payload.toString()) as DataMessage;

      // Deduplication check
      const messageKey = `${message.originId}-${message.timestamp}`;
      if (this.processedMessages.has(messageKey)) {
        logger.debug('Duplicate message ignored', {
          meterId: this.meshNode.meterId,
          messageKey,
        });
        return;
      }

      this.processedMessages.add(messageKey);

      // Clean old entries periodically (keep last 1000 messages)
      if (this.processedMessages.size > 1000) {
        const entriesToDelete = Array.from(this.processedMessages).slice(0, 100);
        entriesToDelete.forEach((key) => this.processedMessages.delete(key));
      }

      // If message is for us, deliver it
      if (message.destId === this.meshNode.meterId) {
        logger.info('Message delivered', {
          meterId: this.meshNode.meterId,
          originId: message.originId,
          payload: message.payload,
        });
        // TODO: Emit event or callback for application layer
        return;
      }

      // Otherwise, forward it
      const route = this.routingProtocol.findRoute(message.destId);
      if (route) {
        logger.debug('Forwarding message to next hop', {
          meterId: this.meshNode.meterId,
          originId: message.originId,
          destId: message.destId,
          nextHop: route.nextHop,
        });
        this.forwardMessage(message);
      } else {
        logger.warn('Cannot forward message: no route available', {
          meterId: this.meshNode.meterId,
          destId: message.destId,
        });
      }
    } catch (err) {
      logger.error('Failed to parse data message', { err });
    }
  }
}
