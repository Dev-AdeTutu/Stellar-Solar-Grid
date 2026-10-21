import { Router, Request, Response } from "express";
import {
  generateNetworkTopology,
  getHierarchyTree,
  getTopologyNode,
  updateNodeStatus,
  upsertTopologyNode,
  NodeStatus,
  NodeType,
} from "../lib/networkTopology.js";

export const networkTopologyRouter = Router();

const VALID_STATUSES: NodeStatus[] = ["active", "inactive", "fault"];
const VALID_TYPES: NodeType[] = ["grid", "transformer", "meter"];

networkTopologyRouter.get("/topology", (req: Request, res: Response) => {
  const statusParam = req.query.status as string | undefined;
  if (statusParam && !VALID_STATUSES.includes(statusParam as NodeStatus)) {
    res.status(400).json({ error: "Invalid status filter. Must be active, inactive, or fault." });
    return;
  }

  const graph = generateNetworkTopology(statusParam as NodeStatus | undefined);
  res.json(graph);
});

networkTopologyRouter.get("/topology/hierarchy", (_req: Request, res: Response) => {
  const tree = getHierarchyTree();
  res.json({ hierarchy: tree });
});

networkTopologyRouter.get("/topology/nodes/:id", (req: Request, res: Response) => {
  const node = getTopologyNode(req.params.id);
  if (!node) {
    res.status(404).json({ error: "Topology node not found" });
    return;
  }
  res.json(node);
});

networkTopologyRouter.post("/topology/nodes", (req: Request, res: Response) => {
  const { id, label, type, status, parentId, metadata } = req.body ?? {};
  if (!id || !label || !VALID_TYPES.includes(type) || !VALID_STATUSES.includes(status)) {
    res.status(400).json({ error: "Invalid topology node payload" });
    return;
  }
  const node = upsertTopologyNode({
    id: String(id),
    label: String(label),
    type,
    status,
    parentId: parentId ? String(parentId) : null,
    metadata: metadata ?? {},
  });
  res.status(201).json(node);
});

networkTopologyRouter.patch("/topology/nodes/:id/status", (req: Request, res: Response) => {
  const { status } = req.body ?? {};
  if (!VALID_STATUSES.includes(status)) {
    res.status(400).json({ error: "Invalid status value" });
    return;
  }
  const updated = updateNodeStatus(req.params.id, status);
  if (!updated) {
    res.status(404).json({ error: "Topology node not found" });
    return;
  }
  res.json(updated);
});
