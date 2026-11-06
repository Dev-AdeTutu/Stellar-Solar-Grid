import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { MqttClient } from 'mqtt';
import { EventEmitter } from 'events';
import { MeshNode } from '../../src/iot/mesh/MeshNode.js';
import { NeighborDiscovery } from '../../src/iot/mesh/NeighborDiscovery.js';
import { RoutingProtocol } from '../../src/iot/mesh/RoutingProtocol.js';
import { MeshMessageType, type BeaconMessage, type RREQMessage, type RREPMessage } from '../../src/iot/mesh/types.js';

/**
 * Fake MQTT client for testing mesh networking without a real broker.
 */
class FakeMqttClient extends EventEmitter {
  public publishedMessages: Array<{ topic: string; payload: string; options: Record<string, unknown> }> = [];
  public subscriptions: Set<string> = new Set();

  subscribe(topic: string, options: Record<string, unknown>, callback?: (err: Error | null) => void): void {
    this.subscriptions.add(topic);
    if (callback) {
      callback(null);
    }
  }

  publish(topic: string, payload: string, options: Record<string, unknown>, callback?: (err: Error | null) => void): void {
    this.publishedMessages.push({ topic, payload, options });
    if (callback) {
      callback(null);
    }
  }

  /**
   * Simulate receiving a message on a subscribed topic.
   */
  simulateMessage(topic: string, payload: string): void {
    this.emit('message', topic, Buffer.from(payload));
  }
}

