# IoT Mesh Network Documentation

## Overview

The Stellar Solar Grid IoT Mesh Network implements a self-organizing, self-healing mesh topology that eliminates single points of failure and enables direct peer-to-peer communication between smart meters.

## Architecture

### Core Components

1. **MeshNode** - Represents individual smart meters in the network
2. **NeighborDiscovery** - Handles beacon broadcasting and peer discovery
3. **RoutingProtocol** - Implements AODV-inspired routing for route discovery
4. **MessageForwarder** - Manages multi-hop message forwarding
5. **TopologyManager** - Provides network topology monitoring and optimization
6. **HealthMonitor** - Continuously monitors node and network health
7. **NetworkHealer** - Implements self-healing logic for automatic recovery

### Network Topology

The mesh network uses an **ad-hoc, peer-to-peer topology** where:
- Each meter can communicate directly with nearby peers (neighbors)
- Messages can traverse multiple hops to reach distant destinations
- No central hub or coordinator is required
- Network automatically reorganizes when nodes join or leave

```
Meter A ←→ Meter B ←→ Meter C
    ↕           ↕           ↕
Meter D ←→ Meter E ←→ Meter F
```

## Protocol Specification

### AODV-Inspired Routing

The routing protocol is based on Ad-hoc On-Demand Distance Vector (AODV) with the following characteristics:

#### Route Discovery (RREQ/RREP)
- **Route Request (RREQ)**: Broadcast when a node needs a route to a destination
- **Route Reply (RREP)**: Unicast back to the origin when destination is found
- **Sequence Numbers**: Ensure route freshness
- **Hop Count**: Tracks route distance
- **Route Timeout**: Routes expire after 5 minutes of inactivity

#### Message Types

1. **BEACON** - Periodic announcements for neighbor discovery
   ```typescript
   {
     type: 'BEACON',
     meterId: string,
     position: { lat: number, lng: number },
     timestamp: number
   }
   ```

2. **RREQ** - Route request for discovering paths
   ```typescript
   {
     type: 'RREQ',
     originId: string,
     destId: string,
     seqNum: number,
     hopCount: number,
     timestamp: number
   }
   ```

3. **RREP** - Route reply for establishing paths
   ```typescript
   {
     type: 'RREP',
     originId: string,
     destId: string,
     hopCount: number,
     seqNum: number,
     timestamp: number
   }
   ```

4. **DATA** - Application data messages
   ```typescript
   {
     type: 'DATA',
     originId: string,
     destId: string,
     payload: unknown,
     timestamp: number
   }
   ```

### MQTT Topics

- **Beacons**: `solargrid/mesh/{meterId}/beacon`
- **Route Requests**: `solargrid/mesh/route/request`
- **Route Replies**: `solargrid/mesh/route/reply`
- **Data Messages**: `solargrid/mesh/data`

## Self-Healing Mechanisms

### Automatic Failure Detection

The **HealthMonitor** component continuously checks:
- **Neighbor Liveness**: Beacons must be received within 90 seconds
- **Signal Strength**: RSSI values below -80 dBm trigger warnings
- **Network Connectivity**: At least one neighbor required for healthy status

### Healing Actions

When failures are detected, the **NetworkHealer** automatically:

1. **Neighbor Failure**
   - Removes failed neighbor from neighbor table
   - Invalidates routes using failed neighbor as next hop
   - Triggers route rediscovery for affected destinations

2. **Network Isolation**
   - Clears all stale routes
   - Intensifies beacon broadcasting
   - Awaits new neighbor discoveries

3. **Manual Healing**
   - API endpoint allows manual healing trigger
   - Useful for testing or maintenance scenarios

### Recovery Time

- **Neighbor Detection**: 30-90 seconds (beacon interval)
- **Route Rediscovery**: 5-10 seconds (RREQ/RREP exchange)
- **Total Recovery**: Typically under 2 minutes

## Multi-Hop Communication

### Message Forwarding

The **MessageForwarder** component handles multi-hop routing:

1. **Origin Node**: Looks up route to destination
2. **Intermediate Nodes**: Forward based on routing table
3. **Destination Node**: Delivers message to application layer

### Deduplication

- Each message has unique `originId-timestamp` key
- Forwarding nodes maintain recent message cache
- Prevents routing loops and duplicate deliveries

### Example Flow

```
Meter A → (2 hops) → Meter B → (1 hop) → Meter C
```

1. Meter A sends DATA message destined for Meter C
2. Meter A forwards to Meter B (next hop from routing table)
3. Meter B recognizes it's not the destination
4. Meter B forwards to Meter C (next hop from its routing table)
5. Meter C receives and delivers the message

