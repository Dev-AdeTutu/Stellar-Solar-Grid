/**
 * #1155: the compliance report export must not carry customer email or national id.
 *
 * The issue describes a CSV with raw email and national id columns. The export has none: it is a
 * metric/value table of aggregates (customer count, energy, revenue) plus a signature. These tests
 * pin that, with meter records that do carry PII fields, so a future change that copies a customer
 * field into the report (or masks it badly) fails here.
 */
import * as StellarSdk from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

const EMAIL = "jane.doe@example.com";
const NATIONAL_ID = "NG-12345678901";
const PHONE = "+2348012345678";
const OWNER = StellarSdk.Keypair.random().publicKey();

const meters = [
  { owner: OWNER, units_used: 1500, email: EMAIL, national_id: NATIONAL_ID, nin: NATIONAL_ID, phone: PHONE, name: "Jane Doe" },
  { owner: OWNER, units_used: 500, email: EMAIL, national_id: NATIONAL_ID, phone: PHONE, name: "Jane Doe" },
];

// `src/lib/stellar.ts` imports a `quantumCrypto.js` that does not exist on upstream main, so it is
// replaced by a stub that returns the meters above.
vi.mock("../src/lib/stellar.js", () => ({
  stellarService: { query: vi.fn(async () => StellarSdk.nativeToScVal(meters)) },
}));

const { generateComplianceReport, reportCsv, reportPdf } = await import("../src/lib/complianceReports.js");

const PII = [EMAIL, "jane.doe", "example.com", NATIONAL_ID, "12345678901", PHONE, "Jane", "Doe"];

beforeEach(() => {
  delete process.env.ADMIN_ADDRESS;
  delete process.env.SANDBOX_MODE;
});

describe("compliance report", () => {
  it.each(["GSE", "I-REC", "EU-RED", "FERC"] as const)("%s report carries no customer PII, as JSON, CSV or PDF", async (framework) => {
    const report = await generateComplianceReport(framework, "monthly");

    const outputs = {
      json: JSON.stringify(report),
      csv: reportCsv(report),
      pdf: reportPdf(report).toString("latin1"),
    };
    for (const [format, text] of Object.entries(outputs)) {
      for (const secret of PII) expect(text, `${format} must not contain ${secret}`).not.toContain(secret);
    }
  });

  it("reports only aggregates: the counted customers are distinct owners, not their details", async () => {
    const report = await generateComplianceReport("GSE", "monthly");

    expect(report.customerCount).toBe(1);
    expect(report.energyDistributedMwh).toBe(2);
    expect(Object.keys(report).sort()).toEqual([
      "customerCount", "energyDistributedMwh", "framework", "generatedAt", "period",
      "revenueXlm", "sandbox", "signature", "signatureAlgorithm", "subsidiesXlm",
    ]);
  });

  it("the CSV is a metric,value table with no identity column", async () => {
    const csv = reportCsv(await generateComplianceReport("GSE", "monthly"));
    const [header, ...rows] = csv.split("\n");

    expect(header).toBe("metric,value");
    for (const row of rows) expect(row.split(",")).toHaveLength(2);
    expect(rows.map((r) => r.split(",")[0])).toEqual([
      "framework", "period_from", "period_to", "customer_count",
      "energy_distributed_mwh", "revenue_xlm", "subsidies_xlm", "sandbox", "signature",
    ]);
    expect(csv.toLowerCase()).not.toMatch(/email|national|nin|ssn|phone|name/);
  });

  it("does not even include the owner address of a counted customer", async () => {
    const report = await generateComplianceReport("GSE", "monthly");

    expect(reportCsv(report)).not.toContain(OWNER);
    expect(JSON.stringify(report)).not.toContain(OWNER);
  });

  it("the signature covers the aggregates and changes when they change", async () => {
    const first = await generateComplianceReport("GSE", "monthly");
    const { stellarService } = await import("../src/lib/stellar.js");
    vi.mocked(stellarService.query).mockResolvedValueOnce(StellarSdk.nativeToScVal([{ ...meters[0], units_used: 9_999_000 }]));
    const second = await generateComplianceReport("GSE", "monthly");

    expect(second.energyDistributedMwh).not.toBe(first.energyDistributedMwh);
    expect(second.signature).not.toBe(first.signature);
  });
});
