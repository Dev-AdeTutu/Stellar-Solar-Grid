/**
 * Core types for IoT mesh networking.
 * Defines the data structures for mesh nodes, routing tables, and protocol messages.
 */

/**
 * Geographic position of a meter in the mesh network.
 */
export interface Position {
  lat: number;
  lng: number;
}

/**
 * Neighbor information tracked by each mesh node.
 */
export interface Neighbor {
  meterId: string;
  position: Position;
  lastSeen: number;
  rssi: number; // Received Signal Strength Indicator (dBm)
}

/**
 * Routing table entry for AODV-inspired routing protocol.
 */
export interface RouteEntry {
  nextHop: string;
  hopCount: number;
  seqNum: number;
  expiresAt: number;
}

/**
 * Message type discriminators for mesh protocol.
 */
export enum MeshMessageType {
  BEACON = 'BEACON',
  RREQ = 'RREQ',
  RREP = 'RREP',
  DATA = 'DATA',
}

/**
 * Base interface for all mesh messages.
 */
export interface BaseMeshMessage {
  type: MeshMessageType;
  timestamp: number;
}

/**
 * Beacon message for neighbor discovery.
 */
export interface BeaconMessage extends BaseMeshMessage {
  type: MeshMessageType.BEACON;
  meterId: string;
  position: Position;
}

/**
 * Route request message (RREQ) for route discovery.
 */
export interface RREQMessage extends BaseMeshMessage {
  type: MeshMessageType.RREQ;
  originId: string;
  destId: string;
  seqNum: number;
  hopCount: number;
}

/**
 * Route reply message (RREP) for route establishment.
 */
export interface RREPMessage extends BaseMeshMessage {
  type: MeshMessageType.RREP;
  originId: string;
  destId: string;
  hopCount: number;
  seqNum: number;
}

/**
 * Data message for application payloads.
 */
export interface DataMessage extends BaseMeshMessage {
  type: MeshMessageType.DATA;
  originId: string;
  destId: string;
  payload: unknown;
}

/**
 * Union type for all mesh messages.
 */
export type MeshMessage = BeaconMessage | RREQMessage | RREPMessage | DataMessage;

/**
 * Complete topology view of the mesh network.
 */
export interface MeshTopology {
  nodes: Map<string, Neighbor>;
  routes: Map<string, RouteEntry>;
  lastUpdate: number;
}
