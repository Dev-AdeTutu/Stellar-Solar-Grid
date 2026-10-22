import type { MeshNode } from './MeshNode.js';
import type { RoutingProtocol } from './RoutingProtocol.js';
import type { MeshTopology } from './types.js';
import { logger } from '../../lib/logger.js';

/**
 * TopologyManager provides a centralized view of the mesh network topology.
 * Aggregates neighbor and routing information for monitoring and optimization.
 */
export class TopologyManager {
  private meshNode: MeshNode;
  private routingProtocol: RoutingProtocol;

  constructor(meshNode: MeshNode, routingProtocol: RoutingProtocol) {
    this.meshNode = meshNode;
    this.routingProtocol = routingProtocol;
  }

  /**
   * Get the current mesh topology snapshot.
   */
  public getTopology(): MeshTopology {
    const neighbors = this.meshNode.getNeighbors();
    const routes = this.routingProtocol.getRouteTable();

    const topology: MeshTopology = {
      nodes: new Map(neighbors.map((n) => [n.meterId, n])),
      routes,
      lastUpdate: Date.now(),
    };

    logger.debug('Topology snapshot created', {
      meterId: this.meshNode.meterId,
      neighborCount: topology.nodes.size,
      routeCount: topology.routes.size,
    });

    return topology;
  }

  /**
   * Get topology statistics for monitoring.
   */
  public getTopologyStats(): {
    meterId: string;
    neighborCount: number;
    routeCount: number;
    avgHopCount: number;
    maxHopCount: number;
    coverage: string[];
  } {
    const neighbors = this.meshNode.getNeighbors();
    const routes = this.routingProtocol.getRouteTable();

    const hopCounts = Array.from(routes.values()).map((r) => r.hopCount);
    const avgHopCount = hopCounts.length
      ? hopCounts.reduce((a, b) => a + b, 0) / hopCounts.length
      : 0;
    const maxHopCount = hopCounts.length ? Math.max(...hopCounts) : 0;

    const coverage = Array.from(routes.keys());

    return {
      meterId: this.meshNode.meterId,
      neighborCount: neighbors.length,
      routeCount: routes.size,
      avgHopCount: Math.round(avgHopCount * 100) / 100,
      maxHopCount,
      coverage,
    };
  }

  /**
   * Check network connectivity: are there isolated nodes?
   */
  public isNetworkConnected(): boolean {
    const neighborCount = this.meshNode.getNeighborCount();
    return neighborCount > 0;
  }

  /**
   * Get list of reachable meters.
   */
  public getReachableMeters(): string[] {
    const routes = this.routingProtocol.getRouteTable();
    return Array.from(routes.keys());
  }

  /**
   * Optimize topology by suggesting better routes based on signal strength.
   * This is a placeholder for future optimization algorithms.
   */
  public suggestOptimizations(): Array<{
    type: string;
    suggestion: string;
    priority: 'low' | 'medium' | 'high';
  }> {
    const suggestions: Array<{
      type: string;
      suggestion: string;
      priority: 'low' | 'medium' | 'high';
    }> = [];

    const neighborCount = this.meshNode.getNeighborCount();

    // Check for isolation risk
    if (neighborCount === 0) {
      suggestions.push({
        type: 'connectivity',
        suggestion: 'Node is isolated. Consider adding relay nodes nearby.',
        priority: 'high',
      });
    } else if (neighborCount === 1) {
      suggestions.push({
        type: 'redundancy',
        suggestion: 'Node has only one neighbor. Add more neighbors for redundancy.',
        priority: 'medium',
      });
    }

    // Check for weak signals
    const neighbors = this.meshNode.getNeighbors();
    const weakNeighbors = neighbors.filter((n) => n.rssi < -80);
    if (weakNeighbors.length > 0) {
      suggestions.push({
        type: 'signal-strength',
        suggestion: `${weakNeighbors.length} neighbor(s) have weak signal. Consider repositioning or adding relay nodes.`,
        priority: 'medium',
      });
    }

    // Check route efficiency
    const stats = this.getTopologyStats();
    if (stats.maxHopCount > 5) {
      suggestions.push({
        type: 'efficiency',
        suggestion: `Maximum hop count is ${stats.maxHopCount}. Consider adding shortcut routes.`,
        priority: 'low',
      });
    }

    return suggestions;
  }
}
