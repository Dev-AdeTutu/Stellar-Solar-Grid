import { Router } from "express";
import { complianceReport, queryAudit, toCsv, toPdf, verifyAuditChain, type AuditFilter } from "../lib/auditTrail.js";

export const auditRouter = Router();

function parseFilter(q: Record<string, unknown>): AuditFilter {
  const str = (k: string) => (typeof q[k] === "string" && q[k] ? (q[k] as string) : undefined);
  const num = (k: string) => (str(k) ? Number(str(k)) : undefined);
  return {
    action: str("action"), actor: str("actor"), meterId: str("meterId"),
    from: str("from"), to: str("to"), limit: num("limit"), offset: num("offset"),
  };
}

/** GET /api/audit?action=&actor=&meterId=&from=&to=&limit=&offset= */
auditRouter.get("/", (req, res) => {
  res.json({ entries: queryAudit(parseFilter(req.query)) });
});

/** GET /api/audit/export?format=csv|pdf (same filters as above) */
auditRouter.get("/export", (req, res) => {
  const rows = queryAudit({ limit: 10_000, ...parseFilter(req.query) });
  if (req.query.format === "pdf") {
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="audit-trail.pdf"');
    return res.send(toPdf(rows));
  }
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", 'attachment; filename="audit-trail.csv"');
  res.send(toCsv(rows));
});

/** GET /api/audit/verify — recompute the hash chain to detect tampering. */
auditRouter.get("/verify", (_req, res) => {
  const result = verifyAuditChain();
  res.status(result.valid ? 200 : 409).json(result);
});

/** GET /api/audit/compliance?from=&to= */
auditRouter.get("/compliance", (req, res) => {
  const { from, to } = parseFilter(req.query);
  res.json(complianceReport(from, to));
});