## Configuration

### Timing Parameters

```typescript
// Neighbor Discovery
BEACON_INTERVAL_MS = 30000      // 30 seconds
NEIGHBOR_TIMEOUT_MS = 90000     // 90 seconds

// Routing Protocol
ROUTE_TIMEOUT_MS = 300000       // 5 minutes
RREQ_TIMEOUT_MS = 5000          // 5 seconds
CLEANUP_INTERVAL_MS = 60000     // 1 minute

// Health Monitoring
HEALTH_CHECK_INTERVAL_MS = 60000  // 1 minute
WEAK_SIGNAL_THRESHOLD = -80       // dBm
```

### MQTT Configuration

```typescript
{
  qos: 1,  // At least once delivery
  retain: false
}
```

## API Endpoints

### GET /api/mesh/status
Get overall mesh network status.

**Response:**
```json
{
  "enabled": true,
  "totalNodes": 15,
  "healthyNodes": 14,
  "timestamp": 1234567890
}
```

### GET /api/mesh/topology
Get full network topology.

**Response:**
```json
{
  "nodes": [
    {
      "meterId": "meter-001",
      "position": { "lat": 40.7128, "lng": -74.0060 },
      "neighborCount": 3,
      "routeCount": 5,
      "isHealthy": true
    }
  ],
  "timestamp": 1234567890
}
```

### GET /api/mesh/node/:meterId
Get details for a specific node.

**Response:**
```json
{
  "meterId": "meter-001",
  "position": { "lat": 40.7128, "lng": -74.0060 },
  "neighborCount": 3,
  "routeCount": 5,
  "isHealthy": true
}
```

### POST /api/mesh/heal/:meterId
Manually trigger self-healing for a node.

**Response:**
```json
{
  "success": true,
  "message": "Healing triggered for node meter-001",
  "timestamp": 1234567890
}
```

### GET /api/mesh/routes/:meterId
Get routing table for a specific node.

**Response:**
```json
{
  "meterId": "meter-001",
  "routes": [
    {
      "destId": "meter-002",
      "nextHop": "meter-003",
      "hopCount": 2,
      "seqNum": 5,
      "expiresAt": 1234567890
    }
  ],
  "timestamp": 1234567890
}
```

## Usage Example

### Initialize Mesh Network

```typescript
import mqtt from 'mqtt';
import {
  MeshNode,
  NeighborDiscovery,
  RoutingProtocol,
  MessageForwarder,
  TopologyManager,
  HealthMonitor,
  NetworkHealer,
} from './iot/mesh';

// Connect to MQTT broker
const mqttClient = mqtt.connect('mqtt://localhost:1883');

// Create mesh node
const meshNode = new MeshNode('meter-001', {
  lat: 40.7128,
  lng: -74.0060,
});

// Initialize components
const neighborDiscovery = new NeighborDiscovery(meshNode, mqttClient);
const routingProtocol = new RoutingProtocol(meshNode, mqttClient);
const messageForwarder = new MessageForwarder(
  meshNode,
  mqttClient,
  routingProtocol
);
const topologyManager = new TopologyManager(meshNode, routingProtocol);
const healthMonitor = new HealthMonitor(meshNode, routingProtocol);
const networkHealer = new NetworkHealer(
  meshNode,
  routingProtocol,
  healthMonitor
);

// Start the mesh network
neighborDiscovery.start();
routingProtocol.start();
messageForwarder.start();
healthMonitor.start();
networkHealer.start();

// Send a message to another meter
await messageForwarder.sendMessage('meter-002', {
  type: 'energy-reading',
  value: 42.5,
  unit: 'kWh',
});

// Get topology snapshot
const topology = topologyManager.getTopology();
console.log('Network nodes:', topology.nodes.size);
console.log('Active routes:', topology.routes.size);

// Check health status
const health = healthMonitor.getHealthStatus();
console.log('Node health:', health.isHealthy);
console.log('Neighbors:', health.neighborCount);
```

## Performance Considerations

### Scalability

- **Small Networks (10-50 nodes)**: Excellent performance
- **Medium Networks (50-200 nodes)**: Good performance
- **Large Networks (200+ nodes)**: Consider network segmentation

### Bandwidth Usage

- **Beacon Traffic**: ~1KB every 30 seconds per node
- **Route Discovery**: ~2KB per RREQ/RREP exchange
- **Data Messages**: Variable (depends on application payload)

### Latency

