import { Router, Request, Response } from "express";
import { requireAdminOrOps } from "../middleware/adminAuth.js";
import {
  generateNetworkTopology,
  getHierarchyTree,
  getTopologyNode,
  updateNodeParent,
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

networkTopologyRouter.patch("/topology/nodes/:id/parent", requireAdminOrOps, (req: Request, res: Response) => {
  const node = getTopologyNode(req.params.id);
  if (!node) {
    res.status(404).json({ error: "Topology node not found" });
    return;
  }
  const { parentId } = req.body ?? {};
  const parent = typeof parentId === "string" ? getTopologyNode(parentId) : undefined;
  if (node.type !== "meter" || !parent || parent.type !== "transformer") {
    res.status(400).json({ error: "A meter must be assigned to an existing transformer" });
    return;
  }
  const updated = updateNodeParent(node.id, parent.id);
  if (!updated) {
    res.status(400).json({ error: "Unable to reassign meter" });
    return;
  }
  res.json({ node: updated, graph: generateNetworkTopology() });
});
