import { describe, it, expect, beforeEach } from "vitest";
import {
  generateNetworkTopology,
  getHierarchyTree,
  getTopologyNode,
  resetTopologyStore,
  updateNodeParent,
  updateNodeStatus,
  upsertTopologyNode,
} from "../src/lib/networkTopology.js";

describe("Network Topology Generation (#1006)", () => {
  beforeEach(() => {
    resetTopologyStore();
  });

  it("generates complete graph hierarchy (grid -> transformer -> meter)", () => {
    const graph = generateNetworkTopology();
    expect(graph.nodes.length).toBeGreaterThanOrEqual(8);
    expect(graph.links.length).toBeGreaterThanOrEqual(7);
    expect(graph.summary.grids).toBe(1);
    expect(graph.summary.transformers).toBe(3);
    expect(graph.summary.meters).toBe(4);
  });

  it("filters topology nodes by status", () => {
    const faultGraph = generateNetworkTopology("fault");
    expect(faultGraph.nodes.every((n) => n.status === "fault")).toBe(true);
    expect(faultGraph.summary.faultCount).toBe(faultGraph.nodes.length);
  });

  it("builds nested hierarchy tree rooted at grid nodes", () => {
    const tree = getHierarchyTree();
    expect(tree.length).toBe(1);
    expect(tree[0].type).toBe("grid");
    expect(tree[0].children.length).toBe(3);
    expect(tree[0].children[0].type).toBe("transformer");
  });

  it("supports adding new nodes and updating status", () => {
    upsertTopologyNode({
      id: "meter-999",
      label: "Test Meter #999",
      type: "meter",
      status: "active",
      parentId: "tx-north-1",
      metadata: { capacityKw: 20, currentLoadKw: 10, voltage: 240 },
    });

    const fetched = getTopologyNode("meter-999");
    expect(fetched?.label).toBe("Test Meter #999");

    const updated = updateNodeStatus("meter-999", "fault");
    expect(updated?.status).toBe("fault");
  });

  it("rebuilds meter edges and weights after feeder reassignment", () => {
    expect(generateNetworkTopology().links).toContainEqual(expect.objectContaining({
      source: "tx-north-1",
      target: "meter-101",
      loadPercentage: 28,
    }));

    expect(updateNodeParent("meter-101", "tx-south-1")?.parentId).toBe("tx-south-1");

    const reassignedGraph = generateNetworkTopology();
    expect(reassignedGraph.links).not.toContainEqual(expect.objectContaining({
      source: "tx-north-1",
      target: "meter-101",
    }));
    expect(reassignedGraph.links).toContainEqual(expect.objectContaining({
      source: "tx-south-1",
      target: "meter-101",
      loadPercentage: 28,
    }));
  });

  it("rejects reassignment to a missing or non-transformer parent", () => {
    expect(updateNodeParent("meter-101", "missing-feeder")).toBeUndefined();
    expect(updateNodeParent("meter-101", "grid-main-1")).toBeUndefined();
    expect(updateNodeParent("tx-north-1", "tx-south-1")).toBeUndefined();
  });
});