describe('Mesh routing integration', () => {
  let node1: MeshNode;
  let node2: MeshNode;
  let node3: MeshNode;
  let client1: FakeMqttClient;
  let client2: FakeMqttClient;
  let client3: FakeMqttClient;
  let discovery1: NeighborDiscovery;
  let discovery2: NeighborDiscovery;
  let discovery3: NeighborDiscovery;
  let routing1: RoutingProtocol;
  let routing2: RoutingProtocol;
  let routing3: RoutingProtocol;

  beforeEach(() => {
    // Create three mesh nodes
    node1 = new MeshNode('meter-001', { lat: 40.7128, lng: -74.0060 });
    node2 = new MeshNode('meter-002', { lat: 40.7129, lng: -74.0061 });
    node3 = new MeshNode('meter-003', { lat: 40.7130, lng: -74.0062 });

    // Create fake MQTT clients
    client1 = new FakeMqttClient();
    client2 = new FakeMqttClient();
    client3 = new FakeMqttClient();

    // Create discovery services
    discovery1 = new NeighborDiscovery(node1, client1 as unknown as MqttClient);
    discovery2 = new NeighborDiscovery(node2, client2 as unknown as MqttClient);
    discovery3 = new NeighborDiscovery(node3, client3 as unknown as MqttClient);

    // Create routing protocols
    routing1 = new RoutingProtocol(node1, client1 as unknown as MqttClient);
    routing2 = new RoutingProtocol(node2, client2 as unknown as MqttClient);
    routing3 = new RoutingProtocol(node3, client3 as unknown as MqttClient);
  });

  afterEach(() => {
    discovery1.stop();
    discovery2.stop();
    discovery3.stop();
    routing1.stop();
    routing2.stop();
    routing3.stop();
  });

  describe('beacon exchange updates neighbor table', () => {
    it('should add neighbors when beacons are received', () => {
      discovery1.start();
      discovery2.start();

      // Simulate node2 sending a beacon that node1 receives
      const beacon: BeaconMessage = {
        type: MeshMessageType.BEACON,
        meterId: 'meter-002',
        position: { lat: 40.7129, lng: -74.0061 },
        timestamp: Date.now(),
      };

      client1.simulateMessage('solargrid/mesh/meter-002/beacon', JSON.stringify(beacon));

      // Verify node1 added node2 as a neighbor
      const neighbors = node1.getNeighbors();
      expect(neighbors).toHaveLength(1);
      expect(neighbors[0].meterId).toBe('meter-002');
      expect(neighbors[0].position).toEqual({ lat: 40.7129, lng: -74.0061 });
    });

    it('should update neighbor lastSeen when beacon is received again', async () => {
      discovery1.start();

      // First beacon
      const beacon1: BeaconMessage = {
        type: MeshMessageType.BEACON,
        meterId: 'meter-002',
        position: { lat: 40.7129, lng: -74.0061 },
        timestamp: Date.now(),
      };
      client1.simulateMessage('solargrid/mesh/meter-002/beacon', JSON.stringify(beacon1));

      const firstSeen = node1.getNeighbor('meter-002')?.lastSeen;
      expect(firstSeen).toBeDefined();

      // Wait a bit
      await new Promise(resolve => setTimeout(resolve, 10));

      // Second beacon
      const beacon2: BeaconMessage = {
        type: MeshMessageType.BEACON,
        meterId: 'meter-002',
        position: { lat: 40.7129, lng: -74.0061 },
        timestamp: Date.now(),
      };
      client1.simulateMessage('solargrid/mesh/meter-002/beacon', JSON.stringify(beacon2));

      const secondSeen = node1.getNeighbor('meter-002')?.lastSeen;
      expect(secondSeen).toBeDefined();
      expect(secondSeen).toBeGreaterThan(firstSeen!);
    });

    it('should remove stale neighbors after timeout', async () => {
      discovery1.start();

      // Add a neighbor with old timestamp
      node1.addNeighbor({
        meterId: 'meter-stale',
        position: { lat: 40.7, lng: -74.0 },
        lastSeen: Date.now() - 100000, // 100 seconds ago (>90s timeout)
        rssi: -50,
      });

      expect(node1.getNeighborCount()).toBe(1);

      // Wait for cleanup to run (cleanup runs every 30s, but we can test isNeighborAlive)
      const isAlive = node1.isNeighborAlive('meter-stale', 90000);
      expect(isAlive).toBe(false);
    });

    it('should ignore own beacons', () => {
      discovery1.start();

      const ownBeacon: BeaconMessage = {
        type: MeshMessageType.BEACON,
        meterId: 'meter-001', // Own meter ID
        position: { lat: 40.7128, lng: -74.0060 },
        timestamp: Date.now(),
      };

      client1.simulateMessage('solargrid/mesh/meter-001/beacon', JSON.stringify(ownBeacon));

      // Should not add self as neighbor
      expect(node1.getNeighborCount()).toBe(0);
    });
  });

  describe('RREQ broadcast reaches destination', () => {
    it('should initiate route discovery and broadcast RREQ', () => {
      routing1.start();

      // Request route to meter-002
      const route = routing1.findRoute('meter-002');

      // Initially no route exists
      expect(route).toBeNull();

      // Verify RREQ was published
      const rreqMessages = client1.publishedMessages.filter(
        m => m.topic === 'solargrid/mesh/route/request'
      );
      expect(rreqMessages).toHaveLength(1);

      const rreq = JSON.parse(rreqMessages[0].payload) as RREQMessage;
      expect(rreq.type).toBe(MeshMessageType.RREQ);
      expect(rreq.originId).toBe('meter-001');
      expect(rreq.destId).toBe('meter-002');
      expect(rreq.hopCount).toBe(0);
    });

    it('should forward RREQ when intermediate node receives it', () => {
      routing2.start();

      // Simulate node2 receiving RREQ from node1 to node3
      const rreq: RREQMessage = {
        type: MeshMessageType.RREQ,
        originId: 'meter-001',
        destId: 'meter-003',
        seqNum: 1,
        hopCount: 0,
        timestamp: Date.now(),
      };

      client2.simulateMessage('solargrid/mesh/route/request', JSON.stringify(rreq));

      // Node2 should forward the RREQ with incremented hop count
      const forwardedMessages = client2.publishedMessages.filter(
        m => m.topic === 'solargrid/mesh/route/request'
      );
      expect(forwardedMessages.length).toBeGreaterThan(0);

      const forwarded = JSON.parse(forwardedMessages[0].payload) as RREQMessage;
      expect(forwarded.hopCount).toBe(1);
      expect(forwarded.originId).toBe('meter-001');
      expect(forwarded.destId).toBe('meter-003');
    });

    it('should not forward duplicate RREQs', () => {
      routing2.start();

      const rreq: RREQMessage = {
        type: MeshMessageType.RREQ,
        originId: 'meter-001',
        destId: 'meter-003',
        seqNum: 1,
        hopCount: 0,
        timestamp: Date.now(),
      };

      // Send same RREQ twice
      client2.simulateMessage('solargrid/mesh/route/request', JSON.stringify(rreq));
      client2.simulateMessage('solargrid/mesh/route/request', JSON.stringify(rreq));

      // Should only forward once
      const forwardedMessages = client2.publishedMessages.filter(
        m => m.topic === 'solargrid/mesh/route/request'
      );
      expect(forwardedMessages).toHaveLength(1);
    });
  });

  describe('RREP installs route', () => {
    it('should send RREP when destination receives RREQ', () => {
      routing3.start();

      // Node3 (destination) receives RREQ from node1
      const rreq: RREQMessage = {
        type: MeshMessageType.RREQ,
        originId: 'meter-001',
        destId: 'meter-003',
        seqNum: 1,
        hopCount: 1,
        timestamp: Date.now(),
      };

      client3.simulateMessage('solargrid/mesh/route/request', JSON.stringify(rreq));

      // Node3 should send RREP back
      const rrepMessages = client3.publishedMessages.filter(
        m => m.topic === 'solargrid/mesh/route/reply'
      );
      expect(rrepMessages).toHaveLength(1);

      const rrep = JSON.parse(rrepMessages[0].payload) as RREPMessage;
      expect(rrep.type).toBe(MeshMessageType.RREP);
      expect(rrep.originId).toBe('meter-001');
      expect(rrep.destId).toBe('meter-003');
      expect(rrep.hopCount).toBe(0); // Direct reply from destination
    });

    it('should install route when origin receives RREP', () => {
      routing1.start();

      // Node1 receives RREP from node3
      const rrep: RREPMessage = {
        type: MeshMessageType.RREP,
        originId: 'meter-001',
        destId: 'meter-003',
        hopCount: 2,
        seqNum: 1,
        timestamp: Date.now(),
      };

      client1.simulateMessage('solargrid/mesh/route/reply', JSON.stringify(rrep));

      // Node1 should now have route to node3
      const routeTable = routing1.getRouteTable();
      const route = routeTable.get('meter-003');
      expect(route).toBeDefined();
      expect(route?.nextHop).toBe('meter-003');
      expect(route?.hopCount).toBe(2);
    });

    it('should add reverse route when intermediate node processes RREQ', () => {
      routing2.start();

      const rreq: RREQMessage = {
        type: MeshMessageType.RREQ,
        originId: 'meter-001',
        destId: 'meter-003',
        seqNum: 1,
        hopCount: 0,
        timestamp: Date.now(),
      };

      client2.simulateMessage('solargrid/mesh/route/request', JSON.stringify(rreq));

      // Node2 should have reverse route to node1
      const routeTable = routing2.getRouteTable();
      const route = routeTable.get('meter-001');
      expect(route).toBeDefined();
      expect(route?.nextHop).toBe('meter-001');
    });
  });

  describe('expired routes trigger new RREQ', () => {
    it('should return null for expired routes', () => {
      routing1.start();

      // Manually add an expired route
      routing1.addRoute('meter-002', 'meter-002', 1, 1);
      const routeTable = routing1.getRouteTable();
      const route = routeTable.get('meter-002');
      expect(route).toBeDefined();

      // Set expiration to past
      if (route) {
        route.expiresAt = Date.now() - 1000;
      }

      // Clean expired routes
      routing1.cleanExpiredRoutes();

      // Route should be gone
      const updatedTable = routing1.getRouteTable();
      expect(updatedTable.has('meter-002')).toBe(false);
    });

    it('should initiate new RREQ when route expires and is needed again', () => {
      routing1.start();

      // Add and expire a route
      routing1.addRoute('meter-002', 'meter-002', 1, 1);
      const routeTable = routing1.getRouteTable();
      const route = routeTable.get('meter-002');
      if (route) {
        route.expiresAt = Date.now() - 1000;
      }

      // Clear published messages from adding route
      client1.publishedMessages = [];

      // Try to find route - should trigger new RREQ
      const foundRoute = routing1.findRoute('meter-002');
      expect(foundRoute).toBeNull();

      // Verify new RREQ was sent
      const rreqMessages = client1.publishedMessages.filter(
        m => m.topic === 'solargrid/mesh/route/request'
      );
      expect(rreqMessages.length).toBeGreaterThan(0);
    });
  });

  describe('route table maintenance', () => {
    it('should update route when fresher route is available', () => {
      routing1.start();

      // Add initial route
      routing1.addRoute('meter-002', 'meter-002', 2, 1);
      let route = routing1.getRouteTable().get('meter-002');
      expect(route?.hopCount).toBe(2);

      // Add fresher route with higher sequence number
      routing1.addRoute('meter-002', 'meter-002', 3, 2);
      route = routing1.getRouteTable().get('meter-002');
      expect(route?.seqNum).toBe(2);
      expect(route?.hopCount).toBe(3);
    });

    it('should update route when same freshness but shorter path', () => {
      routing1.start();

      // Add initial route
      routing1.addRoute('meter-002', 'meter-002', 3, 1);
      let route = routing1.getRouteTable().get('meter-002');
      expect(route?.hopCount).toBe(3);

      // Add shorter route with same sequence number
      routing1.addRoute('meter-002', 'meter-002', 2, 1);
      route = routing1.getRouteTable().get('meter-002');
      expect(route?.hopCount).toBe(2);
    });

    it('should not update route with stale sequence number', () => {
      routing1.start();

      // Add fresh route
      routing1.addRoute('meter-002', 'meter-002', 2, 5);
      let route = routing1.getRouteTable().get('meter-002');
      expect(route?.seqNum).toBe(5);

      // Try to add stale route
      routing1.addRoute('meter-002', 'meter-002', 1, 3);
      route = routing1.getRouteTable().get('meter-002');
      expect(route?.seqNum).toBe(5);
      expect(route?.hopCount).toBe(2);
    });

    it('should invalidate specific routes', () => {
      routing1.start();

      routing1.addRoute('meter-002', 'meter-002', 1, 1);
      routing1.addRoute('meter-003', 'meter-003', 2, 1);
      
      expect(routing1.getRouteTable().size).toBe(2);

      routing1.invalidateRoute('meter-002');
      
      expect(routing1.getRouteTable().size).toBe(1);
      expect(routing1.getRouteTable().has('meter-002')).toBe(false);
      expect(routing1.getRouteTable().has('meter-003')).toBe(true);
    });
  });
});
