import type { MeshNode } from './MeshNode.js';
import type { RoutingProtocol } from './RoutingProtocol.js';
import type { HealthMonitor, HealthStatus } from './HealthMonitor.js';
import { logger } from '../../lib/logger.js';

/**
 * NetworkHealer implements self-healing logic for the mesh network.
 * Automatically responds to node failures and network partitions by
 * invalidating stale routes and triggering route rediscovery.
 */
export class NetworkHealer {
  private meshNode: MeshNode;
  private routingProtocol: RoutingProtocol;
  private healthMonitor: HealthMonitor;
  private lastHealthStatus: HealthStatus | null = null;

  constructor(
    meshNode: MeshNode,
    routingProtocol: RoutingProtocol,
    healthMonitor: HealthMonitor
  ) {
    this.meshNode = meshNode;
    this.routingProtocol = routingProtocol;
    this.healthMonitor = healthMonitor;
  }

  /**
   * Start the network healer by monitoring health changes.
   */
  public start(): void {
    // Subscribe to health changes
    this.healthMonitor['onHealthChange'] = (status: HealthStatus) => {
      this.handleHealthChange(status);
    };

    logger.info('NetworkHealer started', { meterId: this.meshNode.meterId });
  }

  /**
   * Stop the network healer.
   */
  public stop(): void {
    this.healthMonitor['onHealthChange'] = undefined;
    logger.info('NetworkHealer stopped', { meterId: this.meshNode.meterId });
  }

  /**
   * Handle health status changes and trigger healing actions.
   */
  private handleHealthChange(status: HealthStatus): void {
    // First health check, just store it
    if (!this.lastHealthStatus) {
      this.lastHealthStatus = status;
      return;
    }

    // Detect newly failed neighbors
    const newlyFailed = status.failedNeighbors.filter(
      (id) => !this.lastHealthStatus!.failedNeighbors.includes(id)
    );

    if (newlyFailed.length > 0) {
      logger.warn('Node failures detected, initiating self-healing', {
        meterId: this.meshNode.meterId,
        failedNeighbors: newlyFailed,
      });
      this.healFailedNeighbors(newlyFailed);
    }

    // Detect network isolation
    if (!status.isHealthy && this.lastHealthStatus.isHealthy) {
      logger.error('Network isolation detected', {
        meterId: this.meshNode.meterId,
        neighborCount: status.neighborCount,
      });
      this.healNetworkIsolation();
    }

    // Detect recovery from isolation
    if (status.isHealthy && !this.lastHealthStatus.isHealthy) {
      logger.info('Network connectivity restored', {
        meterId: this.meshNode.meterId,
        neighborCount: status.neighborCount,
      });
    }

    this.lastHealthStatus = status;
  }

  /**
   * Heal routes affected by failed neighbors.
   * Invalidates routes that depend on failed nodes and triggers rediscovery.
   */
  private healFailedNeighbors(failedNeighbors: string[]): void {
    const routes = this.routingProtocol.getRouteTable();
    const affectedRoutes: string[] = [];

    // Find routes that use failed neighbors as next hop
    for (const [destMeterId, route] of routes.entries()) {
      if (failedNeighbors.includes(route.nextHop)) {
        affectedRoutes.push(destMeterId);
      }
    }

    // Invalidate affected routes
    for (const destMeterId of affectedRoutes) {
      this.routingProtocol.invalidateRoute(destMeterId);
      logger.info('Invalidated route due to neighbor failure', {
        meterId: this.meshNode.meterId,
        destMeterId,
      });
    }

    // Remove failed neighbors from neighbor table
    for (const failedId of failedNeighbors) {
      this.meshNode.removeNeighbor(failedId);
    }

    logger.info('Self-healing completed for failed neighbors', {
      meterId: this.meshNode.meterId,
      failedNeighbors,
      affectedRoutes,
    });
  }

  /**
   * Attempt to heal network isolation.
   * Triggers aggressive route discovery and neighbor scanning.
   */
  private healNetworkIsolation(): void {
    // Clear all routes to force fresh discovery
    const routes = this.routingProtocol.getRouteTable();
    for (const destMeterId of routes.keys()) {
      this.routingProtocol.invalidateRoute(destMeterId);
    }

    logger.warn('Cleared all routes due to network isolation', {
      meterId: this.meshNode.meterId,
    });

    // The neighbor discovery and routing protocol will automatically
    // rediscover neighbors and routes through their periodic beacons
    // and route request mechanisms
  }

  /**
   * Manually trigger self-healing for a specific destination.
   * Useful for application-level recovery.
   */
  public healRoute(destMeterId: string): void {
    logger.info('Manual route healing triggered', {
      meterId: this.meshNode.meterId,
      destMeterId,
    });

    this.routingProtocol.invalidateRoute(destMeterId);
    // The routing protocol will rediscover the route on next findRoute call
  }

  /**
   * Get healing statistics.
   */
  public getHealingStats(): {
    lastHealthCheck: number | null;
    isHealthy: boolean;
    healingActions: number;
  } {
    return {
      lastHealthCheck: this.lastHealthStatus?.timestamp ?? null,
      isHealthy: this.lastHealthStatus?.isHealthy ?? false,
      healingActions: 0, // Could track this with a counter
    };
  }
}
