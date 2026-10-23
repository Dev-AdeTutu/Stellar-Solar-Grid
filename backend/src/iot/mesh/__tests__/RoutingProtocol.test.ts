import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { MqttClient } from 'mqtt';
import { MeshNode } from '../MeshNode.js';
import { RoutingProtocol } from '../RoutingProtocol.js';

describe('RoutingProtocol', () => {
  let meshNode: MeshNode;
  let mqttClient: MqttClient;
  let routingProtocol: RoutingProtocol;

  beforeEach(() => {
    meshNode = new MeshNode('meter-001', { lat: 40.7128, lng: -74.006 });

    // Mock MQTT client
    mqttClient = {
      subscribe: vi.fn((topic, opts, cb) => cb?.(null)),
      publish: vi.fn((topic, payload, opts, cb) => cb?.(null)),
      on: vi.fn(),
    } as unknown as MqttClient;

    routingProtocol = new RoutingProtocol(meshNode, mqttClient);
  });

  it('should create routing protocol instance', () => {
    expect(routingProtocol).toBeDefined();
  });

  it('should start and subscribe to routing topics', () => {
    routingProtocol.start();
    expect(mqttClient.subscribe).toHaveBeenCalledWith(
      'solargrid/mesh/route/request',
      { qos: 1 },
      expect.any(Function)
    );
    expect(mqttClient.subscribe).toHaveBeenCalledWith(
      'solargrid/mesh/route/reply',
      { qos: 1 },
      expect.any(Function)
    );
  });

  it('should add routes correctly', () => {
    routingProtocol.addRoute('meter-002', 'meter-003', 2, 1);
    const route = routingProtocol.findRoute('meter-002');
    expect(route).toBeDefined();
    expect(route?.nextHop).toBe('meter-003');
    expect(route?.hopCount).toBe(2);
  });

  it('should prefer fresher routes', () => {
    routingProtocol.addRoute('meter-002', 'meter-003', 2, 1);
    routingProtocol.addRoute('meter-002', 'meter-004', 3, 2);

    const route = routingProtocol.findRoute('meter-002');
    expect(route?.nextHop).toBe('meter-004');
    expect(route?.seqNum).toBe(2);
  });

  it('should prefer shorter routes with same sequence number', () => {
    routingProtocol.addRoute('meter-002', 'meter-003', 3, 1);
    routingProtocol.addRoute('meter-002', 'meter-004', 2, 1);

    const route = routingProtocol.findRoute('meter-002');
    expect(route?.nextHop).toBe('meter-004');
    expect(route?.hopCount).toBe(2);
  });

  it('should invalidate routes', () => {
    routingProtocol.addRoute('meter-002', 'meter-003', 2, 1);
    routingProtocol.invalidateRoute('meter-002');
    const route = routingProtocol.findRoute('meter-002');
    expect(route).toBeNull();
  });

  it('should clean expired routes', () => {
    routingProtocol.addRoute('meter-002', 'meter-003', 2, 1);

    // Mock expired route by manipulating time
    const routes = routingProtocol.getRouteTable();
    const route = routes.get('meter-002');
    if (route) {
      route.expiresAt = Date.now() - 1000; // Already expired
    }

    routingProtocol.cleanExpiredRoutes();
    const remainingRoute = routingProtocol.findRoute('meter-002');
    expect(remainingRoute).toBeNull();
  });

  it('should get routing table', () => {
    routingProtocol.addRoute('meter-002', 'meter-003', 2, 1);
    routingProtocol.addRoute('meter-004', 'meter-005', 1, 1);

    const routeTable = routingProtocol.getRouteTable();
    expect(routeTable.size).toBe(2);
    expect(routeTable.has('meter-002')).toBe(true);
    expect(routeTable.has('meter-004')).toBe(true);
  });
});
