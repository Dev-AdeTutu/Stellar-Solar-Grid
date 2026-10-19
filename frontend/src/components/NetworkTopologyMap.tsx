"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";

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

const STATUS_COLORS: Record<NodeStatus, string> = {
  active: "#10b981",
  inactive: "#9ca3af",
  fault: "#ef4444",
};

const DEFAULT_FALLBACK_GRAPH: NetworkTopologyGraph = {
  nodes: [
    {
      id: "grid-main-1",
      label: "Primary Solar Grid Hub",
      type: "grid",
      status: "active",
      parentId: null,
      metadata: { capacityKw: 5000, currentLoadKw: 3120, voltage: 33000, location: "Central Substation A" },
    },
    {
      id: "tx-north-1",
      label: "North Sector Transformer T1",
      type: "transformer",
      status: "active",
      parentId: "grid-main-1",
      metadata: { capacityKw: 1500, currentLoadKw: 980, voltage: 11000, location: "North District" },
    },
    {
      id: "tx-south-1",
      label: "South Sector Transformer T2",
      type: "transformer",
      status: "active",
      parentId: "grid-main-1",
      metadata: { capacityKw: 1500, currentLoadKw: 1140, voltage: 11000, location: "South District" },
    },
    {
      id: "tx-east-1",
      label: "East Industrial Transformer T3",
      type: "transformer",
      status: "fault",
      parentId: "grid-main-1",
      metadata: { capacityKw: 2000, currentLoadKw: 1000, voltage: 11000, location: "East Industrial Zone" },
    },
    {
      id: "meter-101",
      label: "Meter #101 (Residential)",
      type: "meter",
      status: "active",
      parentId: "tx-north-1",
      metadata: { capacityKw: 15, currentLoadKw: 4.2, voltage: 240, location: "12 Solar Way" },
    },
    {
      id: "meter-102",
      label: "Meter #102 (Residential)",
      type: "meter",
      status: "active",
      parentId: "tx-north-1",
      metadata: { capacityKw: 15, currentLoadKw: 6.8, voltage: 240, location: "14 Solar Way" },
    },
    {
      id: "meter-103",
      label: "Meter #103 (Commercial)",
      type: "meter",
      status: "inactive",
      parentId: "tx-south-1",
      metadata: { capacityKw: 50, currentLoadKw: 0, voltage: 415, location: "88 Commerce Blvd" },
    },
    {
      id: "meter-104",
      label: "Meter #104 (Industrial)",
      type: "meter",
      status: "fault",
      parentId: "tx-east-1",
      metadata: { capacityKw: 120, currentLoadKw: 115, voltage: 415, location: "Sector 7 Factory" },
    },
  ],
  links: [
    { source: "grid-main-1", target: "tx-north-1", status: "active", loadPercentage: 65 },
    { source: "grid-main-1", target: "tx-south-1", status: "active", loadPercentage: 76 },
    { source: "grid-main-1", target: "tx-east-1", status: "fault", loadPercentage: 50 },
    { source: "tx-north-1", target: "meter-101", status: "active", loadPercentage: 28 },
    { source: "tx-north-1", target: "meter-102", status: "active", loadPercentage: 45 },
    { source: "tx-south-1", target: "meter-103", status: "inactive", loadPercentage: 0 },
    { source: "tx-east-1", target: "meter-104", status: "fault", loadPercentage: 96 },
  ],
  summary: {
    totalNodes: 8,
    grids: 1,
    transformers: 3,
    meters: 4,
    activeCount: 5,
    inactiveCount: 1,
    faultCount: 2,
  },
  generatedAt: new Date().toISOString(),
};

