import { logger } from '../../lib/logger.js';
import type { Neighbor, Position } from './types.js';

/**
 * MeshNode represents a single meter in the mesh network.
 * Tracks neighbors, signal strength, and last-seen timestamps.
 */
export class MeshNode {
  public readonly meterId: string;
  public readonly position: Position;
  private neighbors: Map<string, Neighbor>;

  constructor(meterId: string, position: Position) {
    this.meterId = meterId;
    this.position = position;
    this.neighbors = new Map();
    logger.info('MeshNode created', { meterId, position });
  }

  /**
   * Add a new neighbor to this node's neighbor table.
   */
  public addNeighbor(neighbor: Neighbor): void {
    this.neighbors.set(neighbor.meterId, neighbor);
    logger.debug('Added neighbor', {
      meterId: this.meterId,
      neighborId: neighbor.meterId,
      rssi: neighbor.rssi,
    });
  }

  /**
   * Remove a neighbor from this node's neighbor table.
   */
  public removeNeighbor(neighborId: string): void {
    const removed = this.neighbors.delete(neighborId);
    if (removed) {
      logger.debug('Removed neighbor', {
        meterId: this.meterId,
        neighborId,
      });
    }
  }

  /**
   * Get all current neighbors.
   */
  public getNeighbors(): Neighbor[] {
    return Array.from(this.neighbors.values());
  }

  /**
   * Update an existing neighbor's information.
   */
  public updateNeighbor(neighborId: string, updates: Partial<Neighbor>): void {
    const existing = this.neighbors.get(neighborId);
    if (existing) {
      const updated = { ...existing, ...updates };
      this.neighbors.set(neighborId, updated);
      logger.debug('Updated neighbor', {
        meterId: this.meterId,
        neighborId,
        updates,
      });
    }
  }

  /**
   * Check if a neighbor is still alive based on timeout.
   * @param neighborId The neighbor to check
   * @param timeoutMs Maximum time since last seen (default 90000ms)
   * @returns true if the neighbor is still alive, false otherwise
   */
  public isNeighborAlive(neighborId: string, timeoutMs: number = 90000): boolean {
    const neighbor = this.neighbors.get(neighborId);
    if (!neighbor) {
      return false;
    }
    const now = Date.now();
    const isAlive = now - neighbor.lastSeen < timeoutMs;
    if (!isAlive) {
      logger.debug('Neighbor timeout detected', {
        meterId: this.meterId,
        neighborId,
        lastSeen: neighbor.lastSeen,
        timeoutMs,
      });
    }
    return isAlive;
  }

  /**
   * Get a specific neighbor by ID.
   */
  public getNeighbor(neighborId: string): Neighbor | undefined {
    return this.neighbors.get(neighborId);
  }

  /**
   * Get the count of active neighbors.
   */
  public getNeighborCount(): number {
    return this.neighbors.size;
  }
}
