import type { MeshNode } from './MeshNode.js';
import type { RoutingProtocol } from './RoutingProtocol.js';
import { logger } from '../../lib/logger.js';

export interface HealthStatus {
  meterId: string;
  isHealthy: boolean;
  neighborCount: number;
  routeCount: number;
  failedNeighbors: string[];
  weakSignals: string[];
  timestamp: number;
}

const HEALTH_CHECK_INTERVAL_MS = 60000; // 1 minute
const WEAK_SIGNAL_THRESHOLD = -80; // dBm

/**
 * HealthMonitor continuously monitors the health of the mesh node.
 * Detects node failures, weak signals, and connectivity issues.
 */
export class HealthMonitor {
  private meshNode: MeshNode;
  private routingProtocol: RoutingProtocol;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private onHealthChange?: (status: HealthStatus) => void;

  constructor(
    meshNode: MeshNode,
    routingProtocol: RoutingProtocol,
    onHealthChange?: (status: HealthStatus) => void
  ) {
    this.meshNode = meshNode;
    this.routingProtocol = routingProtocol;
    this.onHealthChange = onHealthChange;
  }

  /**
   * Start health monitoring.
   */
  public start(): void {
    this.healthCheckInterval = setInterval(() => {
      this.performHealthCheck();
    }, HEALTH_CHECK_INTERVAL_MS);

    // Perform initial health check
    this.performHealthCheck();

    logger.info('HealthMonitor started', {
      meterId: this.meshNode.meterId,
      intervalMs: HEALTH_CHECK_INTERVAL_MS,
    });
  }

  /**
   * Stop health monitoring.
   */
  public stop(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    logger.info('HealthMonitor stopped', { meterId: this.meshNode.meterId });
  }

  /**
   * Perform a health check and emit status.
   */
  private performHealthCheck(): void {
    const neighbors = this.meshNode.getNeighbors();
    const routes = this.routingProtocol.getRouteTable();

    const failedNeighbors: string[] = [];
    const weakSignals: string[] = [];

    // Check each neighbor's health
    for (const neighbor of neighbors) {
      if (!this.meshNode.isNeighborAlive(neighbor.meterId)) {
        failedNeighbors.push(neighbor.meterId);
      }

      if (neighbor.rssi < WEAK_SIGNAL_THRESHOLD) {
        weakSignals.push(neighbor.meterId);
      }
    }

    const neighborCount = neighbors.length;
    const routeCount = routes.size;
    const isHealthy = neighborCount > 0 && failedNeighbors.length === 0;

    const status: HealthStatus = {
      meterId: this.meshNode.meterId,
      isHealthy,
      neighborCount,
      routeCount,
      failedNeighbors,
      weakSignals,
      timestamp: Date.now(),
    };

    // Log health issues
    if (!isHealthy) {
      logger.warn('Health check detected issues', {
        meterId: this.meshNode.meterId,
        failedNeighbors,
        weakSignals,
        neighborCount,
      });
    } else if (weakSignals.length > 0) {
      logger.info('Health check: weak signals detected', {
        meterId: this.meshNode.meterId,
        weakSignals,
      });
    }

    // Emit health status change
    if (this.onHealthChange) {
      this.onHealthChange(status);
    }
  }

  /**
   * Get current health status on demand.
   */
  public getHealthStatus(): HealthStatus {
    const neighbors = this.meshNode.getNeighbors();
    const routes = this.routingProtocol.getRouteTable();

    const failedNeighbors: string[] = [];
    const weakSignals: string[] = [];

    for (const neighbor of neighbors) {
      if (!this.meshNode.isNeighborAlive(neighbor.meterId)) {
        failedNeighbors.push(neighbor.meterId);
      }

      if (neighbor.rssi < WEAK_SIGNAL_THRESHOLD) {
        weakSignals.push(neighbor.meterId);
      }
    }

    const neighborCount = neighbors.length;
    const routeCount = routes.size;
    const isHealthy = neighborCount > 0 && failedNeighbors.length === 0;

    return {
      meterId: this.meshNode.meterId,
      isHealthy,
      neighborCount,
      routeCount,
      failedNeighbors,
      weakSignals,
      timestamp: Date.now(),
    };
  }
}
