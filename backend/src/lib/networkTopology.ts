export type NodeType = "grid" | "transformer" | "meter";
export type NodeStatus = "active" | "inactive" | "fault";

export interface TopologyNode {
  id: string;
  label: string;
  type: NodeType;
  status: NodeStatus;
  parentId: string | null;
  metadata: {
    capacityKw?: number;
    currentLoadKw?: number;
    voltage?: number;
    location?: string;
    owner?: string;
    lastHeartbeat?: string;
  };
}

export interface TopologyLink {
  source: string;
  target: string;
  status: NodeStatus;
  loadPercentage: number;
}

export interface NetworkTopologyGraph {
  nodes: TopologyNode[];
  links: TopologyLink[];
  summary: {
    totalNodes: number;
    grids: number;
    transformers: number;
    meters: number;
    activeCount: number;
    inactiveCount: number;
    faultCount: number;
  };
  generatedAt: string;
}

const topologyNodes = new Map<string, TopologyNode>();

function seedDefaultTopology(): void {
  if (topologyNodes.size > 0) return;

  const defaultNodes: TopologyNode[] = [
    {
      id: "grid-main-1",
      label: "Primary Solar Grid Hub",
      type: "grid",
      status: "active",
      parentId: null,
      metadata: {
        capacityKw: 5000,
        currentLoadKw: 3120,
        voltage: 33000,
        location: "Central Substation A",
      },
    },
    {
      id: "tx-north-1",
      label: "North Sector Transformer T1",
      type: "transformer",
      status: "active",
      parentId: "grid-main-1",
      metadata: {
        capacityKw: 1500,
        currentLoadKw: 980,
        voltage: 11000,
        location: "North District",
      },
    },
    {
      id: "tx-south-1",
      label: "South Sector Transformer T2",
      type: "transformer",
      status: "active",
      parentId: "grid-main-1",
      metadata: {
        capacityKw: 1500,
        currentLoadKw: 1140,
        voltage: 11000,
        location: "South District",
      },
    },
    {
      id: "tx-east-1",
      label: "East Industrial Transformer T3",
      type: "transformer",
      status: "fault",
      parentId: "grid-main-1",
      metadata: {
        capacityKw: 2000,
        currentLoadKw: 1000,
        voltage: 11000,
        location: "East Industrial Zone",
      },
    },
    {
      id: "meter-101",
      label: "Meter #101 (Residential)",
      type: "meter",
      status: "active",
      parentId: "tx-north-1",
      metadata: {
        capacityKw: 15,
        currentLoadKw: 4.2,
        voltage: 240,
        location: "12 Solar Way",
        owner: "GABC1234567890NORTH1",
        lastHeartbeat: new Date().toISOString(),
      },
    },
    {
      id: "meter-102",
      label: "Meter #102 (Residential)",
      type: "meter",
      status: "active",
      parentId: "tx-north-1",
      metadata: {
        capacityKw: 15,
        currentLoadKw: 6.8,
        voltage: 240,
        location: "14 Solar Way",
        owner: "GABC1234567890NORTH2",
        lastHeartbeat: new Date().toISOString(),
      },
    },
    {
      id: "meter-103",
      label: "Meter #103 (Commercial)",
      type: "meter",
      status: "inactive",
      parentId: "tx-south-1",
      metadata: {
        capacityKw: 50,
        currentLoadKw: 0,
        voltage: 415,
        location: "88 Commerce Blvd",
        owner: "GABC1234567890SOUTH1",
        lastHeartbeat: new Date(Date.now() - 86400000).toISOString(),
      },
    },
    {
      id: "meter-104",
      label: "Meter #104 (Industrial)",
      type: "meter",
      status: "fault",
      parentId: "tx-east-1",
      metadata: {
        capacityKw: 120,
        currentLoadKw: 115,
        voltage: 415,
        location: "Sector 7 Factory",
        owner: "GABC1234567890EAST1",
        lastHeartbeat: new Date(Date.now() - 3600000).toISOString(),
      },
    },
  ];

  for (const node of defaultNodes) {
    topologyNodes.set(node.id, node);
  }
}

export function resetTopologyStore(): void {
  topologyNodes.clear();
  seedDefaultTopology();
}

export function upsertTopologyNode(node: TopologyNode): TopologyNode {
  seedDefaultTopology();
  topologyNodes.set(node.id, node);
  return node;
}

export function getTopologyNode(id: string): TopologyNode | undefined {
  seedDefaultTopology();
  return topologyNodes.get(id);
}

export function updateNodeStatus(id: string, status: NodeStatus): TopologyNode | undefined {
  seedDefaultTopology();
  const existing = topologyNodes.get(id);
  if (!existing) return undefined;
  const updated: TopologyNode = { ...existing, status };
  topologyNodes.set(id, updated);
  return updated;
}

export function generateNetworkTopology(filterStatus?: NodeStatus): NetworkTopologyGraph {
  seedDefaultTopology();
  const allNodes = Array.from(topologyNodes.values());
  const nodes = filterStatus
    ? allNodes.filter((n) => n.status === filterStatus)
    : allNodes;

  const nodeIds = new Set(nodes.map((n) => n.id));
  const links: TopologyLink[] = [];

  for (const node of nodes) {
    if (node.parentId && nodeIds.has(node.parentId)) {
      const parent = topologyNodes.get(node.parentId);
      const linkStatus: NodeStatus =
        node.status === "fault" || parent?.status === "fault"
          ? "fault"
          : node.status === "inactive" || parent?.status === "inactive"
          ? "inactive"
          : "active";

      const capacity = node.metadata.capacityKw || 100;
      const load = node.metadata.currentLoadKw || 0;
      const loadPercentage = Math.min(100, Math.round((load / capacity) * 100));

      links.push({
        source: node.parentId,
        target: node.id,
        status: linkStatus,
        loadPercentage,
      });
    }
  }

  const summary = {
    totalNodes: nodes.length,
    grids: nodes.filter((n) => n.type === "grid").length,
    transformers: nodes.filter((n) => n.type === "transformer").length,
    meters: nodes.filter((n) => n.type === "meter").length,
    activeCount: nodes.filter((n) => n.status === "active").length,
    inactiveCount: nodes.filter((n) => n.status === "inactive").length,
    faultCount: nodes.filter((n) => n.status === "fault").length,
  };

  return {
    nodes,
    links,
    summary,
    generatedAt: new Date().toISOString(),
  };
}

export function getHierarchyTree(): Array<TopologyNode & { children: any[] }> {
  seedDefaultTopology();
  const nodes = Array.from(topologyNodes.values());
  const map = new Map<string, TopologyNode & { children: any[] }>();

  for (const n of nodes) {
    map.set(n.id, { ...n, children: [] });
  }

  const roots: Array<TopologyNode & { children: any[] }> = [];
  for (const n of map.values()) {
    if (n.parentId && map.has(n.parentId)) {
      map.get(n.parentId)!.children.push(n);
    } else {
      roots.push(n);
    }
  }

  return roots;
}