- **1-hop**: < 100ms
- **2-hops**: 100-300ms
- **3-hops**: 300-500ms
- **4+ hops**: > 500ms (consider adding relay nodes)

## Deployment Considerations

### Network Prerequisites

- MQTT broker accessible to all meters
- Reliable network connectivity (WiFi, cellular, or LoRaWAN)
- Sufficient memory for routing tables (estimated 1MB per 100 routes)

### Security Recommendations

1. **MQTT TLS/SSL**: Enable encrypted MQTT connections
2. **Authentication**: Implement MQTT username/password or certificate auth
3. **Message Signing**: Add digital signatures to DATA messages
4. **Access Control**: Restrict topic subscriptions per node

### Remote Area Optimization

For remote or sparse deployments:
- Increase beacon interval to conserve power
- Deploy dedicated relay nodes in strategic locations
- Use longer route timeouts (10-15 minutes)
- Consider satellite or LoRaWAN backhaul

## Troubleshooting

### Node Cannot Discover Neighbors

**Symptoms**: ` neighborCount = 0` consistently

**Possible Causes**:
- MQTT broker connectivity issues
- Incorrect MQTT topic subscriptions
- Beacon interval too long
- Physical distance too great

**Solutions**:
- Verify MQTT broker is reachable
- Check topic subscription logs
- Reduce beacon interval temporarily
- Add relay nodes to extend coverage

### Routes Not Establishing

**Symptoms**: `routeCount = 0` or `findRoute()` returns null

**Possible Causes**:
- No route discovery initiated
- RREQ/RREP messages not propagating
- Network partitioned
- Routing table cleaned too aggressively

**Solutions**:
- Manually trigger route discovery
- Check RREQ/RREP message logs
- Verify network connectivity
- Increase route timeout duration

### Frequent Self-Healing Events

**Symptoms**: Constant route invalidation and rediscovery

**Possible Causes**:
- Unstable network connections
- Neighbor timeout too aggressive
- Hardware mobility (meters moving)
- Interference or signal degradation

**Solutions**:
- Increase neighbor timeout threshold
- Add more stable relay nodes
- Investigate RF interference sources
- Monitor RSSI values over time

## Performance Tuning

### For Low-Power Devices

```typescript
BEACON_INTERVAL_MS = 60000      // 1 minute (reduce radio usage)
NEIGHBOR_TIMEOUT_MS = 180000    // 3 minutes
HEALTH_CHECK_INTERVAL_MS = 120000  // 2 minutes
```

### For High-Reliability Networks

```typescript
BEACON_INTERVAL_MS = 15000      // 15 seconds (faster discovery)
NEIGHBOR_TIMEOUT_MS = 45000     // 45 seconds (quick failure detection)
ROUTE_TIMEOUT_MS = 600000       // 10 minutes (stable routes)
```

### For Dense Urban Deployments

```typescript
BEACON_INTERVAL_MS = 20000      // 20 seconds
WEAK_SIGNAL_THRESHOLD = -70     // Stricter signal quality
// Enable load balancing across multiple routes
```

## Testing

### Unit Tests

```bash
npm test -- mesh
```

### Integration Tests

```bash
npm test -- integration.test.ts
```

### Manual Testing Scenarios

1. **Mesh Formation**: Deploy 3+ nodes, verify neighbor discovery
2. **Route Discovery**: Send message between non-adjacent nodes
3. **Self-Healing**: Disconnect a node, verify automatic recovery
4. **Multi-Hop**: Send message through 3+ hops, verify delivery
5. **Network Partition**: Isolate part of network, verify reconnection

## Future Enhancements

- [ ] Load balancing across multiple routes
- [ ] Quality of Service (QoS) prioritization
- [ ] Geographic routing optimizations
- [ ] Energy-aware routing for battery-powered nodes
- [ ] Mesh network visualization dashboard
- [ ] Historical topology analysis
- [ ] Predictive failure detection with ML

## References

- AODV RFC 3561: https://www.ietf.org/rfc/rfc3561.txt
- MQTT Protocol: https://mqtt.org/
- Mesh Networking Best Practices: https://en.wikipedia.org/wiki/Wireless_mesh_network

## Support

For issues or questions:
- GitHub Issues: [Project Issues](https://github.com/your-org/stellar-solar-grid/issues)
- Technical Documentation: See `/docs` directory
- Community Forum: [Discussion Board](https://forum.stellar.org/)

---

**Version**: 1.0.0
**Last Updated**: 2026-10-22
**Maintainer**: Stellar Solar Grid Team
