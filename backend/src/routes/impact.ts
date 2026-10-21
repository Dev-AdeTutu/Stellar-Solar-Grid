/**
 * Social impact measurement (#1054). See docs/IMPACT.md.
 *
 *   GET  /api/impact?projectId=        — totals, SDG alignment and SROI
 *   GET  /api/impact/report?projectId= — investor impact report
 *   PUT  /api/impact/projects/:id      — upsert project impact metrics
 *   GET  /api/impact/stories           — impact stories and testimonials
 *   POST /api/impact/stories           — add { projectId, author, quote }
 */
import { Router } from "express";
import { addStory, investorReport, listStories, sdgAlignment, sroi, totals, upsertRecord } from "../lib/impact.js";

export const impactRouter = Router();

const pid = (q: unknown) => (typeof q === "string" && q ? q : undefined);

impactRouter.get("/", (req, res) => {
  const projectId = pid(req.query.projectId);
  res.json({ totals: totals(projectId), sdgs: sdgAlignment(projectId), sroi: sroi(projectId) });
});

impactRouter.get("/report", (req, res) => res.json(investorReport(pid(req.query.projectId))));

impactRouter.put("/projects/:id", (req, res) => {
  const fields = ["householdsElectrified", "jobsCreated", "incomeBefore", "incomeAfter", "kwhDelivered", "investmentUsd"] as const;
  const body = req.body ?? {};
  const bad = fields.filter((f) => !(Number(body[f]) >= 0));
  if (bad.length) return res.status(400).json({ error: `non-negative numbers required: ${bad.join(", ")}` });
  const rec = Object.fromEntries(fields.map((f) => [f, Number(body[f])]));
  res.json(upsertRecord({ projectId: req.params.id, ...(rec as Record<(typeof fields)[number], number>) }));
});

impactRouter.get("/stories", (req, res) => res.json({ stories: listStories(pid(req.query.projectId)) }));

impactRouter.post("/stories", (req, res) => {
  const { projectId, author, quote } = req.body ?? {};
  if (![projectId, author, quote].every((v) => typeof v === "string" && v.trim())) {
    return res.status(400).json({ error: "projectId, author and quote are required" });
  }
  res.status(201).json(addStory(projectId, author, quote));
});
