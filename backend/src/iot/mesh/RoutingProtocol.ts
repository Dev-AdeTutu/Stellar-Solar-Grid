import type { MqttClient } from 'mqtt';
import { logger } from '../../lib/logger.js';
import type { MeshNode } from './MeshNode.js';
import type { RouteEntry, RREQMessage, RREPMessage } from './types.js';
import { MeshMessageType } from './types.js';

const ROUTE_TIMEOUT_MS = 300000; // 5 minutes
const CLEANUP_INTERVAL_MS = 60000; // 1 minute
const RREQ_TIMEOUT_MS = 5000; // 5 seconds

/**
 * RoutingProtocol implements AODV-inspired routing for mesh networks.
 * Handles route discovery (RREQ), route reply (RREP), and route maintenance.
 */
export class RoutingProtocol {
  private meshNode: MeshNode;
  private mqttClient: MqttClient;
  private routeTable: Map<string, RouteEntry>;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private seqNum: number = 0;
  private seenRREQs: Map<string, number>; // Key: originId-seqNum, Value: timestamp

  constructor(meshNode: MeshNode, mqttClient: MqttClient) {
    this.meshNode = meshNode;
    this.mqttClient = mqttClient;
    this.routeTable = new Map();
    this.seenRREQs = new Map();
  }

  /**
   * Start the routing protocol: subscribe to routing messages and start cleanup.
   */
  public start(): void {
    // Subscribe to route request and reply topics
    this.mqttClient.subscribe('solargrid/mesh/route/request', { qos: 1 }, (err) => {
      if (err) {
        logger.error('Failed to subscribe to RREQ topic', { err });
      } else {
        logger.info('Subscribed to RREQ topic');
      }
    });

    this.mqttClient.subscribe('solargrid/mesh/route/reply', { qos: 1 }, (err) => {
      if (err) {
        logger.error('Failed to subscribe to RREP topic', { err });
      } else {
        logger.info('Subscribed to RREP topic');
      }
    });

    // Handle incoming routing messages
    this.mqttClient.on('message', (topic, payload) => {
      if (topic === 'solargrid/mesh/route/request') {
        this.handleRREQ(payload);
      } else if (topic === 'solargrid/mesh/route/reply') {
        this.handleRREP(payload);
      }
    });

    // Start periodic cleanup of expired routes and old RREQ entries
    this.cleanupInterval = setInterval(() => {
      this.cleanExpiredRoutes();
      this.cleanOldRREQs();
    }, CLEANUP_INTERVAL_MS);

    logger.info('RoutingProtocol started', {
      meterId: this.meshNode.meterId,
      routeTimeoutMs: ROUTE_TIMEOUT_MS,
    });
  }

