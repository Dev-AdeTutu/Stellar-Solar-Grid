import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { MqttClient } from 'mqtt';
import { MeshNode } from '../MeshNode.js';
import { NeighborDiscovery } from '../NeighborDiscovery.js';
import { RoutingProtocol } from '../RoutingProtocol.js';
import { MessageForwarder } from '../MessageForwarder.js';
import { TopologyManager } from '../TopologyManager.js';
import { HealthMonitor } from '../HealthMonitor.js';
import { NetworkHealer } from '../NetworkHealer.js';

describe('Mesh Network Integration', () => {
  let meshNode: MeshNode;
  let mqttClient: MqttClient;
  let neighborDiscovery: NeighborDiscovery;
  let routingProtocol: RoutingProtocol;
  let messageForwarder: MessageForwarder;
  let topologyManager: TopologyManager;
  let healthMonitor: HealthMonitor;
  let networkHealer: NetworkHealer;

  beforeEach(() => {
    meshNode = new MeshNode('meter-001', { lat: 40.7128, lng: -74.006 });

    // Mock MQTT client
    mqttClient = {
      subscribe: vi.fn((topic, opts, cb) => cb?.(null)),
      publish: vi.fn((topic, payload, opts, cb) => cb?.(null)),
      on: vi.fn(),
    } as unknown as MqttClient;

    neighborDiscovery = new NeighborDiscovery(meshNode, mqttClient);
    routingProtocol = new RoutingProtocol(meshNode, mqttClient);
    messageForwarder = new MessageForwarder(meshNode, mqttClient, routingProtocol);
    topologyManager = new TopologyManager(meshNode, routingProtocol);
    healthMonitor = new HealthMonitor(meshNode, routingProtocol);
    networkHealer = new NetworkHealer(meshNode, routingProtocol, healthMonitor);
  });

  it('should initialize all mesh components', () => {
    expect(meshNode).toBeDefined();
    expect(neighborDiscovery).toBeDefined();
    expect(routingProtocol).toBeDefined();
    expect(messageForwarder).toBeDefined();
    expect(topologyManager).toBeDefined();
    expect(healthMonitor).toBeDefined();
    expect(networkHealer).toBeDefined();
  });

  it('should start all components successfully', () => {
    neighborDiscovery.start();
    routingProtocol.start();
    messageForwarder.start();
    healthMonitor.start();
    networkHealer.start();

    expect(mqttClient.subscribe).toHaveBeenCalled();
    expect(mqttClient.on).toHaveBeenCalled();
  });

  it('should form a mesh network with neighbors', () => {
    // Add some neighbors
    meshNode.addNeighbor({
      meterId: 'meter-002',
      position: { lat: 40.7138, lng: -74.007 },
      lastSeen: Date.now(),
      rssi: -60,
    });

    meshNode.addNeighbor({
      meterId: 'meter-003',
      position: { lat: 40.7148, lng: -74.008 },
      lastSeen: Date.now(),
      rssi: -65,
    });

    const topology = topologyManager.getTopology();
    expect(topology.nodes.size).toBe(2);
    expect(topology.nodes.has('meter-002')).toBe(true);
    expect(topology.nodes.has('meter-003')).toBe(true);
  });

  it('should discover and establish routes', () => {
    routingProtocol.addRoute('meter-002', 'meter-002', 1, 1);
    routingProtocol.addRoute('meter-003', 'meter-002', 2, 1);

    const stats = topologyManager.getTopologyStats();
    expect(stats.routeCount).toBe(2);
    expect(stats.avgHopCount).toBeGreaterThan(0);
    expect(stats.coverage).toContain('meter-002');
    expect(stats.coverage).toContain('meter-003');
  });

  it('should detect network connectivity', () => {
    // Isolated node
    expect(topologyManager.isNetworkConnected()).toBe(false);

    // Add a neighbor
    meshNode.addNeighbor({
      meterId: 'meter-002',
      position: { lat: 40.7138, lng: -74.007 },
      lastSeen: Date.now(),
      rssi: -60,
    });

    expect(topologyManager.isNetworkConnected()).toBe(true);
  });

  it('should monitor node health', () => {
    meshNode.addNeighbor({
      meterId: 'meter-002',
      position: { lat: 40.7138, lng: -74.007 },
      lastSeen: Date.now(),
      rssi: -60,
    });

    const health = healthMonitor.getHealthStatus();
    expect(health.meterId).toBe('meter-001');
    expect(health.neighborCount).toBe(1);
    expect(health.isHealthy).toBe(true);
  });

  it('should suggest topology optimizations', () => {
    // Isolated node should get high-priority suggestion
    const suggestions = topologyManager.suggestOptimizations();
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions[0].priority).toBe('high');
    expect(suggestions[0].type).toBe('connectivity');
  });

  it('should self-heal on node failure', () => {
    // Setup a route through a neighbor
    meshNode.addNeighbor({
      meterId: 'meter-002',
      position: { lat: 40.7138, lng: -74.007 },
      lastSeen: Date.now(),
      rssi: -60,
    });

    routingProtocol.addRoute('meter-003', 'meter-002', 2, 1);

    // Trigger healing for the failed route
    networkHealer.healRoute('meter-003');

    // Route should be invalidated
    const route = routingProtocol.findRoute('meter-003');
    expect(route).toBeNull();
  });

  it('should stop all components cleanly', () => {
    neighborDiscovery.start();
    routingProtocol.start();
    messageForwarder.start();
    healthMonitor.start();
    networkHealer.start();

    neighborDiscovery.stop();
    routingProtocol.stop();
    healthMonitor.stop();
    networkHealer.stop();

    // Components should stop without errors
    expect(true).toBe(true);
  });
});