export const NetworkTopologyMap: React.FC = () => {
  const [graph, setGraph] = useState<NetworkTopologyGraph>(DEFAULT_FALLBACK_GRAPH);
  const [selectedNode, setSelectedNode] = useState<TopologyNode | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [scale, setScale] = useState<number>(1);
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const isDraggingRef = useRef(false);
  const lastMouseRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  useEffect(() => {
    const query = statusFilter !== "all" ? `?status=${statusFilter}` : "";
    fetch(`/api/network/topology${query}`)
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((data: NetworkTopologyGraph) => setGraph(data))
      .catch(() => {
        if (statusFilter === "all") {
          setGraph(DEFAULT_FALLBACK_GRAPH);
        } else {
          const filtered = DEFAULT_FALLBACK_GRAPH.nodes.filter((n) => n.status === statusFilter);
          setGraph({
            ...DEFAULT_FALLBACK_GRAPH,
            nodes: filtered,
            links: DEFAULT_FALLBACK_GRAPH.links.filter(
              (l) => filtered.some((n) => n.id === l.source) && filtered.some((n) => n.id === l.target)
            ),
          });
        }
      });
  }, [statusFilter]);

  // Compute hierarchical D3-style tree layout coordinates
  const positionedNodes = useMemo(() => {
    const grids = graph.nodes.filter((n) => n.type === "grid");
    const transformers = graph.nodes.filter((n) => n.type === "transformer");
    const meters = graph.nodes.filter((n) => n.type === "meter");

    const map = new Map<string, TopologyNode & { x: number; y: number }>();
    const width = 800;

    grids.forEach((n, idx) => {
      map.set(n.id, { ...n, x: ((idx + 1) * width) / (grids.length + 1), y: 80 });
    });
    transformers.forEach((n, idx) => {
      map.set(n.id, { ...n, x: ((idx + 1) * width) / (transformers.length + 1), y: 220 });
    });
    meters.forEach((n, idx) => {
      map.set(n.id, { ...n, x: ((idx + 1) * width) / (meters.length + 1), y: 380 });
    });

    return map;
  }, [graph]);

  const handleZoomIn = () => setScale((s) => Math.min(2.5, Number((s + 0.2).toFixed(2))));
  const handleZoomOut = () => setScale((s) => Math.max(0.4, Number((s - 0.2).toFixed(2))));
  const handleResetView = () => {
    setScale(1);
    setPan({ x: 0, y: 0 });
  };

  const handleMouseDown = (e: React.MouseEvent<SVGSVGElement>) => {
    isDraggingRef.current = true;
    lastMouseRef.current = { x: e.clientX, y: e.clientY };
  };

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!isDraggingRef.current) return;
    const dx = e.clientX - lastMouseRef.current.x;
    const dy = e.clientY - lastMouseRef.current.y;
    lastMouseRef.current = { x: e.clientX, y: e.clientY };
    setPan((prev) => ({ x: prev.x + dx, y: prev.y + dy }));
  };

  const handleMouseUp = () => {
    isDraggingRef.current = false;
  };

  return (
    <div className="p-6 bg-slate-900 text-white rounded-xl border border-slate-800 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold">Meter Network Topology</h2>
          <p className="text-sm text-slate-400">
            Interactive hierarchy: Grid &rarr; Transformer &rarr; Smart Meters
          </p>
        </div>

        <div className="flex items-center gap-2">
          <select
            aria-label="Filter by node status"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="bg-slate-800 border border-slate-700 rounded px-3 py-1.5 text-sm"
          >
            <option value="all">All Statuses</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
            <option value="fault">Fault</option>
          </select>

          <button
            type="button"
            onClick={handleZoomIn}
            className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 rounded text-sm"
            aria-label="Zoom In"
          >
            Zoom +
          </button>
          <button
            type="button"
            onClick={handleZoomOut}
            className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 rounded text-sm"
            aria-label="Zoom Out"
          >
            Zoom -
          </button>
          <button
            type="button"
            onClick={handleResetView}
            className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 rounded text-sm"
          >
            Reset View
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 bg-slate-950 rounded-lg border border-slate-800 overflow-hidden relative">
          <svg
            viewBox="0 0 800 480"
            className="w-full h-[460px] cursor-grab active:cursor-grabbing"
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
            data-testid="topology-svg"
          >
            <g transform={`translate(${pan.x}, ${pan.y}) scale(${scale})`}>
              {graph.links.map((link) => {
                const source = positionedNodes.get(link.source);
                const target = positionedNodes.get(link.target);
                if (!source || !target) return null;
                return (
                  <g key={`${link.source}-${link.target}`}>
                    <line
                      x1={source.x}
                      y1={source.y}
                      x2={target.x}
                      y2={target.y}
                      stroke={STATUS_COLORS[link.status]}
                      strokeWidth={2.5}
                      strokeDasharray={link.status === "inactive" ? "6,6" : undefined}
                    />
                    <text
                      x={(source.x + target.x) / 2}
                      y={(source.y + target.y) / 2 - 6}
                      fill="#94a3b8"
                      fontSize={10}
                      textAnchor="middle"
                    >
                      {link.loadPercentage}%
                    </text>
                  </g>
                );
              })}

              {Array.from(positionedNodes.values()).map((node) => (
                <g
                  key={node.id}
                  transform={`translate(${node.x}, ${node.y})`}
                  onClick={() => setSelectedNode(node)}
                  className="cursor-pointer"
                  data-testid={`topology-node-${node.id}`}
                >
                  <circle
                    r={node.type === "grid" ? 26 : node.type === "transformer" ? 20 : 15}
                    fill={STATUS_COLORS[node.status]}
                    stroke={selectedNode?.id === node.id ? "#ffffff" : "#1e293b"}
                    strokeWidth={3}
                  />
                  <text
                    y={node.type === "grid" ? 40 : 34}
                    fill="#e2e8f0"
                    fontSize={11}
                    textAnchor="middle"
                  >
                    {node.label}
                  </text>
                </g>
              ))}
            </g>
          </svg>
        </div>

        <div className="bg-slate-950 rounded-lg border border-slate-800 p-4 space-y-4">
          <h3 className="font-semibold text-base border-b border-slate-800 pb-2">
            Node Details
          </h3>
          {selectedNode ? (
            <div className="space-y-2 text-sm" data-testid="node-details-panel">
              <div>
                <span className="text-slate-400">ID:</span> {selectedNode.id}
              </div>
              <div>
                <span className="text-slate-400">Name:</span> {selectedNode.label}
              </div>
              <div>
                <span className="text-slate-400">Type:</span>{" "}
                <span className="uppercase">{selectedNode.type}</span>
              </div>
              <div>
                <span className="text-slate-400">Status:</span>{" "}
                <span
                  className="px-2 py-0.5 rounded text-xs font-semibold"
                  style={{ backgroundColor: STATUS_COLORS[selectedNode.status], color: "#0f172a" }}
                >
                  {selectedNode.status}
                </span>
              </div>
              {selectedNode.metadata.location && (
                <div>
                  <span className="text-slate-400">Location:</span> {selectedNode.metadata.location}
                </div>
              )}
              {selectedNode.metadata.voltage !== undefined && (
                <div>
                  <span className="text-slate-400">Voltage:</span> {selectedNode.metadata.voltage} V
                </div>
              )}
              {selectedNode.metadata.currentLoadKw !== undefined && (
                <div>
                  <span className="text-slate-400">Load:</span> {selectedNode.metadata.currentLoadKw} /{" "}
                  {selectedNode.metadata.capacityKw} kW
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm text-slate-400">
              Click any node in the topology diagram to inspect its real-time status and metrics.
            </p>
          )}
        </div>
      </div>
    </div>
  );
};

export default NetworkTopologyMap;
