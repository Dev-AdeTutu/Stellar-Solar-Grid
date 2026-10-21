import { Router } from "express";
import { z } from "zod";
import { generateComplianceReport, reportCsv, reportPdf, type ComplianceFramework } from "../lib/complianceReports.js";
import {
  isSandboxMode,
  generateSandboxComplianceReport,
  promoteFeature,
  listFeatureFlags,
  type SandboxFeature,
} from "../lib/sandbox.js";
export const complianceReportsRouter = Router();
const query = z.object({
  format: z.enum(["json", "csv", "pdf"]).default("json"),
  framework: z.enum(["GSE", "I-REC", "EU-RED", "FERC"]).default("GSE"),
  period: z.enum(["monthly", "quarterly"]).default("monthly"),
  sandbox: z
    .union([z.literal("true"), z.literal("false"), z.boolean()])
    .optional()
    .transform((v) => v === true || v === "true"),
});
const promotionBody = z.object({
  feature: z.string().min(1),
  approvedBy: z.string().min(1).optional(),
});
complianceReportsRouter.get("/compliance", async (req, res) => {
  const parsed = query.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const sandbox = parsed.data.sandbox || isSandboxMode();
  const report = sandbox
    ? await generateSandboxComplianceReport(parsed.data.framework as ComplianceFramework, parsed.data.period)
    : await generateComplianceReport(parsed.data.framework as ComplianceFramework, parsed.data.period);
  const suffix = sandbox ? "-sandbox" : "";
  if (parsed.data.format === "csv") {
    res
      .type("text/csv")
      .attachment(`compliance-${parsed.data.framework.toLowerCase()}${suffix}.csv`)
      .send(reportCsv(report));
  } else if (parsed.data.format === "pdf") {
    res
      .type("application/pdf")
      .attachment(`compliance-${parsed.data.framework.toLowerCase()}${suffix}.pdf`)
      .send(reportPdf(report));
  } else res.json(sandbox ? { sandbox: true, report } : report);
});
complianceReportsRouter.get("/compliance/schedules", (_req, res) =>
  res.json({
    schedules: [
      { frequency: "monthly", nextRun: "1st day of next month", framework: "GSE" },
      { frequency: "quarterly", nextRun: "1st day of next quarter", framework: "I-REC" },
    ],
    note: "Connect a scheduler to invoke the same signed report generator.",
  })
);
complianceReportsRouter.get("/compliance/sandbox/flags", (_req, res) => {
  res.json({ sandboxMode: isSandboxMode(), flags: listFeatureFlags() });
});
complianceReportsRouter.post("/compliance/sandbox/promote", async (req, res) => {
  const parsed = promotionBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const result = await promoteFeature(parsed.data.feature as SandboxFeature, parsed.data.approvedBy);
    res.json({ promoted: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Promotion failed";
    res.status(400).json({ error: message });
  }
});