import { describe, expect, it } from "vitest";

process.env.COMMUNITIES_DB_PATH = ":memory:";
process.env.BILLING_DB_PATH = ":memory:";
process.env.USAGE_EVENTS_DB_PATH = ":memory:";

const communities = await import("../src/lib/communities.js");
const billing = await import("../src/lib/billing.js");

describe("energy communities", () => {
  it("joins members, pools energy, allocates it with the member discount, and reports analytics", () => {
    const community = communities.createCommunity({
      name: "Northside Solar",
      description: "Shared neighborhood generation",
      ownerAddress: "GOWNER",
    });
    communities.joinCommunity(community.id, "GMEMBER");
    const discountProposal = communities.createDiscountProposal({
      communityId: community.id,
      proposerAddress: "GOWNER",
      title: "Set member discount",
      description: "",
      discountPercent: 10,
    });
    communities.castDiscountVote(community.id, discountProposal, "GOWNER", "yes");
    communities.castDiscountVote(community.id, discountProposal, "GMEMBER", "yes");
    communities.contributeEnergy(community.id, "GOWNER", 12);
    const allocation = communities.allocateEnergy(community.id, "GMEMBER", 4);
    const dashboard = communities.getCommunityDashboard(community.id, "GMEMBER");

    expect(allocation.discountPercent).toBe(10);
    expect(allocation.discountedKwh).toBeCloseTo(0.4);
    expect(dashboard?.memberCount).toBe(2);
    expect(dashboard?.pooledKwh).toBe(8);
    expect(dashboard?.contributedKwh).toBe(12);
    expect(dashboard?.allocatedKwh).toBe(4);
  });

  it("applies a proposed member discount only after a majority vote", () => {
    const community = communities.createCommunity({
      name: "River Co-op",
      description: "",
      ownerAddress: "GOWNER2",
    });
    communities.joinCommunity(community.id, "GMEMBER2");
    const proposalId = communities.createDiscountProposal({
      communityId: community.id,
      proposerAddress: "GOWNER2",
      title: "Raise member discount",
      description: "Apply a 15% community credit",
      discountPercent: 15,
    });

    communities.castDiscountVote(proposalId, "GOWNER2", "yes");
    expect(communities.getMemberDiscountPercent("GOWNER2")).toBe(0);
    const result = communities.castDiscountVote(proposalId, "GMEMBER2", "yes");

    expect(result.status).toBe("passed");
    expect(communities.getMemberDiscountPercent("GOWNER2")).toBe(15);
  });

  it("prevents non-members from voting and prevents pool overdrafts", () => {
    const community = communities.createCommunity({ name: "East Co-op", description: "", ownerAddress: "GOWNER3" });
    const proposalId = communities.createDiscountProposal({
      communityId: community.id,
      proposerAddress: "GOWNER3",
      title: "Change discount",
      description: "",
      discountPercent: 5,
    });
    expect(() => communities.castDiscountVote(community.id, proposalId, "GOUTSIDER", "yes")).toThrow(/Only members/);
    expect(() => communities.allocateEnergy(community.id, "GOWNER3", 1)).toThrow(/Insufficient energy/);
  });

  it("applies the largest active community discount to invoice energy charges before tax", () => {
    const community = communities.createCommunity({
      name: "Bill Credit Co-op",
      description: "",
      ownerAddress: "GBILLING",
    });
    const proposalId = communities.createDiscountProposal({
      communityId: community.id,
      proposerAddress: community.ownerAddress,
      title: "Approve bill discount",
      description: "",
      discountPercent: 20,
    });
    communities.castDiscountVote(community.id, proposalId, community.ownerAddress, "yes");
    const discount = communities.getMemberDiscountPercent(community.ownerAddress);
    const charges = billing.calculateCharges(
      { units: 100, cost: 800 },
      { unitPriceStroops: null, serviceChargeStroops: 100, taxRate: 0.1, dueDays: 14 },
      discount,
    );

    expect(discount).toBe(20);
    expect(charges.discountAmount).toBe(160);
    expect(charges.energyCharge).toBe(640);
    expect(charges.tax).toBe(74);
    expect(charges.total).toBe(814);
  });
});