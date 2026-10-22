import { describe, it, expect, beforeEach } from "vitest";
import {
  generateNetworkTopology,
  getHierarchyTree,
  getTopologyNode,
  resetTopologyStore,
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
});
