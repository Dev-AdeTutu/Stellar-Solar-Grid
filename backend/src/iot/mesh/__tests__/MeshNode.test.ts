import { describe, it, expect, beforeEach } from 'vitest';
import { MeshNode } from '../MeshNode.js';
import type { Neighbor } from '../types.js';

describe('MeshNode', () => {
  let meshNode: MeshNode;

  beforeEach(() => {
    meshNode = new MeshNode('meter-001', { lat: 40.7128, lng: -74.006 });
  });

  it('should create a mesh node with correct properties', () => {
    expect(meshNode.meterId).toBe('meter-001');
    expect(meshNode.position).toEqual({ lat: 40.7128, lng: -74.006 });
    expect(meshNode.getNeighborCount()).toBe(0);
  });

  it('should add neighbors correctly', () => {
    const neighbor: Neighbor = {
      meterId: 'meter-002',
      position: { lat: 40.7138, lng: -74.007 },
      lastSeen: Date.now(),
      rssi: -60,
    };

    meshNode.addNeighbor(neighbor);
    expect(meshNode.getNeighborCount()).toBe(1);
    expect(meshNode.getNeighbor('meter-002')).toEqual(neighbor);
  });

  it('should remove neighbors correctly', () => {
    const neighbor: Neighbor = {
      meterId: 'meter-002',
      position: { lat: 40.7138, lng: -74.007 },
      lastSeen: Date.now(),
      rssi: -60,
    };

    meshNode.addNeighbor(neighbor);
    meshNode.removeNeighbor('meter-002');
    expect(meshNode.getNeighborCount()).toBe(0);
    expect(meshNode.getNeighbor('meter-002')).toBeUndefined();
  });

  it('should update neighbor information', () => {
    const neighbor: Neighbor = {
      meterId: 'meter-002',
      position: { lat: 40.7138, lng: -74.007 },
      lastSeen: Date.now(),
      rssi: -60,
    };

    meshNode.addNeighbor(neighbor);
    meshNode.updateNeighbor('meter-002', { rssi: -70 });

    const updated = meshNode.getNeighbor('meter-002');
    expect(updated?.rssi).toBe(-70);
  });

  it('should detect alive neighbors correctly', () => {
    const neighbor: Neighbor = {
      meterId: 'meter-002',
      position: { lat: 40.7138, lng: -74.007 },
      lastSeen: Date.now(),
      rssi: -60,
    };

    meshNode.addNeighbor(neighbor);
    expect(meshNode.isNeighborAlive('meter-002')).toBe(true);
  });

  it('should detect dead neighbors correctly', () => {
    const neighbor: Neighbor = {
      meterId: 'meter-002',
      position: { lat: 40.7138, lng: -74.007 },
      lastSeen: Date.now() - 100000, // 100 seconds ago
      rssi: -60,
    };

    meshNode.addNeighbor(neighbor);
    expect(meshNode.isNeighborAlive('meter-002', 90000)).toBe(false);
  });

  it('should get all neighbors', () => {
    const neighbor1: Neighbor = {
      meterId: 'meter-002',
      position: { lat: 40.7138, lng: -74.007 },
      lastSeen: Date.now(),
      rssi: -60,
    };

    const neighbor2: Neighbor = {
      meterId: 'meter-003',
      position: { lat: 40.7148, lng: -74.008 },
      lastSeen: Date.now(),
      rssi: -65,
    };

    meshNode.addNeighbor(neighbor1);
    meshNode.addNeighbor(neighbor2);

    const neighbors = meshNode.getNeighbors();
    expect(neighbors).toHaveLength(2);
    expect(neighbors.map((n) => n.meterId)).toContain('meter-002');
    expect(neighbors.map((n) => n.meterId)).toContain('meter-003');
  });
});