  /**
   * Stop the routing protocol and clean up timers.
   */
  public stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    logger.info('RoutingProtocol stopped', { meterId: this.meshNode.meterId });
  }

  /**
   * Find a route to the destination. Returns null if no route exists.
   * Initiates route discovery if no route is found.
   */
  public findRoute(destMeterId: string): RouteEntry | null {
    // Check if we have a valid route
    const route = this.routeTable.get(destMeterId);
    if (route && route.expiresAt > Date.now()) {
      logger.debug('Route found', {
        meterId: this.meshNode.meterId,
        destMeterId,
        nextHop: route.nextHop,
        hopCount: route.hopCount,
      });
      return route;
    }

    // No valid route, initiate route discovery
    logger.info('No route found, initiating discovery', {
      meterId: this.meshNode.meterId,
      destMeterId,
    });
    this.initiateRouteDiscovery(destMeterId);
    return null;
  }

  /**
   * Add or update a route in the routing table.
   */
  public addRoute(
    destMeterId: string,
    nextHop: string,
    hopCount: number,
    seqNum: number
  ): void {
    const existingRoute = this.routeTable.get(destMeterId);

    // Only update if this is a fresher route (higher seqNum) or same freshness but shorter
    if (
      !existingRoute ||
      seqNum > existingRoute.seqNum ||
      (seqNum === existingRoute.seqNum && hopCount < existingRoute.hopCount)
    ) {
      const route: RouteEntry = {
        nextHop,
        hopCount,
        seqNum,
        expiresAt: Date.now() + ROUTE_TIMEOUT_MS,
      };
      this.routeTable.set(destMeterId, route);
      logger.info('Route added/updated', {
        meterId: this.meshNode.meterId,
        destMeterId,
        nextHop,
        hopCount,
        seqNum,
      });
    }
  }

  /**
   * Invalidate a route to a destination.
   */
  public invalidateRoute(destMeterId: string): void {
    const removed = this.routeTable.delete(destMeterId);
    if (removed) {
      logger.info('Route invalidated', {
        meterId: this.meshNode.meterId,
        destMeterId,
      });
    }
  }

  /**
   * Clean up expired routes from the routing table.
   */
  public cleanExpiredRoutes(): void {
    const now = Date.now();
    let expiredCount = 0;

    for (const [destMeterId, route] of this.routeTable.entries()) {
      if (route.expiresAt <= now) {
        this.routeTable.delete(destMeterId);
        expiredCount++;
      }
    }

    if (expiredCount > 0) {
      logger.info('Cleaned expired routes', {
        meterId: this.meshNode.meterId,
        expiredCount,
        remainingRoutes: this.routeTable.size,
      });
    }
  }

  /**
   * Get the current routing table.
   */
  public getRouteTable(): Map<string, RouteEntry> {
    return new Map(this.routeTable);
  }

  /**
   * Initiate route discovery by broadcasting RREQ.
   */
  private initiateRouteDiscovery(destMeterId: string): void {
    this.seqNum++;
    const rreq: RREQMessage = {
      type: MeshMessageType.RREQ,
      originId: this.meshNode.meterId,
      destId: destMeterId,
      seqNum: this.seqNum,
      hopCount: 0,
      timestamp: Date.now(),
    };

    const payload = JSON.stringify(rreq);
    this.mqttClient.publish('solargrid/mesh/route/request', payload, { qos: 1 }, (err) => {
      if (err) {
        logger.error('Failed to publish RREQ', { destMeterId, err });
      } else {
        logger.debug('Published RREQ', {
          meterId: this.meshNode.meterId,
          destMeterId,
          seqNum: this.seqNum,
        });
      }
    });

    // Record that we've seen this RREQ
    const rreqKey = `${rreq.originId}-${rreq.seqNum}`;
    this.seenRREQs.set(rreqKey, Date.now());
  }

  /**
   * Handle incoming RREQ message.
   */
  private handleRREQ(payload: Buffer): void {
    try {
      const rreq = JSON.parse(payload.toString()) as RREQMessage;

      // Ignore RREQs from ourselves
      if (rreq.originId === this.meshNode.meterId) {
        return;
      }

      // Check if we've already seen this RREQ (deduplication)
      const rreqKey = `${rreq.originId}-${rreq.seqNum}`;
      if (this.seenRREQs.has(rreqKey)) {
        logger.debug('Duplicate RREQ ignored', {
          meterId: this.meshNode.meterId,
          rreqKey,
        });
        return;
      }

      // Record that we've seen this RREQ
      this.seenRREQs.set(rreqKey, Date.now());

      // Add reverse route to origin
      this.addRoute(rreq.originId, rreq.originId, rreq.hopCount + 1, rreq.seqNum);

      logger.debug('Processing RREQ', {
        meterId: this.meshNode.meterId,
        rreq,
      });

      // If we are the destination or have a route to destination, send RREP
      if (rreq.destId === this.meshNode.meterId) {
        this.sendRREP(rreq.originId, rreq.seqNum, 0);
      } else {
        const route = this.routeTable.get(rreq.destId);
        if (route && route.expiresAt > Date.now()) {
          this.sendRREP(rreq.originId, rreq.seqNum, route.hopCount);
        } else {
          // Forward RREQ
          this.forwardRREQ(rreq);
        }
      }
    } catch (err) {
      logger.error('Failed to parse RREQ message', { err });
    }
  }

  /**
   * Forward RREQ to neighbors.
   */
  private forwardRREQ(rreq: RREQMessage): void {
    const forwardedRREQ: RREQMessage = {
      ...rreq,
      hopCount: rreq.hopCount + 1,
      timestamp: Date.now(),
    };

    const payload = JSON.stringify(forwardedRREQ);
    this.mqttClient.publish('solargrid/mesh/route/request', payload, { qos: 1 }, (err) => {
      if (err) {
        logger.error('Failed to forward RREQ', { rreq, err });
      } else {
        logger.debug('Forwarded RREQ', {
          meterId: this.meshNode.meterId,
          rreq: forwardedRREQ,
        });
      }
    });
  }

  /**
   * Send RREP back to origin.
   */
  private sendRREP(originId: string, seqNum: number, hopCount: number): void {
    const rrep: RREPMessage = {
      type: MeshMessageType.RREP,
      originId,
      destId: this.meshNode.meterId,
      hopCount,
      seqNum,
      timestamp: Date.now(),
    };

    const payload = JSON.stringify(rrep);
    this.mqttClient.publish('solargrid/mesh/route/reply', payload, { qos: 1 }, (err) => {
      if (err) {
        logger.error('Failed to publish RREP', { originId, err });
      } else {
        logger.debug('Published RREP', {
          meterId: this.meshNode.meterId,
          originId,
          seqNum,
        });
      }
    });
  }

  /**
   * Handle incoming RREP message.
   */
  private handleRREP(payload: Buffer): void {
    try {
      const rrep = JSON.parse(payload.toString()) as RREPMessage;

      // Ignore RREPs not destined for us and not originated by us
      if (rrep.originId !== this.meshNode.meterId && rrep.destId === this.meshNode.meterId) {
        return;
      }

      logger.debug('Processing RREP', {
        meterId: this.meshNode.meterId,
        rrep,
      });

      // If we are the origin, install the route
      if (rrep.originId === this.meshNode.meterId) {
        this.addRoute(rrep.destId, rrep.destId, rrep.hopCount, rrep.seqNum);
        logger.info('Route established via RREP', {
          meterId: this.meshNode.meterId,
          destId: rrep.destId,
          hopCount: rrep.hopCount,
        });
      } else {
        // Forward RREP toward origin
        const routeToOrigin = this.routeTable.get(rrep.originId);
        if (routeToOrigin) {
          // Add route to destination
          this.addRoute(rrep.destId, rrep.destId, rrep.hopCount + 1, rrep.seqNum);

          // Forward RREP
          const forwardedRREP: RREPMessage = {
            ...rrep,
            hopCount: rrep.hopCount + 1,
            timestamp: Date.now(),
          };
          const payload = JSON.stringify(forwardedRREP);
          this.mqttClient.publish('solargrid/mesh/route/reply', payload, { qos: 1 }, (err) => {
            if (err) {
              logger.error('Failed to forward RREP', { rrep, err });
            } else {
              logger.debug('Forwarded RREP', {
                meterId: this.meshNode.meterId,
                rrep: forwardedRREP,
              });
            }
          });
        }
      }
    } catch (err) {
      logger.error('Failed to parse RREP message', { err });
    }
  }

  /**
   * Clean up old RREQ entries to prevent memory bloat.
   */
  private cleanOldRREQs(): void {
    const now = Date.now();
    let cleanedCount = 0;

    for (const [key, timestamp] of this.seenRREQs.entries()) {
      if (now - timestamp > RREQ_TIMEOUT_MS) {
        this.seenRREQs.delete(key);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      logger.debug('Cleaned old RREQ entries', {
        meterId: this.meshNode.meterId,
        cleanedCount,
        remainingRREQs: this.seenRREQs.size,
      });
    }
  }
}
